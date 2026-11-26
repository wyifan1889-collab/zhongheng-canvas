import { createStore } from "zustand/vanilla";
import { isImageConversationPath } from "@/lib/creation-routes";
import { useAccountStore } from "./use-account-store";
import { createGenerationTrackingClient, GenerationTrackingError, type GenerationTrackingItem, type GenerationTrackingScope } from "../services/saas/generation";

type Status = Pick<GenerationTrackingItem, "executionStatus" | "deliveryStatus" | "billingStatus">;
export const isGenerationOriginRoute = (route: string) => isImageConversationPath(route) ||
    (route === "/image" || route === "/audio" || route === "/video" || /^\/canvas\/[^/?#]+$/.test(route))
    && new URL(route, "https://canvas.invalid").pathname === route;
export type GenerationTrackerRegistration = GenerationTrackingScope & Status & {
    taskId: string; projectId: string | null; nodeId?: string | null; modelId: string;
    originRoute: string; kindHint: "text" | "image" | "audio" | "video";
};
export type GenerationTrackerEntry = Readonly<GenerationTrackerRegistration & {
    updatedAt?: string; polling: boolean; readStatus: "ready" | "unconfirmed" | "missing" | "account-stopped";
}>;
export type GenerationTrackerNotice = GenerationTrackingScope & {
    key: string; taskId: string; originRoute: string; kindHint: "text" | "image" | "audio" | "video";
    title: string; description: string; level: "info" | "success" | "warning" | "error";
    isCurrent: () => boolean;
};
type NoticeSink = { notify: (notice: GenerationTrackerNotice) => void; dismiss: (key: string) => void };
type TrackerState = {
    entries: Readonly<Record<string, GenerationTrackerEntry>>; running: boolean;
    notices: Readonly<Record<string, GenerationTrackerNotice & { read: boolean }>>;
    markNoticesRead: (keys: readonly string[]) => void;
    register: (value: GenerationTrackerRegistration) => void;
    reconcileAudioReceipt: (value: GenerationTrackerRegistration) => boolean;
    reconcileVideoReceipt: (value: GenerationTrackerRegistration) => boolean;
    untrack: (accountId: string, taskId: string) => void;
    start: (sink: NoticeSink) => () => void;
    syncAccount: () => void;
    stop: () => void;
};
const sameScope = (a: GenerationTrackingScope | null, b: GenerationTrackingScope | null) => a === null || b === null
    ? a === b : a.accountId === b.accountId && a.epoch === b.epoch;
const entryKey = (accountId: string, taskId: string) => JSON.stringify([accountId, taskId.toLowerCase()]);
const signature = (value: Status) => JSON.stringify([value.executionStatus, value.deliveryStatus, value.billingStatus]);
export const isGenerationTrackingUncertain = (value: Status) => value.executionStatus === "unknown" || value.executionStatus === "timeout"
    || value.deliveryStatus === "unknown" || value.billingStatus === "pending_review" || value.executionStatus === "succeeded" && value.deliveryStatus === "failed";
const shouldPoll = (value: Status, kind: GenerationTrackerRegistration["kindHint"]) => !generationTrackingPresentation(value).terminal
    && !((kind === "audio" || kind === "video") && isGenerationTrackingUncertain(value));

/** Record status only: this never verifies result content or changes the server task. */
export function generationTrackingPresentation(value: Status): { terminal: boolean; title: string; description: string; level: GenerationTrackerNotice["level"] } {
    const { executionStatus: execution, deliveryStatus: delivery, billingStatus: billing } = value;
    const review = { terminal: false, title: "任务状态待核对", description: "结果/交付/费用待核对，请返回原画布查看回执。", level: "warning" as const };
    if (isGenerationTrackingUncertain(value)) return review;
    if (execution === "succeeded" && (delivery === "saved" || delivery === "visible")) {
        if (billing === "captured") return { terminal: true, title: "任务处理完成", description: "任务处理完成，查看回执。", level: "success" };
        if (billing === "reserved" || billing === "unbilled") return { terminal: false, title: "生成记录已完成", description: "生成记录已完成，费用处理中，查看回执。", level: "info" };
        return review;
    }
    if ((execution === "failed" || execution === "cancelled") && delivery === "failed" && (billing === "released" || billing === "unbilled")) {
        return { terminal: true, title: execution === "failed" ? "生成失败" : "生成已取消",
            description: billing === "unbilled" ? "任务未计费，请查看原回执。" : "任务冻结积分已释放，请查看原回执。", level: execution === "failed" ? "error" : "info" };
    }
    if (execution === "pending" || execution === "queued" || execution === "running" || execution === "succeeded" && delivery === "pending") {
        return { terminal: false, title: execution === "succeeded" ? "交付处理中" : "生成处理中", description: "任务仍在处理中，请查看原回执。", level: "info" };
    }
    return review;
}

/** One tab-memory queue. Only the global lifecycle owns timers and its notification keys. */
export function createGenerationTracker(options: {
    getScope?: () => GenerationTrackingScope | null;
    clientFactory?: (scope: GenerationTrackingScope) => Pick<ReturnType<typeof createGenerationTrackingClient>, "read">;
    now?: () => number;
    setTimer?: (callback: () => void, delay: number) => unknown;
    clearTimer?: (handle: unknown) => void;
} = {}) {
    const getScope = options.getScope ?? (() => useAccountStore.getState().getDraftScope()), now = options.now ?? Date.now;
    const setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    const clearTimer = options.clearTimer ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const clientFactory = options.clientFactory ?? (scope => createGenerationTrackingClient({ scope, getScope }));
    let scope: GenerationTrackingScope | null = null, blockedScope: GenerationTrackingScope | null = null;
    let sink: NoticeSink | null = null, timer: unknown, timerSet = false, revision = 0, lifecycle = 0, nextReadAt = 0;
    let client: ReturnType<typeof clientFactory> | null = null;
    let inFlight: { abort: AbortController; revision: number; taskKeys: Set<string> } | null = null;
    const identities = new Map<string, object>(), announced = new Map<string, string>(), notificationKeys = new Set<string>();
    let queue: string[] = [], remaining: string[] = [];
    const store = createStore<TrackerState>(() => ({ entries: {}, notices: {}, markNoticesRead, running: false, register, reconcileAudioReceipt, reconcileVideoReceipt, untrack, start, syncAccount, stop }));
    function markNoticesRead(keys: readonly string[]) {
        if (!current()) return;
        store.setState(state => {
            const notices = { ...state.notices };
            for (const key of keys) if (notices[key]?.isCurrent()) notices[key] = { ...notices[key], read: true };
            return { notices };
        });
    }
    function removeNotice(key: string) {
        store.setState(state => { const notices = { ...state.notices }; delete notices[key]; return { notices }; });
    }
    function clearScheduled() { if (timerSet) clearTimer(timer); timerSet = false; timer = undefined; }
    function clearNotices() {
        for (const key of notificationKeys) { try { sink?.dismiss(key); } catch { /* Notification cleanup cannot retain ownership. */ } }
        notificationKeys.clear();
        store.setState({ notices: {} });
    }
    function current(run = revision) { return !!sink && run === revision && !!scope && !sameScope(scope, blockedScope) && sameScope(scope, getScope()); }
    function syncAccount() {
        const next = getScope();
        if (sameScope(scope, next)) return;
        ++revision; clearScheduled(); inFlight?.abort.abort(); clearNotices();
        scope = next ? Object.freeze({ ...next }) : null; blockedScope = null; client = null; nextReadAt = 0;
        queue = []; remaining = []; identities.clear(); announced.clear(); store.setState({ entries: {} });
        schedule();
    }
    function emit(key: string, mark: string, presentation: ReturnType<typeof generationTrackingPresentation>) {
        const entry = store.getState().entries[key], identity = identities.get(key), run = revision;
        if (!entry || !identity || !current(run) || announced.get(key) === mark) return;
        const isCurrent = () => current(run) && identities.get(key) === identity && !!store.getState().entries[key];
        if (!isCurrent()) return;
        const notificationKey = `platform-generation:${key}`;
        const notice: GenerationTrackerNotice = { key: notificationKey, accountId: entry.accountId, epoch: entry.epoch,
            taskId: entry.taskId, originRoute: entry.originRoute, kindHint: entry.kindHint,
            title: `${{ text: "平台文本", image: "平台图片", audio: "平台音频", video: "平台视频" }[entry.kindHint]}：${presentation.title}`,
            description: (entry.kindHint === "audio" || entry.kindHint === "video") && isGenerationTrackingUncertain(entry)
                ? `结果/交付/费用待核对，已暂停自动查询，请返回${entry.kindHint === "video" ? "视频" : "音频"}工作台主动核对原回执。` : presentation.description,
            level: presentation.level, isCurrent };
        announced.set(key, mark); notificationKeys.add(notificationKey);
        store.setState(state => ({ notices: { ...state.notices, [notificationKey]: { ...notice, read: false } } }));
        try { if (isCurrent()) sink?.notify(notice); } catch { /* A UI observer cannot change task status or trigger a retry. */ }
    }
    function register(value: GenerationTrackerRegistration) {
        syncAccount();
        if (!scope || sameScope(scope, blockedScope) || !sameScope(scope, value) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.taskId)) return;
        // Only original platform entry points supply a source, never an API result or URL query.
        if (!isGenerationOriginRoute(value.originRoute)) return;
        const taskId = value.taskId.toLowerCase(), key = entryKey(value.accountId, taskId);
        if (store.getState().entries[key]) return;
        const entry = Object.freeze({ accountId: value.accountId, epoch: value.epoch, taskId, projectId: value.projectId,
            ...(value.nodeId === undefined ? {} : { nodeId: value.nodeId }), modelId: value.modelId, originRoute: value.originRoute, kindHint: value.kindHint,
            executionStatus: value.executionStatus, deliveryStatus: value.deliveryStatus, billingStatus: value.billingStatus,
            polling: shouldPoll(value, value.kindHint), readStatus: "ready" as const });
        identities.set(key, {}); announced.set(key, `status:${signature(entry)}`); queue.push(key); remaining.push(key);
        store.setState(state => ({ entries: { ...state.entries, [key]: entry } })); schedule();
    }
    function reconcileAudioReceipt(value: GenerationTrackerRegistration) {
        return reconcileMediaReceipt(value, "audio");
    }
    function reconcileVideoReceipt(value: GenerationTrackerRegistration) {
        return reconcileMediaReceipt(value, "video");
    }
    function reconcileMediaReceipt(value: GenerationTrackerRegistration, kind: "audio" | "video") {
        syncAccount();
        if (!scope || sameScope(scope, blockedScope) || !sameScope(scope, value) || value.kindHint !== kind || value.originRoute !== `/${kind}`) return false;
        const key = entryKey(value.accountId, value.taskId), entry = store.getState().entries[key];
        if (!entry || entry.kindHint !== kind || entry.originRoute !== `/${kind}` || !sameScope(entry, value)
            || entry.modelId !== value.modelId || entry.projectId !== value.projectId || entry.nodeId !== value.nodeId) return false;
        const polling = shouldPoll(value, kind), mark = `status:${signature(value)}`;
        const unchanged = signature(entry) === signature(value) && entry.readStatus === "ready" && entry.polling === polling;
        if (unchanged && !inFlight?.taskKeys.has(key)) return true;
        // A saved, manually verified receipt supersedes an older in-flight batch.
        // Keep the original source and one entry; only this item's generation changes.
        identities.set(key, {}); announced.set(key, mark);
        const notificationKey = `platform-generation:${key}`;
        removeNotice(notificationKey);
        if (notificationKeys.delete(notificationKey)) { try { sink?.dismiss(notificationKey); } catch { /* Own key only. */ } }
        if (unchanged) return true;
        update(key, { executionStatus: value.executionStatus, deliveryStatus: value.deliveryStatus, billingStatus: value.billingStatus,
            updatedAt: undefined, polling, readStatus: "ready" });
        clearScheduled(); schedule();
        return true;
    }
    function untrack(accountId: string, taskId: string) {
        const key = entryKey(accountId, taskId), notificationKey = `platform-generation:${key}`;
        removeNotice(notificationKey);
        identities.delete(key); announced.delete(key); queue = queue.filter(item => item !== key); remaining = remaining.filter(item => item !== key);
        const entries = { ...store.getState().entries }; delete entries[key]; store.setState({ entries });
        if (notificationKeys.delete(notificationKey)) { try { sink?.dismiss(notificationKey); } catch { /* Own key only. */ } }
        clearScheduled();
        schedule();
    }
    function start(next: NoticeSink) {
        if (sink) stop();
        const ownership = ++lifecycle;
        sink = next; ++revision; store.setState({ running: true }); syncAccount(); schedule();
        return () => { if (lifecycle === ownership) stop(); };
    }
    function stop() {
        ++revision; ++lifecycle; clearScheduled(); inFlight?.abort.abort(); clearNotices(); sink = null; client = null;
        store.setState({ running: false });
    }
    function schedule() {
        if (!current() || inFlight || timerSet || !queue.some(key => store.getState().entries[key]?.polling)) return;
        // Browser timers clamp larger delays; keep the same server deadline across timer-sized waits.
        timerSet = true; timer = setTimer(() => {
            timerSet = false; timer = undefined;
            if (now() < nextReadAt) schedule();
            else void readNext();
        }, Math.min(0x7fffffff, Math.max(0, nextReadAt - now())));
    }
    async function readNext() {
        syncAccount();
        if (!current() || inFlight || !scope) return;
        if (now() < nextReadAt) { schedule(); return; }
        remaining = remaining.filter(key => store.getState().entries[key]?.polling);
        if (!remaining.length) remaining = queue.filter(key => store.getState().entries[key]?.polling);
        const selected = remaining.splice(0, 50);
        if (!selected.length) return;
        const batch = selected.map(key => ({ key, identity: identities.get(key), entry: store.getState().entries[key] }));
        const operation = { abort: new AbortController(), revision, taskKeys: new Set(selected) }, capturedScope = scope;
        inFlight = operation; let delay = 2500;
        const owns = (item: typeof batch[number]) => current(operation.revision) && identities.get(item.key) === item.identity && !!store.getState().entries[item.key];
        try {
            client ??= clientFactory(capturedScope);
            const response = await client.read(batch.map(item => item.entry.taskId), operation.abort.signal);
            if (!current(operation.revision) || operation.abort.signal.aborted) return;
            for (const item of batch) {
                if (!owns(item)) continue;
                const value = response.items.find(value => value.taskId === item.entry.taskId);
                if (response.missingTaskIds.includes(item.entry.taskId)) {
                    update(item.key, { polling: false, readStatus: "missing" });
                    emit(item.key, "read:missing", { terminal: false, title: "任务读取待核对", description: "暂未查到任务记录，已暂停自动读取，请保留并主动核对原回执。", level: "warning" });
                } else if (!value || value.projectId !== item.entry.projectId || value.modelId !== item.entry.modelId || item.entry.nodeId !== undefined && value.nodeId !== item.entry.nodeId) {
                    update(item.key, { readStatus: "unconfirmed" });
                    emit(item.key, "read:unconfirmed", { terminal: false, title: "任务读取待核对", description: "读取待核对，请保留并主动核对原回执。", level: "warning" });
                } else {
                    const presentation = generationTrackingPresentation(value);
                    update(item.key, { executionStatus: value.executionStatus, deliveryStatus: value.deliveryStatus, billingStatus: value.billingStatus,
                        updatedAt: value.updatedAt, polling: shouldPoll(value, item.entry.kindHint), readStatus: "ready" });
                    emit(item.key, `status:${signature(value)}`, presentation);
                }
            }
        } catch (error) {
            if (!current(operation.revision) || operation.abort.signal.aborted) return;
            if (error instanceof GenerationTrackingError && (error.status === 401 || ["account_changed", "account_context_required", "context_changed", "unauthorized"].includes(error.code))) {
                blockedScope = capturedScope; ++revision; clearScheduled(); clearNotices(); client = null;
                for (const key of Object.keys(store.getState().entries)) update(key, { polling: false, readStatus: "account-stopped" });
            } else {
                if (error instanceof GenerationTrackingError && error.status === 429 && error.retryAfterMs !== undefined) delay = Math.max(delay, error.retryAfterMs);
                for (const item of batch) if (owns(item)) {
                    update(item.key, { readStatus: "unconfirmed" });
                    emit(item.key, "read:unconfirmed", { terminal: false, title: "任务读取待核对", description: "读取待核对，请保留并主动核对原回执。", level: "warning" });
                }
            }
        } finally {
            if (inFlight === operation) inFlight = null;
            nextReadAt = Math.max(nextReadAt, now() + delay);
            syncAccount(); schedule();
        }
    }
    function update(key: string, patch: Partial<GenerationTrackerEntry>) {
        const previous = store.getState().entries[key];
        if (previous) store.setState(state => ({ entries: { ...state.entries, [key]: Object.freeze({ ...previous, ...patch }) } }));
    }
    return store;
}

export const generationTracker = createGenerationTracker();
