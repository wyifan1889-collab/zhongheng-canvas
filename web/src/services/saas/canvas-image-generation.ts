import localforage from "localforage";
import type { ImageTargetBinding } from "@/lib/canvas/platform-image-target";
import { GenerationError, sameGenerationScope, normalizeGenerationParameters, isGeminiGenerationParameters, sameGenerationParameters, type GenerationClient, type GenerationIntent, type GenerationParameters, type GenerationQuote, type GenerationScope, type GenerationTaskView } from "./generation";
import { invalidatePlatformWallet } from "./platform-wallet-refresh";

type GenerationRejection = "price_changed" | "insufficient_balance";
export type GenerationReceipt = Readonly<{ accountId: string; projectId: string; idempotencyKey: string; priceVersion: number; taskId?: string; rejection?: GenerationRejection;
    nodeId?: string; imageTarget?: ImageTargetBinding; application?: "pending" | "applied"; submittedAt?: string }>;
export type GenerationReceiptBacking = { keys(): Promise<string[]>; getItem(key: string): Promise<unknown>; setItem(key: string, value: GenerationReceipt): Promise<unknown>;
    updateItem?: (key: string, update: (previous: unknown) => GenerationReceipt) => Promise<GenerationReceipt> };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const storageError = () => new GenerationError("receipt_storage", "本机任务回执读写未完成，请保留当前窗口和回执，不要重复提交。", "not-sent");
const rejectionError = (code: GenerationRejection) => new GenerationError(code, code === "price_changed" ? "价格已变化，本次未创建任务，请重新获取并确认报价。" : "可用积分不足，本次未创建任务。", "rejected", code === "price_changed" ? 409 : 402);
const validNodeId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
const validSubmittedAt = (value: unknown): value is string => typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
const exactRecord = (value: unknown): value is Record<string, unknown> => record(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
export function parseImageTargetBinding(value: unknown): ImageTargetBinding {
    if (!exactRecord(value) || Reflect.ownKeys(value).length !== 4 || !["schemaVersion", "nodeId", "guardId", "sourceType"].every(key => Object.hasOwn(value, key)) ||
        value.schemaVersion !== 1 || !validNodeId(value.nodeId) || !uuid(value.guardId) || value.sourceType !== "image" && value.sourceType !== "config") throw storageError();
    return Object.freeze({ schemaVersion: 1, nodeId: value.nodeId, guardId: value.guardId, sourceType: value.sourceType });
}
export function sameImageTargetBinding(left: ImageTargetBinding | undefined, right: ImageTargetBinding | undefined) {
    return left === undefined || right === undefined ? left === right : left.schemaVersion === right.schemaVersion && left.nodeId === right.nodeId && left.guardId === right.guardId && left.sourceType === right.sourceType;
}
function receipt(value: unknown, stored = false): GenerationReceipt {
    if (record(value) && ["nodeId", "imageTarget", "application", "submittedAt"].some(key => Object.hasOwn(value, key)) && !exactRecord(value)) throw storageError();
    if (!record(value) || typeof value.accountId !== "string" || !value.accountId || typeof value.projectId !== "string" || !value.projectId ||
        typeof value.idempotencyKey !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,197}$/.test(value.idempotencyKey) ||
        !Number.isSafeInteger(value.priceVersion) || (value.priceVersion as number) <= 0 || (value.taskId !== undefined && !uuid(value.taskId)) ||
        (value.rejection !== undefined && ((value.rejection !== "price_changed" && value.rejection !== "insufficient_balance") || value.taskId !== undefined)) ||
        (Object.hasOwn(value, "nodeId") && !validNodeId(value.nodeId)) || (Object.hasOwn(value, "submittedAt") && !validSubmittedAt(value.submittedAt)) || Object.hasOwn(value, "application") &&
        (!uuid(value.taskId) || value.rejection !== undefined || value.application !== "pending" && value.application !== "applied") ||
        (stored && (!exactRecord(value) || Object.keys(value).some((field) => !["accountId", "projectId", "idempotencyKey", "priceVersion", "taskId", "rejection", "nodeId", "imageTarget", "application", "submittedAt"].includes(field))))) throw storageError();
    const imageTarget = Object.hasOwn(value, "imageTarget") ? parseImageTargetBinding(value.imageTarget) : undefined;
    if (imageTarget && value.nodeId !== imageTarget.nodeId) throw storageError();
    return Object.freeze({ accountId: value.accountId, projectId: value.projectId, idempotencyKey: value.idempotencyKey, priceVersion: value.priceVersion as number,
        ...(value.taskId ? { taskId: value.taskId as string } : {}), ...(value.rejection ? { rejection: value.rejection as GenerationRejection } : {}),
        ...(Object.hasOwn(value, "nodeId") ? { nodeId: value.nodeId as string } : {}), ...(imageTarget ? { imageTarget } : {}),
        ...(Object.hasOwn(value, "application") ? { application: value.application as "pending" | "applied" } : {}),
        ...(Object.hasOwn(value, "submittedAt") ? { submittedAt: value.submittedAt as string } : {}) });
}
const prefix = (accountId: string, projectId: string) => `${JSON.stringify([accountId, projectId])}:v1:`;
const receiptKey = (value: GenerationReceipt) => `${prefix(value.accountId, value.projectId)}${value.idempotencyKey}`;
const testWriteChains = new WeakMap<GenerationReceiptBacking, Promise<unknown>>();

