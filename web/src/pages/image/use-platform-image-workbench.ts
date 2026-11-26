import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAccountStore } from "@/stores/use-account-store";
import { generationTracker } from "@/stores/use-generation-tracker";
import { createMediaClient } from "@/services/api/media";
import { insertGeneratedImage, type CanvasGeneratedImage } from "@/services/saas/canvas-generated-image";
import type { CanvasImageGenerationState, GenerationReceipt } from "@/services/saas/canvas-image-generation";
import { GenerationError, type GenerationScope, type GenerationTaskView } from "@/services/saas/generation";
import { createMappedImageGenerationClient } from "@/services/saas/mapped-image-generation";
import { selectedImageMapping, workbenchImageMappings, type WorkbenchImageModel } from "./mapped-image-settings";
import { createWorkbenchImageSession, IMAGE_WORKBENCH_PROJECT_ID, type PlatformImageInput, type WorkbenchImageSession } from "./platform-image-workbench";
import { imageConversationPath } from "@/lib/creation-routes";
import { imageRoundStorage, imageWorkbenchReceipts as receiptStore, notifyImageConversationsChanged, type ImageRoundDetails } from "./image-conversations";

type RoundOwner = {
    key: string; details: ImageRoundDetails; owner: WorkbenchImageSession;
    attemptedImage?: boolean; imageOperation?: AbortController; imageError?: string; lastTrackingRead?: string;
};
export type PlatformImageRound = ImageRoundDetails & {
    key: string; state: CanvasImageGenerationState; imageBusy: boolean; imageError?: string;
};
const intentKey = (input: PlatformImageInput) => JSON.stringify([input.prompt.trim(), input.modelId, input.count, input.parameters]);