/** Read/compare/write share one transaction, including independent connections and browser tabs. */
export function createImageReceiptAtomicUpdate(open: () => Promise<IDBDatabase>): NonNullable<GenerationReceiptBacking["updateItem"]> {
    return (key, update) => open().then(db => new Promise<GenerationReceipt>((resolve, reject) => {
        let result: GenerationReceipt, failure: unknown, tx: IDBTransaction;
        try { tx = db.transaction("receipts", "readwrite"); } catch { db.close(); reject(storageError()); return; }
        db.onversionchange = () => db.close();
        tx.oncomplete = () => { db.close(); resolve(result); };
        tx.onabort = () => { db.close(); reject(failure ?? storageError()); };
        tx.onerror = () => { failure ??= storageError(); };
        const store = tx.objectStore("receipts"), request = store.get(key);
        request.onsuccess = () => {
            try { result = receipt(update(request.result ?? null), true); store.put(result, key); }
            catch (error) { failure = error; tx.abort(); }
        };
    }));
}
function mergeReceipt(previous: unknown, next: GenerationReceipt) {
    if (previous === null) { if (next.application) throw storageError(); return next; }
    const old = receipt(previous, true);
    if (receiptKey(old) !== receiptKey(next) || old.priceVersion !== next.priceVersion || old.nodeId !== next.nodeId || old.submittedAt !== undefined && next.submittedAt !== undefined && old.submittedAt !== next.submittedAt || !sameImageTargetBinding(old.imageTarget, next.imageTarget) ||
        old.taskId && next.taskId && old.taskId !== next.taskId || old.taskId && next.rejection || old.rejection && (next.rejection !== old.rejection || next.taskId) ||
        next.application && next.application !== old.application) throw storageError();
    return receipt({ ...next, ...(old.taskId ? { taskId: old.taskId } : {}), ...(old.application ? { application: old.application } : {}), ...(old.submittedAt ? { submittedAt: old.submittedAt } : {}) }, true);
}

/** One minimal recovery hint per intent; no prompt, image, credential, or automatic resubmission. */
export function createGenerationReceiptStore(backing?: GenerationReceiptBacking, namespace = "infinite-canvas-generation-receipts") {
    let storage = backing;
    function database(): GenerationReceiptBacking {
        if (!storage) {
            const db = localforage.createInstance({ name: namespace, storeName: "receipts", driver: [localforage.INDEXEDDB] });
            const updateItem = createImageReceiptAtomicUpdate(async () => {
                await db.ready();
                return new Promise<IDBDatabase>((resolve, reject) => {
                    let failed = false;
                    const request = indexedDB.open(namespace);
                    request.onerror = request.onblocked = () => { failed = true; reject(storageError()); };
                    request.onsuccess = () => { if (failed) request.result.close(); else resolve(request.result); };
                });
            });
            storage = { keys: () => db.keys(), getItem: (key) => db.getItem(key), setItem: (key, value) => db.setItem(key, value), updateItem };
        }
        return storage;
    }
    function update(key: string, transform: (previous: unknown) => GenerationReceipt) {
        const db = database();
        if (db.updateItem) return db.updateItem(key, transform);
        // Injected test stores only; production never falls back from native atomic writes.
        const next = (testWriteChains.get(db) ?? Promise.resolve()).catch(() => undefined).then(async () => {
            const value = receipt(transform(await db.getItem(key)), true); await db.setItem(key, value); return value;
        });
        testWriteChains.set(db, next.catch(() => undefined)); return next;
    }
    function applicationReference(value: GenerationReceipt, previous: unknown) {
        const current = receipt(previous, true);
        if (!value.taskId || value.rejection || !current.taskId || current.rejection || receiptKey(current) !== receiptKey(value) ||
            current.priceVersion !== value.priceVersion || current.taskId !== value.taskId || current.nodeId !== value.nodeId || !sameImageTargetBinding(current.imageTarget, value.imageTarget)) throw storageError();
        return current;
    }
    return Object.freeze({
        async put(value: GenerationReceipt): Promise<void> {
            try {
                const next = receipt(value); await update(receiptKey(next), previous => mergeReceipt(previous, next));
            } catch { throw storageError(); }
        },
        async claimImageApplication(value: GenerationReceipt): Promise<"claimed" | "pending" | "applied"> {
            try {
                const reference = receipt(value, true); let result: "claimed" | "pending" | "applied" = "pending";
                await update(receiptKey(reference), previous => {
                    const current = applicationReference(reference, previous); result = current.application ?? "claimed";
                    return current.application ? current : receipt({ ...current, application: "pending" }, true);
                });
                return result;
            } catch { throw storageError(); }
        },
        async completeImageApplication(value: GenerationReceipt): Promise<void> {
            try {
                const reference = receipt(value, true);
                await update(receiptKey(reference), previous => {
                    const current = applicationReference(reference, previous); if (!current.application) throw storageError();
                    return receipt({ ...current, application: "applied" }, true);
                });
            } catch { throw storageError(); }
        },
        async list(accountId: string, projectId: string): Promise<GenerationReceipt[]> {
            try {
                const db = database(), keys = await db.keys(), result: GenerationReceipt[] = [];
                for (const key of keys.filter((item) => item.startsWith(prefix(accountId, projectId)))) {
                    const value = receipt(await db.getItem(key), true);
                    if (receiptKey(value) !== key) throw storageError();
                    result.push(value);
                }
                return result;
            } catch { throw storageError(); }
        },
    });
}
export type GenerationReceiptStore = ReturnType<typeof createGenerationReceiptStore>;
export type CanvasImageGenerationState = Readonly<{
    phase: "idle" | "preparing" | "ready" | "submitting" | "uncertain" | "tracking" | "rejected" | "failed" | "closed";
    busy: boolean;
    intentInvalidated: boolean;
    quote: GenerationQuote | null;
    view: GenerationTaskView | null;
    receipt: GenerationReceipt | null;
    error: GenerationError | null;
}>;