export function usePlatformImageWorkbench(options: {
    enabled: boolean; scope: { accountId: string; epoch: number }; input: PlatformImageInput; conversationId: string;
    onImage: (image: CanvasGeneratedImage, view: GenerationTaskView, prompt: string, isCurrent: () => boolean, signal: AbortSignal) => Promise<void>;
}) {
    const props = useRef(options);
    props.current = options;
    const runtime = useRef<{ initialize: () => Promise<void>; send: (expectedCredits: number) => Promise<boolean>;
        restore: (receipt: GenerationReceipt) => Promise<string | undefined>; openConversation: () => void;
        refresh: (key: string, trackerSignature?: string) => void; loadImage: (key: string) => void } | null>(null);
    const [rounds, setRounds] = useState<PlatformImageRound[]>([]);
    const [mappingModels, setMappingModels] = useState<WorkbenchImageModel[]>([]);
    const [receipts, setReceipts] = useState<GenerationReceipt[]>([]);
    const [receiptsReady, setReceiptsReady] = useState(false);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [initializationError, setInitializationError] = useState("");
    const tracked = useSyncExternalStore(generationTracker.subscribe, generationTracker.getState);

    useEffect(() => {
        if (!options.enabled) return;
        let live = true, sending = false, initializing = false, ready = false;
        const scope = { ...options.scope, projectId: IMAGE_WORKBENCH_PROJECT_ID };
        const context = (): GenerationScope | null => {
            const account = useAccountStore.getState(), current = account.getDraftScope();
            return live && props.current.enabled && account.site?.cloudMedia && current?.accountId === scope.accountId && current.epoch === scope.epoch ? scope : null;
        };
        const client = createMappedImageGenerationClient({ scope, getScope: context });
        const metadata = imageRoundStorage(scope);
        const owners = new Map<string, RoundOwner>();
        const prior = new Map<string, { reference: GenerationReceipt; details: ImageRoundDetails }>();
        let catalog: WorkbenchImageModel[] = [];
        const legacyRound = (reference: GenerationReceipt): ImageRoundDetails => ({ conversationId: props.current.conversationId, prompt: "", model: "", count: "",
            startedAt: reference.submittedAt ? Date.parse(reference.submittedAt) : 0 });
        const publish = () => {
            if (!context()) return;
            setRounds([...owners.values()].sort((a, b) => a.details.startedAt - b.details.startedAt).map(round => ({
                ...round.details, key: round.key, state: round.owner.getState(), imageBusy: !!round.imageOperation, imageError: round.imageError,
            })));
        };
        const loadImage = async (round: RoundOwner) => {
            const view = round.owner.getState().view;
            if (!context() || !view || round.imageOperation) return;
            round.attemptedImage = true;
            const operation = new AbortController();
            round.imageOperation = operation;
            round.imageError = undefined;
            publish();
            const isCurrent = () => round.owner.isCurrent() && !operation.signal.aborted;
            try {
                await insertGeneratedImage({ view, signal: operation.signal, isCurrent,
                    media: createMediaClient(() => isCurrent() ? scope.accountId : null),
                    commit: async image => {
                        if (!isCurrent()) return false;
                        await props.current.onImage(image, view, round.details.prompt, isCurrent, operation.signal);
                        return false;
                    } });
            } catch (cause) {
                round.imageError = cause instanceof Error ? cause.message : "图片读取失败，请核对原任务。";
            } finally {
                round.imageOperation = undefined;
                publish();
            }
        };
        const makeRound = (key: string, details: ImageRoundDetails) => {
            const owner = createWorkbenchImageSession({ scope, getContext: context, client, receipts: receiptStore, idempotencyKey: key,
                originRoute: details.prompt ? imageConversationPath(details.conversationId) : "/image",
                getInput: () => props.current.conversationId === details.conversationId ? props.current.input : { ...props.current.input, settingsReviewed: false } });
            const round: RoundOwner = { key, details, owner };
            owners.set(key, round);
            owner.subscribe(() => {
                publish();
                const state = owner.getState(), view = state.view;
                const saved = prior.get(key);
                if (saved && state.receipt?.taskId && saved.reference.taskId !== state.receipt.taskId) {
                    saved.reference = state.receipt;
                    notifyImageConversationsChanged();
                }
                if (!round.attemptedImage && view?.task.executionStatus === "succeeded" && ["saved", "visible"].includes(view.task.deliveryStatus) && view.result?.status === "succeeded") void loadImage(round);
            });
            return round;
        };
        const restore = async (reference: GenerationReceipt, details?: ImageRoundDetails) => {
            if (!context()) return;
            const existing = owners.get(reference.idempotencyKey);
            if (existing) { await existing.owner.refresh(); return; }
            const saved = details ?? await metadata.getItem<ImageRoundDetails>(reference.idempotencyKey);
            if (!context() || owners.has(reference.idempotencyKey)) return;
            const round = makeRound(reference.idempotencyKey, saved?.conversationId ? saved : legacyRound(reference));
            await round.owner.restoreReceipt(reference);
        };
        const openConversation = () => {
            for (const { reference, details } of prior.values()) {
                if (details.conversationId === props.current.conversationId && !owners.has(reference.idempotencyKey)) void restore(reference, details);
            }
        };
        const initialize = async () => {
            if (!live || initializing || sending) return;
            initializing = true;
            ready = false;
            setLoading(true); setError(""); setReceiptsReady(false);
            try {
                if (!context()) throw new Error("平台图片服务尚未就绪，请确认登录及云素材服务。");
                const [models, stored] = await Promise.all([client.mappedModels(), receiptStore.list(scope.accountId, scope.projectId)]);
                const storedRounds = await Promise.all(stored.map(async reference => ({ reference, details: await metadata.getItem<ImageRoundDetails>(reference.idempotencyKey) })));
                if (!context()) return;
                catalog = workbenchImageMappings(models);
                setMappingModels(catalog); setReceipts(stored); setReceiptsReady(true); setInitializationError("");
                ready = true;
                prior.clear();
                for (const { reference, details } of storedRounds) if (details?.conversationId) prior.set(reference.idempotencyKey, { reference, details });
                openConversation();
            } catch (cause) {
                if (live) setInitializationError(cause instanceof Error ? cause.message : "平台图片服务读取失败。");
            } finally {
                initializing = false;
                if (live) setLoading(false);
            }
        };
        runtime.current = {
            initialize,
            openConversation,
            restore: async (reference) => {
                try {
                    const saved = prior.get(reference.idempotencyKey)?.details;
                    await restore(reference, saved);
                    return context() ? saved?.conversationId : undefined;
                }
                catch (cause) { if (context()) setError(cause instanceof Error ? cause.message : "任务回执读取失败。"); }
            },
            refresh: (key, trackerSignature) => {
                const round = owners.get(key);
                if (!round || trackerSignature && round.lastTrackingRead === trackerSignature) return;
                round.lastTrackingRead = trackerSignature;
                void round.owner.refresh();
            },
            loadImage: key => { const round = owners.get(key); if (round) void loadImage(round); },
            async send(expectedCredits) {
                if (!context() || !ready || sending) return false;
                const conversationId = props.current.conversationId;
                const input = props.current.input, intent = intentKey(input);
                const mapping = catalog.find(model => model.id === input.mappingModelId);
                const choice = selectedImageMapping(catalog, { mappingModelId: input.mappingModelId, mappingSpecification: input.mappingSpecification,
                    imageModel: input.modelId, ...input.parameters });
                if (!choice?.available || !mapping || !input.prompt.trim()) return false;
                if ([...prior.values()].some(({ reference, details }) => !owners.has(reference.idempotencyKey) && !reference.rejection && !reference.taskId && details.intent === intent)
                    || [...owners.values()].some(round => {
                    const state = round.owner.getState(), execution = state.view?.task.executionStatus;
                    return round.details.intent === intent && !!state.receipt && !state.receipt.rejection
                        && (!execution || ["pending", "queued", "running", "unknown", "timeout"].includes(execution) || state.phase === "uncertain");
                })) {
                    setError("同样的请求已有任务，请先查看那一轮的结果。");
                    return false;
                }
                sending = true;
                setBusy(true); setError("");
                const key = crypto.randomUUID();
                const round = makeRound(key, { conversationId, prompt: input.prompt.trim(), model: mapping.displayName, count: input.count, startedAt: Date.now(), intent });
                let metadataStored = false;
                try {
                    const state = await round.owner.prepare(input, client.executableModels());
                    if (!round.owner.isCurrent()) return false;
                    if (state.phase !== "ready" || !state.quote) throw state.error ?? new Error("输入已变化，请核对后重新发送。");
                    if (state.quote.quotedUnits !== expectedCredits) throw new GenerationError("catalog_changed", "价格已变化，请更新模型列表后重新发送。", "not-sent");
                    await metadata.setItem(key, round.details);
                    metadataStored = true;
                    if (!round.owner.isCurrent()) return false;
                    if (props.current.conversationId !== conversationId) throw new Error("当前对话已变化，原请求未发送。");
                    const submitted = await round.owner.confirm();
                    if (!round.owner.isCurrent()) return false;
                    if (submitted.receipt) {
                        prior.set(key, { reference: submitted.receipt, details: round.details });
                        notifyImageConversationsChanged();
                        void round.owner.listReceipts().then(items => { if (context()) setReceipts(items); }).catch(() => {
                            if (context()) setError("本机回执列表读取失败，请重新读取。");
                        });
                    }
                    return !!submitted.receipt && (submitted.phase === "tracking" || submitted.phase === "uncertain");
                } catch (cause) {
                    if (context()) setError(cause instanceof Error ? cause.message : "本次发送未完成。");
                    return false;
                } finally {
                    if (!round.owner.getState().receipt) {
                        owners.delete(key); round.owner.close();
                        if (metadataStored) void metadata.removeItem(key).catch(() => undefined);
                    }
                    sending = false;
                    if (context()) { setBusy(false); publish(); }
                }
            },
        };
        void initialize();
        return () => {
            live = false;
            runtime.current = null;
            for (const round of owners.values()) { round.imageOperation?.abort(); round.owner.close(); }
        };
    }, [options.enabled, options.scope.accountId, options.scope.epoch]);

    useEffect(() => { runtime.current?.openConversation(); }, [options.conversationId]);

    useEffect(() => {
        const refresh = runtime.current?.refresh;
        if (!refresh) return;
        for (const round of rounds) {
            const task = round.state.view?.task;
            if (!task || round.state.busy || round.state.phase !== "tracking") continue;
            const entry = Object.values(tracked.entries).find(item => item.taskId === task.id && item.accountId === options.scope.accountId && item.epoch === options.scope.epoch);
            if (entry?.readStatus === "ready" && (entry.executionStatus !== task.executionStatus || entry.deliveryStatus !== task.deliveryStatus || entry.billingStatus !== task.billingStatus))
                refresh(round.key, JSON.stringify([entry.executionStatus, entry.deliveryStatus, entry.billingStatus]));
        }
    }, [tracked, rounds, options.scope.accountId, options.scope.epoch]);

    return { rounds: rounds.filter(round => round.conversationId === options.conversationId), mappingModels, receipts, receiptsReady, loading, busy, error, initializationError,
        send: (credits: number) => runtime.current?.send(credits),
        retryInitialization: () => runtime.current?.initialize(),
        restore: async (reference: GenerationReceipt) => await runtime.current?.restore(reference),
        refresh: (key: string) => runtime.current?.refresh(key),
        loadImage: (key: string) => runtime.current?.loadImage(key) };
}