/** Owns a single confirmation and its read-only recovery; never owns canvas nodes or media URLs. */
export function createCanvasImageGenerationController(options: {
    client: GenerationClient;
    getContext: () => GenerationScope | null;
    receiptStore?: Pick<GenerationReceiptStore, "put" | "list">;
    createIdempotencyKey?: () => string;
    imageTarget?: ImageTargetBinding;
    readOnly?: boolean;
    beforeImageReceipt?: (target: ImageTargetBinding, nodeId: string) => Promise<void>;
    getIntentCurrent?: () => boolean;
}) {
    const initial = options.getContext(), scope = initial ? Object.freeze({ ...initial }) : null;
    const target = options.imageTarget === undefined ? undefined : parseImageTargetBinding(options.imageTarget);
    const receipts = options.receiptStore ?? createGenerationReceiptStore(), listeners = new Set<() => void>();
    let active = true, attempted = false, submittedOrRestored = false, intentInvalidated = false, quoteSequence = 0, intent: GenerationIntent | null = null;
    let state: CanvasImageGenerationState = Object.freeze({ phase: "idle", busy: false, intentInvalidated: false, quote: null, view: null, receipt: null, error: null });
    function isCurrent() { return active && !!scope && sameGenerationScope(options.getContext(), scope); }
    function set(patch: Partial<CanvasImageGenerationState>) {
        state = Object.freeze({ ...state, ...patch });
        // An observer cannot change whether a submitted request is recorded or reconciled.
        for (const listener of listeners) { try { listener(); } catch { /* React owns observer errors. */ } }
    }
    function close() { if (active) { active = false; intent = null; set({ phase: "closed", busy: false, quote: null, view: null, error: null }); listeners.clear(); } }
    function check() {
        if (!isCurrent()) { close(); throw new GenerationError("context_changed", "当前窗口、账号或画布已变化，请重新打开原画布核对。", attempted ? "unknown" : "not-sent"); }
    }
    const intentError = () => new GenerationError("intent_changed", "原图片入口或引用已变化，未发送新生成请求。请重新打开原入口确认。", "not-sent");
    function invalidateIntent() {
        if (!active || !options.getIntentCurrent || submittedOrRestored || intentInvalidated) return;
        intentInvalidated = true; intent = null; quoteSequence++;
        set({ phase: "failed", busy: false, intentInvalidated: true, quote: null, error: intentError() });
    }
    function invalidateQuote() {
        if (!active || submittedOrRestored || attempted || state.receipt || intentInvalidated) return;
        intent = null; quoteSequence++;
        set({ phase: "idle", busy: false, quote: null, error: null });
    }
    function checkIntent() {
        let current = !intentInvalidated;
        try { if (current && options.getIntentCurrent) current = options.getIntentCurrent() === true; } catch { current = false; }
        if (!current) { invalidateIntent(); throw intentError(); }
    }
    function failure(error: unknown, uncertain: boolean) {
        if (!isCurrent()) { close(); return state; }
        const safe = error instanceof GenerationError ? error : new GenerationError("unconfirmed", "操作结果尚未确认，请保留回执并主动核对。", uncertain ? "unknown" : "not-sent");
        set({ phase: uncertain ? "uncertain" : "failed", busy: false, error: safe });
        return state;
    }
    function checkView(view: GenerationTaskView, reference: GenerationReceipt) {
        if (view.task.projectId !== reference.projectId || view.task.priceVersion !== reference.priceVersion || (reference.taskId && reference.taskId !== view.task.id) ||
            reference.nodeId !== undefined && view.task.nodeId !== reference.nodeId) {
            throw new GenerationError("unconfirmed", "任务与本机回执不一致，请保留回执联系管理员核对。", "unknown");
        }
    }
    async function accept(view: GenerationTaskView, reference: GenerationReceipt) {
        check();
        checkView(view, reference);
        invalidatePlatformWallet(scope!);
        const next = receipt({ ...reference, taskId: view.task.id });
        // This write always targets the captured original partition, including if the view closes while IDB commits.
        await receipts.put(next);
        check();
        const stored = (await receipts.list(next.accountId, next.projectId)).find(item => item.idempotencyKey === next.idempotencyKey);
        check();
        if (!stored || stored.taskId !== next.taskId || stored.priceVersion !== next.priceVersion || stored.nodeId !== next.nodeId || !sameImageTargetBinding(stored.imageTarget, next.imageTarget)) throw storageError();
        set({ phase: "tracking", busy: false, view, receipt: stored, error: null });
        return state;
    }
    async function refresh() {
        if (state.busy || !state.receipt || state.receipt.rejection) return state;
        try {
            check();
            const reference = state.receipt;
            set({ busy: true, error: null });
            const view = reference.taskId ? await options.client.get(reference.taskId) : await options.client.getByKey(reference.idempotencyKey);
            check();
            return await accept(view, reference);
        } catch (error) { return failure(error, true); }
    }
    return Object.freeze({
        getState: () => state,
        isCurrent,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        close,
        invalidateIntent,
        invalidateQuote,
        startNew() {
            if (options.readOnly) return false;
            if (!isCurrent()) { close(); return false; }
            if (intentInvalidated || state.busy || state.phase !== "rejected" || !state.receipt?.rejection) return false;
            attempted = false; submittedOrRestored = false; intent = null; quoteSequence++;
            set({ phase: "idle", quote: null, view: null, receipt: null, error: null });
            return true;
        },
        async prepare(value: { modelId: string; prompt: string; parameters?: GenerationParameters; nodeId?: string }) {
            if (options.readOnly || state.busy || attempted || state.receipt) return state;
            const sequence = ++quoteSequence;
            try {
                check();
                checkIntent();
                if (target && value.nodeId !== target.nodeId) throw new GenerationError("invalid_target", "原图片目标与请求节点不一致，未查看费用。", "not-sent");
                const next: GenerationIntent = Object.freeze({ modelId: value.modelId, input: Object.freeze({ prompt: value.prompt }),
                    parameters: Object.freeze(normalizeGenerationParameters(value.parameters ?? {})), projectId: scope!.projectId,
                    ...(value.nodeId === undefined ? {} : { nodeId: value.nodeId }) });
                intent = null;
                set({ phase: "preparing", busy: true, quote: null, view: null, error: null });
                const quote = await options.client.quote(next);
                check();
                if (sequence !== quoteSequence) return state;
                checkIntent();
                const hasSpec = Object.keys(next.parameters).length > 0;
                if (quote.modelId !== next.modelId || (isGeminiGenerationParameters(next.parameters) ? quote.billingUnit !== "image" ||
                    !sameGenerationParameters(quote.parameters, next.parameters) || quote.quotedUnits !== next.parameters.budgetCredits || !/^[0-9a-f]{64}$/.test(quote.quoteFingerprint)
                    : hasSpec ? !quote.imageSpec || !sameGenerationParameters(quote.imageSpec.parameters, next.parameters) ||
                    !/^[0-9a-f]{64}$/.test(quote.quoteFingerprint ?? "") : quote.imageSpec !== undefined || quote.quoteFingerprint !== undefined)) throw new GenerationError("unconfirmed", "报价与本次完整图片意图不一致，请重新核对。", "not-sent");
                intent = next;
                set({ phase: "ready", busy: false, quote: quote.billingUnit === "image" ? Object.freeze({ ...quote, parameters: Object.freeze({ ...quote.parameters }) }) : Object.freeze({ ...quote, ...(quote.imageSpec ? {
                    imageSpec: Object.freeze({ ...quote.imageSpec, parameters: Object.freeze({ ...quote.imageSpec.parameters }) }) } : {}) }) });
                return state;
            } catch (error) { if (sequence !== quoteSequence && isCurrent()) return state; return failure(error, false); }
        },
        async confirm() {
            if (state.busy || attempted || state.phase !== "ready" || !intent || !state.quote) return state;
            let sent = false, reference: GenerationReceipt | undefined;
            try {
                check();
                checkIntent();
                attempted = true;
                const fixedIntent = intent, quote = state.quote;
                reference = receipt({ accountId: scope!.accountId, projectId: scope!.projectId, idempotencyKey: (options.createIdempotencyKey ?? (() => crypto.randomUUID()))(), priceVersion: quote.priceVersion,
                    ...(fixedIntent.nodeId === undefined ? {} : { nodeId: fixedIntent.nodeId }), ...(target ? { imageTarget: target } : {}), ...(target || fixedIntent.nodeId ? { submittedAt: new Date().toISOString() } : {}) });
                set({ phase: "submitting", busy: true, receipt: reference, error: null });
                if (target) {
                    if (!options.beforeImageReceipt) throw new GenerationError("image_target_unready", "原图片目标保护尚未就绪，未发送生成请求。", "not-sent");
                    await options.beforeImageReceipt(target, fixedIntent.nodeId!); check(); checkIntent();
                }
                await receipts.put(reference);
                check();
                checkIntent();
                sent = true;
                submittedOrRestored = true;
                const view = await options.client.submit(fixedIntent, quote.priceVersion, reference.idempotencyKey, quote.quoteFingerprint);
                check();
                if (view.task.modelId !== quote.modelId || view.task.quotedUnits !== quote.quotedUnits || quote.imageSpec &&
                    (view.task.imageSpecSnapshot?.status !== "recorded" || view.task.imageSpecSnapshot.maxImagesPerRequest !== quote.imageSpec.maxImagesPerRequest ||
                        !sameGenerationParameters(view.task.imageSpecSnapshot.parameters, quote.imageSpec.parameters)) || quote.billingUnit === "image" &&
                    (!view.task.geminiImage || view.task.geminiImage.creditsPerImage !== quote.creditsPerUnit || !sameGenerationParameters(view.task.geminiImage.parameters, quote.parameters))) throw new GenerationError("unconfirmed", "任务报价与确认内容不一致，请保留回执核对。", "unknown");
                return await accept(view, reference);
            } catch (error) {
                const rejected = error instanceof GenerationError && error.outcome === "rejected";
                // Only these complete POST responses prove this new intent was not accepted.
                if (sent && reference && isCurrent() && rejected && ((error.code === "price_changed" && error.status === 409) || (error.code === "insufficient_balance" && error.status === 402))) {
                    try {
                        const next = receipt({ ...reference, rejection: error.code as GenerationRejection });
                        await receipts.put(next);
                        check();
                        set({ phase: "rejected", busy: false, quote: null, view: null, receipt: next, error: rejectionError(next.rejection!) });
                        return state;
                    } catch {
                        return failure(new GenerationError("receipt_storage", "未受理结果未能保存，请保留回执并核对，不要重复提交。", "unknown"), true);
                    }
                }
                return failure(error, sent && !rejected);
            } finally { intent = null; }
        },
        async listReceipts(): Promise<GenerationReceipt[]> {
            check();
            const result = await receipts.list(scope!.accountId, scope!.projectId);
            check();
            return result;
        },
        async restoreReceipt(value: GenerationReceipt) {
            if (state.busy || attempted || state.receipt) return state;
            try {
                check();
                const reference = receipt(value);
                if (reference.accountId !== scope!.accountId || reference.projectId !== scope!.projectId) throw new GenerationError("context_changed", "此回执属于其他账号或画布。", "not-sent");
                if (target && !sameImageTargetBinding(target, reference.imageTarget)) throw new GenerationError("invalid_target", "此回执与原图片任务目标不一致。", "not-sent");
                attempted = true;
                submittedOrRestored = true;
                intent = null;
                set({ phase: "uncertain", busy: true, receipt: reference, quote: null, view: null, error: null });
                const stored = (await receipts.list(scope!.accountId, scope!.projectId)).find((item) => item.idempotencyKey === reference.idempotencyKey);
                check();
                if (!stored || stored.priceVersion !== reference.priceVersion || (reference.taskId && reference.taskId !== stored.taskId) || stored.nodeId !== reference.nodeId || !sameImageTargetBinding(stored.imageTarget, reference.imageTarget)) throw storageError();
                if (stored.rejection) {
                    set({ phase: "rejected", busy: false, receipt: stored, error: rejectionError(stored.rejection) });
                    return state;
                }
                set({ busy: false, receipt: stored });
                return await refresh();
            } catch (error) { return failure(error, !!state.receipt); }
        },
        refresh,
    });
}

export { receipt as parseGenerationReceipt };
