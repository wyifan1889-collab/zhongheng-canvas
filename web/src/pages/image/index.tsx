import { ArrowLeft, ArrowRight, ArrowUp, BookOpen, CheckSquare, ClipboardPaste, Download, FolderPlus, History, LoaderCircle, PenLine, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Alert, App, Button, Checkbox, Drawer, Empty, Image, Input, Modal, Spin, Tag, Tooltip, Typography } from "@/components/creation/ui";
import localforage from "localforage";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { createHistoryImageRecovery, readImageRecoveryIntent, type ImageRecoveryState } from "./history-image-recovery";

import { ImageSettingsPanel } from "@/components/image-settings-panel";
import { reindexCreationReferences } from "@/components/creation/creation-reference-prompt";
import { CreationHint, CreationParameters, CreationToolbar, CreationToolsMenu, CreationWorkbench } from "@/components/creation/creation-workbench";
import { WorkspaceFeedback, WorkspaceHeading, workspaceAction } from "@/components/creation/workspace-feedback";
import { Button as WorkspaceButton } from "@/components/ui/button";
import { firstPlatformDefault } from "@/components/creation/creation-platform-default";
import { initialMappedImageParameters, mappedImageReferencePrice, selectedImageMapping } from "./mapped-image-settings";
import { imageMappingAspectRatio } from "@/services/saas/mapped-image-generation";
import { PlatformImageModelPicker, PlatformImageSettings } from "./platform-image-controls";
import { useCreationShortcutTarget } from "@/components/creation/creation-shortcut-target-context";
import { ModelPicker } from "@/components/model-picker";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { AssetPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { canvasThemes } from "@/lib/canvas-theme";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { defaultConfig, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { nanoid } from "nanoid";
import { formatBytes, formatDuration } from "@/lib/image-utils";
import { requestEdit, requestGeneration } from "@/services/api/image";
import { deleteStoredImages, ensureImagePreview, getImagePreviewRevision, previewUrlFor, resolveImageUrl, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { useAssetStore } from "@/stores/use-asset-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";
import type { ReferenceImage } from "@/types/image";
import i18n from "@/i18n";
import { accountScopedStoreName } from "@/services/saas/account-local-scope";
import { useAccountStore } from "@/stores/use-account-store";
import { personalMediaParameters, imageMediaParameters, useCreationMediaLaunch, type CreationMediaDraft, type CreationMediaLaunch, type CreationMediaScope, type PersonalMediaParameters } from "@/stores/use-creation-media-launch";
import { usePlatformImageWorkbench, type PlatformImageRound } from "./use-platform-image-workbench";
import { ImageSpecHistory } from "@/components/canvas/canvas-platform-image-modal";
import type { GenerationParameters } from "@/services/saas/generation";
import { CREATION_DRAFT_REFERENCE_LIMIT, creationReferenceSendIssue } from "@/lib/creation-reference-limits";
import { imageConversationPath, isCreationMediaTarget, validImageConversationId } from "@/lib/creation-routes";

type GeneratedImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    durationMs: number;
    width: number;
    height: number;
    bytes: number;
    mimeType?: string;
};

type GenerationResult = {
    id: string;
    status: "pending" | "success" | "failed";
    image?: GeneratedImage;
    error?: string;
};

type GenerationLog = {
    id: string;
    createdAt: number;
    title: string;
    prompt: string;
    time: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    imageCount: number;
    size: string;
    quality: string;
    status: "success" | "failed";
    images: GeneratedImage[];
};

type GenerationLogConfig = Pick<AiConfig, "model" | "imageModel" | "quality" | "size" | "count">;

type UpdateAiConfig = <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;

const RESULT_ACTION_BUTTON_CLASS = "min-w-0 px-1.5 [&_.ant-btn-icon]:shrink-0 [&>span:last-child]:min-w-0 [&>span:last-child]:truncate";
const logStores = new Map<string, ReturnType<typeof localforage.createInstance>>();
const logStore = (scope?: CreationMediaScope) => {
    const name = accountScopedStoreName("image_generation_logs", scope);
    const cached = logStores.get(name);
    if (cached) return cached;
    const created = localforage.createInstance({ name: "infinite-canvas", storeName: name });
    logStores.set(name, created);
    return created;
};

export default function ImagePage({ modeTabs }: { modeTabs?: ReactNode } = {}) {
    const location = useLocation();
    const recovery = readImageRecoveryIntent(location.state);
    const account = useAccountStore(), scope = account.getDraftScope();
    if (scope && account.user && recovery) return <HistoryImageRecovery key={`${scope.accountId}:${scope.epoch}:${location.key}:${recovery.taskId}`} scope={scope} intent={recovery} />;
    return scope ? account.user ? <ImageWorkbench key={`${scope.accountId}:${scope.epoch}`} scope={scope} modeTabs={modeTabs} />
        : <PersonalImageWorkbench key={`${scope.accountId}:${scope.epoch}`} scope={scope} modeTabs={modeTabs} /> : <Empty description="请登录后使用图片生成" />;
}

function HistoryImageRecovery({ scope, intent }: { scope: CreationMediaScope; intent: NonNullable<ReturnType<typeof readImageRecoveryIntent>> }) {
    const navigate = useNavigate(), location = useLocation();
    const [state, setState] = useState<ImageRecoveryState>({ phase: "loading" });
    const reader = useRef<ReturnType<typeof createHistoryImageRecovery> | null>(null);
    useEffect(() => {
        const instance = createHistoryImageRecovery({ scope, taskId: intent.taskId, getScope: () => useAccountStore.getState().getDraftScope(), onState: setState });
        reader.current = instance;
        const unsubscribe = useAccountStore.subscribe(() => instance.syncScope());
        void instance.read();
        return () => { unsubscribe(); instance.dispose(); reader.current = null; };
    }, [scope.accountId, scope.epoch, intent.taskId]);
    const task = state.detail?.task;
    const current = () => { const next = useAccountStore.getState().getDraftScope(); return next?.accountId === scope.accountId && next.epoch === scope.epoch; };
    return <section aria-labelledby="image-recovery-title" className="mx-auto flex h-full w-full max-w-[1076px] flex-col gap-4 overflow-y-auto p-4 md:p-6">
        <WorkspaceHeading id="image-recovery-title" title="原图片任务" description="只读核对原任务与结果，不会重新生成或扣费。" action={
            <WorkspaceButton variant="outline" className={workspaceAction} onClick={() => { if (current()) navigate("/generation/history", { state: { generationHistoryQuery: intent.query } }); }}><ArrowLeft aria-hidden="true" />返回创作历史</WorkspaceButton>
        } />
        <p className="break-all text-sm">任务编号：{intent.taskId}</p>
        {state.phase === "loading" ? <WorkspaceFeedback state="loading">正在读取原任务与图片…</WorkspaceFeedback> : state.phase === "error" ? <WorkspaceFeedback state="error" description={state.error}
            action={!state.authenticationRequired ? <WorkspaceButton variant="outline" className={workspaceAction} onClick={() => void reader.current?.read()}><RefreshCw aria-hidden="true" />重试读取原任务</WorkspaceButton> : null}>原任务读取未完成</WorkspaceFeedback> : task ? <>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div><dt>模型</dt><dd className="break-all">{task.modelId}</dd></div>
                <div><dt>任务状态</dt><dd>{i18n.t(`generationHistory.execution.${task.executionStatus}`)} · {i18n.t(`generationHistory.delivery.${task.deliveryStatus}`)} · {i18n.t(`generationHistory.billing.${task.billingStatus}`)}</dd></div>
                <div><dt>正式报价（非实扣）</dt><dd>{task.quotedUnits === null ? "未记录" : `${task.quotedUnits} 积分`}</dd></div>
                <div><dt>实扣积分</dt><dd>{task.billing ? `${task.billing.capturedCredits} 积分` : "待核实"}</dd></div>
            </dl>
            {state.url ? <img src={state.url} alt="原任务图片结果" className="max-h-[55dvh] max-w-full self-start rounded-lg object-contain" /> : <WorkspaceFeedback state="empty">原任务尚无可核实的图片交付</WorkspaceFeedback>}
        </> : null}
        <p className="text-sm text-muted-foreground">当前未载入本机提交回执。原画布需原浏览器数据、有效导出或实际云稿；图片结果不能代替原画布。</p>
        <WorkspaceButton variant="outline" className={`${workspaceAction} self-start`} onClick={() => { if (current()) { const { fromGenerationHistory: _old, ...rest } = location.state ?? {}; navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: rest }); } }}>关闭原任务查看</WorkspaceButton>
    </section>;
}

// Personal provider hooks stay out of the platform workbench's model/specification flow.
function PersonalImageWorkbench({ scope, modeTabs }: { scope: CreationMediaScope; modeTabs?: ReactNode }) {
    const config = useConfigStore(state => state.config), effectiveConfig = useEffectiveConfig();
    return <ImageWorkbench scope={scope} personal={{ config, effectiveConfig }} modeTabs={modeTabs} />;
}

function ImageWorkbench({ scope, personal, modeTabs }: { scope: CreationMediaScope; personal?: { config: AiConfig; effectiveConfig: AiConfig }; modeTabs?: ReactNode }) {
    const { message } = App.useApp();
    const location = useLocation(), navigate = useNavigate();
    const sessionParam = new URLSearchParams(location.search).get("session");
    const [freshConversation] = useState(() => crypto.randomUUID());
    const conversationId = validImageConversationId(sessionParam) ? sessionParam : freshConversation;
    const activeConversation = useRef(conversationId);
    activeConversation.current = conversationId;
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dragDepthRef = useRef(0);
    const config = personal?.config ?? defaultConfig, effectiveConfig = personal?.effectiveConfig ?? defaultConfig;
    const platformMode = !personal;
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const [prompt, setPrompt] = useState("");
    const [references, setReferences] = useState<ReferenceImage[]>([]);
    const referencesRef = useRef(references); referencesRef.current = references;
    const [results, setResults] = useState<GenerationResult[]>([]);
    const [logs, setLogs] = useState<GenerationLog[]>([]);
    const [running, setRunning] = useState(false);
    const [logsOpen, setLogsOpen] = useState(false);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [promptDialogOpen, setPromptDialogOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [startedAt, setStartedAt] = useState(0);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [selectedLogIds, setSelectedLogIds] = useState<string[]>([]);
    const [previewLog, setPreviewLog] = useState<GenerationLog | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const [isReferenceDragActive, setIsReferenceDragActive] = useState(false);
    const [autoRunToken, setAutoRunToken] = useState(0);
    const imageCommand = useWorkbenchAgentStore((state) => state.imageCommand);
    const clearImageCommand = useWorkbenchAgentStore((state) => state.clearImageCommand);
    const updateAgentTask = useWorkbenchAgentStore((state) => state.updateTask);
    const processedCommandRef = useRef(0);
    const agentTaskIdRef = useRef<string | undefined>(undefined);
    const hadLegacyCommand = useRef(Boolean(imageCommand));
    const creation = useCreationMediaLaunch(), restored = useRef(false), consumedLaunch = useRef(""), handledLaunch = useRef("");
    const [draftReady, setDraftReady] = useState(false), [creationLaunch, setCreationLaunch] = useState<CreationMediaLaunch | null>(null), [creationError, setCreationError] = useState("");
    const [platformParameters, setPlatformParameters] = useState<PersonalMediaParameters>({});
    const [platformSettingsReviewed, setPlatformSettingsReviewed] = useState(false);
    const [roundImages, setRoundImages] = useState<Record<string, GeneratedImage[]>>({});
    const roundEnd = useRef<HTMLDivElement>(null);
    const defaultSeed = useRef<{ fresh: boolean; draft: unknown; routeKey: string } | null>(null);
    const draftOwner = useRef<CreationMediaDraft | undefined>(undefined), [draftSaveNotice, setDraftSaveNotice] = useState("");
    const live = useRef(false), generationLock = useRef(false);
    const scopeCurrent = () => { const next = useAccountStore.getState().getDraftScope(); return next?.accountId === scope.accountId && next.epoch === scope.epoch; };
    const current = () => live.current && scopeCurrent();
    const check = () => { if (!scopeCurrent()) throw new Error("账号已变化，请在原账号查看生成记录。"); };
    useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);

    const model = effectiveConfig.imageModel || effectiveConfig.model;
    const canGenerate = Boolean(prompt.trim());
    const referenceIssue = creationReferenceSendIssue(references.length, "image");
    const generationCount = Math.max(1, Math.min(10, Number(config.count) || 1));
    const platformModelId = platformParameters.mappingModelId ?? "";
    const platform = usePlatformImageWorkbench({ enabled: platformMode, scope, conversationId,
        input: { modelId: platformParameters.imageModel ?? "", mappingModelId: platformModelId, mappingSpecification: platformParameters.mappingSpecification, prompt, parameters: Object.fromEntries(["size", "quality"].filter(key => !!platformParameters[key as "size" | "quality"]).map(key => [key, platformParameters[key as "size" | "quality"]])) as GenerationParameters,
            referenceCount: references.length, count: platformParameters.count ?? "1", settingsReviewed: platformSettingsReviewed },
        onImage: async (image, view, submittedPrompt, isOperationCurrent, signal) => {
            const checkImage = () => { if (!current() || !isOperationCurrent()) throw new Error("账号、页面或当前任务已变化，请在原账号查看任务回执。"); };
            checkImage();
            const id = `platform:${view.task.id}`, cached = await logStore(scope).getItem<GenerationLog>(id);
            const existing = cached ? await normalizeLog(cached) : null;
            checkImage();
            if (existing?.images.length && existing.images.every(item => item.dataUrl)) {
                setRoundImages(items => ({ ...items, [view.task.id]: existing.images }));
                return;
            }
            const images: GeneratedImage[] = [];
            try {
                for (const item of image.images ?? [image]) {
                    const stored = await uploadImage(item.url, { signal });
                    images.push({ id: item.cloudMediaId, dataUrl: stored.url, storageKey: stored.storageKey, durationMs: 0,
                        width: item.width, height: item.height, bytes: item.bytes, mimeType: item.mimeType });
                    checkImage();
                }
            } catch (cause) {
                await deleteStoredImages(images.flatMap(item => item.storageKey ? [item.storageKey] : []));
                throw cause;
            }
            const parameters = view.task.imageSpecSnapshot?.status === "recorded" ? view.task.imageSpecSnapshot.parameters : {};
            const log = buildLog({ prompt: submittedPrompt, model: view.task.modelId,
                config: { model: view.task.modelId, imageModel: view.task.modelId, count: String(images.length), size: parameters.size ?? "", quality: parameters.quality ?? "" },
                references: [], durationMs: 0, successCount: images.length, failCount: 0, status: "success", images });
            await saveLog({ ...log, id, title: submittedPrompt.slice(0, 12) || `平台图片 ${view.task.id}` });
            checkImage();
            setRoundImages(items => ({ ...items, [view.task.id]: images }));
        },
    });
    const selectedSpec = selectedImageMapping(platform.mappingModels, platformParameters);
    const referencePrice = platformMode && !platform.loading && !platform.initializationError && scopeCurrent() ? mappedImageReferencePrice(platform.mappingModels, platformParameters) : undefined;
    const roundCount = platform.rounds.length;
    useEffect(() => {
        if (roundCount && roundEnd.current) {
            const stage = roundEnd.current.closest("[data-creation-stage]");
            if (stage) stage.scrollTop = stage.scrollHeight;
        }
    }, [roundCount]);

    useCreationShortcutTarget({ kind: "image", scope, ready: draftReady && !running && !generationLock.current && !platform.busy,
        watch: [prompt, references, platformMode ? platformParameters : config], onApply: prompt => {
            draftOwner.current = useCreationMediaLaunch.getState().drafts.image;
            setDraftSaveNotice(""); setPrompt(prompt);
        } });

    useEffect(() => {
        if (!running || !startedAt) return;
        const timer = window.setInterval(() => setElapsedMs(performance.now() - startedAt), 1000);
        return () => window.clearInterval(timer);
    }, [running, startedAt]);

    useEffect(() => {
        void refreshLogs();
    }, []);

    const canAddReferences = (count: number) => {
        if (referencesRef.current.length + count <= CREATION_DRAFT_REFERENCE_LIMIT) return true;
        message.warning("草稿最多保留14张参考图片，这批素材未添加；已有参考图片全部保留。");
        return false;
    };
    const appendReferences = (items: ReferenceImage[]) => {
        if (!current() || !canAddReferences(items.length)) return false;
        referencesRef.current = [...referencesRef.current, ...items];
        setReferences(referencesRef.current);
        return true;
    };
    const updateReferenceOrder = (update: (items: ReferenceImage[]) => ReferenceImage[]) => {
        const next = reindexCreationReferences(prompt, referencesRef.current, update(referencesRef.current));
        referencesRef.current = next.references;
        setPrompt(next.prompt); setReferences(next.references);
    };
    const addReferences = async (files?: FileList | null) => {
        if (!current()) return;
        const imageFiles = Array.from(files || []).filter((file) => file.type.startsWith("image/"));
        if (!imageFiles.length || !canAddReferences(imageFiles.length)) return;
        const nextReferences = await Promise.all(
            imageFiles.map(async (file) => {
                const image = await uploadImage(file);
                return { id: nanoid(), name: file.name, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
            }),
        );
        appendReferences(nextReferences);
    };

    const addReferencesFromClipboard = async () => {
        if (!current()) return;
        try {
            const items = await navigator.clipboard.read();
            const blobs = await Promise.all(items.flatMap((item) => item.types.filter((type) => type.startsWith("image/")).map((type) => item.getType(type))));
            if (!blobs.length) {
                message.error(t("imageWorkbench.clipboardEmpty"));
                return;
            }
            if (!current() || !canAddReferences(blobs.length)) return;
            const nextReferences = await Promise.all(
                blobs.map(async (blob, index) => {
                    const image = await uploadImage(blob);
                    return { id: nanoid(), name: `clipboard-${index + 1}.png`, type: image.mimeType, dataUrl: image.url, storageKey: image.storageKey };
                }),
            );
            if (appendReferences(nextReferences)) message.success(t("imageWorkbench.clipboardAdded", { count: nextReferences.length }));
        } catch {
            if (current()) message.error(t("imageWorkbench.clipboardEmpty"));
        }
    };

    const generate = async () => {
        if (!current() || running || generationLock.current) return;
        if (platformMode) {
            if (referencePrice === undefined || !platformSettingsReviewed) return;
            if (await platform.send(referencePrice) && current() && activeConversation.current === conversationId) {
                setPrompt(value => value === prompt ? "" : value);
                setResults([]);
                setPreviewLog(null);
                if (!validImageConversationId(sessionParam)) navigate(imageConversationPath(conversationId), { replace: true });
            }
            return;
        }
        const agentTaskId = agentTaskIdRef.current;
        agentTaskIdRef.current = undefined;
        const text = prompt.trim();
        if (!text) {
            message.error(t("imageWorkbench.promptRequired"));
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.promptRequired") });
            return;
        }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.configIncomplete") });
            return;
        }

        const snapshot = buildRequestSnapshot();
        if (!snapshot) {
            if (agentTaskId) updateAgentTask(agentTaskId, { status: "failed", error: t("imageWorkbench.invalidParams") });
            return;
        }

        generationLock.current = true;
        setCreationError("");
        setElapsedMs(0);
        setRunning(true);
        if (agentTaskId) updateAgentTask(agentTaskId, { status: "running", error: undefined });
        setPreviewLog(null);
        setResults(Array.from({ length: generationCount }, () => ({ id: nanoid(), status: "pending" })));
        const batchStartedAt = performance.now();
        setStartedAt(batchStartedAt);

        const tasks = Array.from({ length: generationCount }, (_, index) => runGenerationSlot(index, snapshot));

        const result = await Promise.allSettled(tasks);
        const successImages = result.filter((item): item is PromiseFulfilledResult<GeneratedImage> => item.status === "fulfilled").map((item) => item.value);
        const successCount = successImages.length;
        const failCount = generationCount - successCount;
        const failed = result.find((item): item is PromiseRejectedResult => item.status === "rejected");
        const error = failed?.reason instanceof Error ? failed.reason.message : failCount ? t("workbench.generationFailed") : undefined;
        if (!scopeCurrent()) { generationLock.current = false; return; }
        if (agentTaskId) updateAgentTask(agentTaskId, { status: successCount ? "succeeded" : "failed", successCount, failCount, error: successCount ? undefined : error });

        try {
            await saveLog(
                buildLog({
                    prompt: text,
                    model,
                    config: { ...snapshot.config, count: String(generationCount) },
                    references: snapshot.references,
                    durationMs: performance.now() - batchStartedAt,
                    successCount,
                    failCount,
                    status: successCount ? "success" : "failed",
                    images: successImages,
                }),
            );
            if (current()) successCount ? message.success(t("imageWorkbench.generated")) : message.error(failed?.reason instanceof Error ? failed.reason.message : t("workbench.generationFailed"));
        } catch (cause) { if (current()) message.error(cause instanceof Error ? cause.message : "生成记录保存失败，请保留当前页面。"); }
        finally {
            generationLock.current = false;
            if (current()) setRunning(false);
        }
    };

    // Handle image-generation commands from the Agent panel by setting the prompt and optionally starting generation.
    useEffect(() => {
        if (!imageCommand || imageCommand.nonce === processedCommandRef.current) return;
        hadLegacyCommand.current = true;
        processedCommandRef.current = imageCommand.nonce;
        clearImageCommand();
        if (typeof imageCommand.prompt === "string") setPrompt(imageCommand.prompt);
        if (imageCommand.run && running) {
            if (imageCommand.taskId) updateAgentTask(imageCommand.taskId, { status: "failed", error: t("imageWorkbench.busy") });
            return;
        }
        if (imageCommand.run) {
            agentTaskIdRef.current = imageCommand.taskId;
            setAutoRunToken((value) => value + 1);
        }
    }, [imageCommand, clearImageCommand, running, updateAgentTask]);

    useEffect(() => {
        if (!autoRunToken) return;
        void generate();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoRunToken]);

    useEffect(() => {
        if (restored.current || !creation.ready || creation.scope?.accountId !== scope.accountId || creation.scope.epoch !== scope.epoch) return;
        restored.current = true;
        const draft = hadLegacyCommand.current ? undefined : creation.drafts.image;
        draftOwner.current = creation.drafts.image;
        defaultSeed.current = { fresh: !draft && !hadLegacyCommand.current && !creation.error && !creation.pending, draft: creation.drafts.image, routeKey: location.key };
        if (draft) {
            setPrompt(draft.prompt); setReferences(draft.references);
            if (platformMode) {
                const parameters = imageMediaParameters(draft.parameters);
                setPlatformParameters(parameters);
                setPlatformSettingsReviewed(!!parameters.mappingModelId);
            }
            else for (const [key, value] of Object.entries(personalMediaParameters(draft.parameters))) updateConfig(key as keyof AiConfig, value);
        }
        setDraftReady(true);
    }, [creation.ready, creation.scope, scope.accountId, scope.epoch]);
    const applyDefaultModel = () => {
        const seed = defaultSeed.current, state = useCreationMediaLaunch.getState();
        if (!platformMode || !seed?.fresh) return;
        const unchanged = seed.routeKey === location.key && state.drafts.image === seed.draft && !prompt && !references.length && !Object.keys(platformParameters).length;
        if (!unchanged) { seed.fresh = false; return; }
        const candidate = firstPlatformDefault(platform.mappingModels, { fresh: seed.fresh, current: current(), ready: draftReady && platform.receiptsReady,
            loading: platform.loading, unchanged, busy: running || generationLock.current || platform.busy,
            pending: !!state.pending || !!creationLaunch, error: !!state.error || !!platform.initializationError || !!platform.error });
        if (!candidate) return;
        seed.fresh = false;
        setPlatformParameters(initialMappedImageParameters(candidate));
        setPlatformSettingsReviewed(true);
    };
    useEffect(() => { applyDefaultModel(); }, [draftReady, platform.loading, platform.mappingModels, platform.receiptsReady, platform.initializationError, platform.error, platform.busy, creation.drafts.image, creation.pending, creation.error, creationLaunch, platformParameters, prompt, references, running, location.key]);
    useEffect(() => {
        if (!draftReady || running || generationLock.current || !current() || !isCreationMediaTarget(location.pathname, location.search, "image") || creation.pending?.draft.kind !== "image" || consumedLaunch.current === creation.pending.nonce) return;
        const launch = useCreationMediaLaunch.getState().take("image");
        if (!launch) return;
        draftOwner.current = useCreationMediaLaunch.getState().drafts.image; setDraftSaveNotice("");
        consumedLaunch.current = launch.nonce;
        setPrompt(launch.draft.prompt); setReferences(launch.draft.references);
        if (platformMode) { setPlatformParameters(imageMediaParameters(launch.draft.parameters)); setPlatformSettingsReviewed(false); }
        else for (const [key, value] of Object.entries(personalMediaParameters(launch.draft.parameters))) updateConfig(key as keyof AiConfig, value);
        setCreationLaunch(launch);
    }, [draftReady, creation.pending?.nonce, running, scope.accountId, scope.epoch, location.pathname, location.search]);
    useEffect(() => {
        if (!draftReady || !creationLaunch || handledLaunch.current === creationLaunch.nonce) return;
        handledLaunch.current = creationLaunch.nonce;
        if (platformMode) {
            setCreationError("首页的提示词、参数和素材已带入。选择平台模型和图片参数后发送。");
            return;
        }
        if (!useCreationMediaLaunch.getState().isCurrent(creationLaunch) || prompt !== creationLaunch.draft.prompt || JSON.stringify(references) !== JSON.stringify(creationLaunch.draft.references) || JSON.stringify(personalMediaParameters(effectiveConfig)) !== JSON.stringify(personalMediaParameters(creationLaunch.draft.parameters))) { setCreationError("自动发起已取消：草稿或账号发生变化，当前输入已保留。"); return; }
        if (references.length > 12) { setCreationError("参考素材最多12个，未发起生成；草稿已保留。"); return; }
        if (!isAiConfigReady(effectiveConfig, model)) { setCreationError("尚未生成：原图片页使用个人直连渠道，当前没有有效渠道配置；提示词、参数和素材已保留。"); return; }
        void generate();
    }, [draftReady, creationLaunch, prompt, references, effectiveConfig, model]);
    const persistDraft = () => {
        if (!draftReady || !current() || creation.pending?.draft.kind === "image") return;
        const next = { kind: "image" as const, prompt, references, parameters: platformMode ? platformParameters : personalMediaParameters(config) }, previous = useCreationMediaLaunch.getState().drafts.image;
        if (previous !== draftOwner.current) { setDraftSaveNotice("草稿已由其他入口更新，当前输入仍保留在此页，未覆盖新草稿；请核对后再继续。"); return; }
        if (!previous || JSON.stringify({ ...previous, revision: undefined }) !== JSON.stringify(next)) {
            const seed = defaultSeed.current, initial = seed?.fresh && seed.draft === previous && !prompt && !references.length && !Object.keys(platformParameters).length;
            void useCreationMediaLaunch.getState().edit(next);
            draftOwner.current = useCreationMediaLaunch.getState().drafts.image;
            if (initial) seed.draft = useCreationMediaLaunch.getState().drafts.image;
        }
    };
    useEffect(persistDraft, [draftReady, prompt, references, config, platformParameters, platformMode, creation.pending?.nonce]);

    const downloadImage = (image: GeneratedImage, index: number) => {
        saveAs(image.dataUrl, `image-${index + 1}.png`);
    };

    const addResultToReferences = async (image: GeneratedImage, index: number) => {
        if (!current() || !canAddReferences(1)) return;
        const stored = await uploadImage(image.dataUrl);
        if (appendReferences([{ id: nanoid(), name: `result-${index + 1}.png`, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }])) message.success(t("imageWorkbench.addedReference"));
    };

    const saveResultToAssets = async (image: GeneratedImage, index: number, imagePrompt = prompt) => {
        const stored = await uploadImage(image.dataUrl);
        addAsset({
            kind: "image",
            title: t("imageWorkbench.resultTitle", { count: index + 1 }),
            coverUrl: stored.url,
            tags: [],
            source: t("imageWorkbench.source"),
            data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType },
            metadata: { source: "image-page", prompt: imagePrompt },
        });
        message.success(t("common.addedToAssets"));
    };

    const insertPickedAsset = async (payload: InsertAssetPayload) => {
        if (!current()) return;
        if (payload.kind === "text") {
            setPrompt(payload.content);
        } else if (payload.kind === "image") {
            if (!canAddReferences(1)) return;
            const stored = await uploadImage(payload.dataUrl);
            if (!appendReferences([{ id: nanoid(), name: payload.title, type: stored.mimeType, dataUrl: stored.url, storageKey: stored.storageKey }])) return;
        } else {
            message.warning(t("imageWorkbench.unsupportedAsset"));
        }
        setAssetPickerOpen(false);
    };

    const createSession = () => {
        if (platformMode && platform.busy) return;
        setPrompt("");
        setReferences([]);
        setResults([]);
        setElapsedMs(0);
        setStartedAt(0);
        setSelectedLogIds([]);
        setPreviewLog(null);
        if (platformMode) {
            setLogsOpen(false);
            navigate(imageConversationPath(crypto.randomUUID()));
        }
    };

    const deleteSelectedLogs = () => {
        const imageKeys = logs.filter((log) => selectedLogIds.includes(log.id)).flatMap((log) => log.images.map((image) => image.storageKey).filter((key): key is string => Boolean(key)));
        void Promise.all([deleteStoredImages(imageKeys), ...selectedLogIds.map((id) => logStore(scope).removeItem(id))]).then(refreshLogs);
        if (previewLog && selectedLogIds.includes(previewLog.id)) {
            setPreviewLog(null);
            setResults([]);
        }
        setSelectedLogIds([]);
        setDeleteConfirmOpen(false);
    };

    const saveLog = async (log: GenerationLog) => {
        check(); await logStore(scope).setItem(log.id, serializeLog(log)); check();
        if (current()) await refreshLogs();
    };

    const refreshLogs = async () => { const items = await readStoredLogs(scope); if (current()) setLogs(items); };

    const previewGenerationLog = async (log: GenerationLog) => {
        setPreviewLog(log);
        setLogsOpen(false);
        setPrompt(log.prompt);
        setReferences(log.references || []);
        if (platformMode) { setPlatformParameters(log.config); setPlatformSettingsReviewed(false); }
        else {
            if (log.config.imageModel || log.model) updateConfig("imageModel", log.config.imageModel || log.model);
            if (log.config.quality) updateConfig("quality", log.config.quality);
            if (log.config.size) updateConfig("size", log.config.size);
            if (log.config.count) updateConfig("count", log.config.count);
        }
        setResults(log.images.map((image) => ({ id: image.id, status: "success", image })));
    };

    const buildRequestSnapshot = () => {
        const text = prompt.trim();
        if (!text) {
            message.error(t("imageWorkbench.promptRequired"));
            return null;
        }
        if (references.length > 12) { setCreationError("参考素材最多12个，未发起生成；全部当前输入仍在此页，请自行移除多余素材。"); return null; }
        if (!isAiConfigReady(effectiveConfig, model)) {
            message.warning(t("workbench.configFirst"));
            openConfigDialog(true);
            return null;
        }
        return { text, config: { ...effectiveConfig, model, count: "1" }, references: [...references] };
    };

    const runGenerationSlot = async (index: number, snapshot: { text: string; config: AiConfig; references: ReferenceImage[] }) => {
        const itemStartedAt = performance.now();
        try {
            check();
            const result = snapshot.references.length ? await requestEdit(snapshot.config, snapshot.text, snapshot.references) : await requestGeneration(snapshot.config, snapshot.text);
            check();
            const image = result[0];
            if (!image) throw new Error(t("imageWorkbench.missingResult"));
            const stored = await uploadImage(image.dataUrl);
            check();
            const nextImage: GeneratedImage = { id: image.id, dataUrl: stored.url, ...(stored.storageKey ? { storageKey: stored.storageKey } : {}), durationMs: performance.now() - itemStartedAt, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType };
            if (current()) setResults((value) => updateResultAt(value, index, { status: "success", image: nextImage }));
            return nextImage;
        } catch (error) {
            if (current()) setResults((value) => updateResultAt(value, index, { status: "failed", error: error instanceof Error ? error.message : t("workbench.generationFailed") }));
            throw error;
        }
    };

    const retryResult = async (index: number) => {
        const snapshot = buildRequestSnapshot();
        if (!snapshot) return;
        setPreviewLog(null);
        setResults((value) => updateResultAt(value, index, { status: "pending", error: undefined, image: undefined }));
        const retryStartedAt = performance.now();
        try {
            const image = await runGenerationSlot(index, snapshot);
            await saveLog(
                buildLog({
                    prompt: snapshot.text,
                    model,
                    config: { ...snapshot.config, count: "1" },
                    references: snapshot.references,
                    durationMs: performance.now() - retryStartedAt,
                    successCount: 1,
                    failCount: 0,
                    status: "success",
                    images: [image],
                }),
            );
            if (current()) message.success(t("workbench.retrySuccess"));
        } catch {
            // runGenerationSlot has already marked the result as failed.
        }
    };

    if (!draftReady) return creation.error ? <Alert className="m-4" type="error" title={creation.error} />
        : <div className="m-4 flex items-center gap-2" role="status"><Spin size="small" /><span>正在读取当前账号的图片草稿…</span></div>;
    return (
        <>
            <CreationWorkbench kind="image" hasContent={results.length > 0 || Boolean(roundCount || platform.initializationError || platform.error || draftSaveNotice)} composer={
                <div className={`flex min-h-[286px] min-w-0 flex-col rounded-2xl border bg-card p-4 sm:min-h-[250px] ${isReferenceDragActive ? "border-primary" : "border-border"}`} data-canvas-shortcuts-ignore
                    onDragEnter={event => { event.preventDefault(); dragDepthRef.current++; if (event.dataTransfer.types.includes("Files")) setIsReferenceDragActive(true); }}
                    onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
                    onDragLeave={event => { event.preventDefault(); dragDepthRef.current = Math.max(0, dragDepthRef.current - 1); if (!dragDepthRef.current) setIsReferenceDragActive(false); }}
                    onDrop={event => { event.preventDefault(); dragDepthRef.current = 0; setIsReferenceDragActive(false); void addReferences(event.dataTransfer.files); }}>
                    <div className="mb-2 flex items-center gap-2">
                        <CreationToolsMenu items={[
                            { key: "upload", label: "上传参考图", icon: <Upload className="size-4" />, onSelect: () => fileInputRef.current?.click(), disabled: references.length >= CREATION_DRAFT_REFERENCE_LIMIT },
                            { key: "prompts", label: t("workbench.viewPrompts"), icon: <BookOpen className="size-4" />, onSelect: () => setPromptDialogOpen(true) },
                            { key: "assets", label: t("workbench.viewAssets"), icon: <FolderPlus className="size-4" />, onSelect: () => setAssetPickerOpen(true) },
                            { key: "clipboard", label: t("workbench.clipboard"), icon: <ClipboardPaste className="size-4" />, onSelect: () => { void addReferencesFromClipboard(); } },
                        ]} />
                        {platformMode && !references.length ? <span className="min-w-0 flex-1 text-xs text-muted-foreground">平台图片 · 不使用参考图</span> : null}
                        {platformMode ? <Button type="text" size="small" className="ml-auto" icon={<Plus className="size-4" />} disabled={platform.busy} onClick={createSession}>新建对话</Button> : null}
                        <Button type="text" size="small" className={platformMode ? undefined : "ml-auto"} icon={<History className="size-4" />} onClick={() => setLogsOpen(true)}>{platformMode ? "回执" : "记录"}</Button>
                    </div>
                    {!platformMode || references.length ? <div className="hover-scrollbar mb-1 flex min-w-0 gap-2 overflow-x-auto pb-2 overscroll-x-contain" aria-label="图片参考素材">
                        <Button type="text" className="!size-16 !shrink-0 !rounded-xl !border !border-dashed !border-border !p-0 !text-muted-foreground" disabled={references.length >= CREATION_DRAFT_REFERENCE_LIMIT} icon={<Plus className="size-5" />} onClick={() => fileInputRef.current?.click()} aria-label="添加参考图" />
                        {references.map((item, index) => <div key={item.id} className="group relative size-16 shrink-0 overflow-hidden rounded-xl border border-border">
                            <img src={previewUrlFor(item.storageKey) || item.dataUrl} alt={item.name} className="size-full object-cover" />
                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">{imageReferenceLabel(index)}</span>
                            <ReferenceOrderButtons index={index} total={references.length} onMove={offset => updateReferenceOrder(value => moveListItem(value, index, offset))} />
                            <button type="button" className="absolute right-1 top-1 grid size-5 place-items-center rounded bg-black/60 text-white" onClick={() => updateReferenceOrder(value => value.filter(ref => ref.id !== item.id))} aria-label={t("imageWorkbench.removeReference")}><Trash2 className="size-3" /></button>
                        </div>)}
                    </div> : null}
                    {!platformMode || references.length ? <div role="status" className="mb-2 text-xs text-muted-foreground">参考图 {references.length}/{CREATION_DRAFT_REFERENCE_LIMIT} 张</div> : null}
                    <Input.TextArea aria-label="图片提示词" value={prompt} onChange={event => setPrompt(event.target.value)} rows={3} className="!min-h-20 !max-h-44 w-full resize-none !border-0 !bg-transparent !p-0 !shadow-none focus-visible:!ring-0" placeholder={isReferenceDragActive ? t("imageWorkbench.dropReferences") : t("imageWorkbench.promptPlaceholder")} />
                    {(creation.error || creationError) && <Alert className="my-2" type="warning" title={creation.error || creationError} />}
                    {draftSaveNotice ? <Alert className="my-2" type="warning" title={draftSaveNotice} /> : null}
                    {referenceIssue ? <p role="alert" className="my-2 text-xs text-muted-foreground">{referenceIssue}</p> : null}
                    {platformMode && references.length > 0 ? <p role="alert" className="my-2 text-xs text-muted-foreground">已保留 {references.length} 张参考图；当前平台仅支持文字生图，请先移除参考图。</p> : null}
                    <CreationToolbar mode={modeTabs}
                        model={platformMode ? <PlatformImageModelPicker models={platform.mappingModels} value={platformModelId} loading={platform.loading} disabled={platform.busy}
                            onChange={model => { setPlatformParameters(initialMappedImageParameters(model)); setPlatformSettingsReviewed(true); }} />
                            : <ModelPicker config={effectiveConfig} value={model} onChange={value => updateConfig("imageModel", value)} capability="image" fullWidth onMissingConfig={() => openConfigDialog(false)} />}
                        parameters={
                        <CreationParameters label="图片参数" presentation="image" open={settingsOpen} onOpenChange={setSettingsOpen}
                            summary={platformMode ? selectedSpec ? `${selectedSpec.specification} · ${imageMappingAspectRatio(selectedSpec)} · ${platformParameters.count ?? "1"} 张` : "图片参数" : `${effectiveConfig.size || "自动尺寸"} · ${effectiveConfig.quality || "自动质量"} · ${generationCount}张`}>
                            {platformMode ? <PlatformImageSettings platform={platform} parameters={platformParameters}
                                onChange={parameters => { setPlatformParameters(parameters); setPlatformSettingsReviewed(true); }} />
                                : <GenerationSettings config={effectiveConfig} updateConfig={updateConfig} />}
                            {!platformMode ? <CreationHint>透明背景仅部分模型可用。</CreationHint> : null}
                        </CreationParameters>
                        }
                        estimate={platformMode ? <span>{referencePrice === undefined ? "— 积分" : `${referencePrice} 积分`}</span>
                            : <CreationHint summary={<span>预计 — 积分</span>}>当前图片渠道未提供平台积分预估，费用由该服务结算。</CreationHint>}
                        action={<Button type="primary" shape="circle" aria-label={platformMode ? `发送图片请求${referencePrice === undefined ? "" : `（${referencePrice} 积分）`}` : "生成图片"} title="生成图片" icon={<ArrowUp className="size-4" />} loading={platformMode ? platform.busy : running}
                            disabled={!canGenerate || running || !!referenceIssue || platformMode && (platform.loading || !!platform.initializationError || !platformSettingsReviewed || referencePrice === undefined || !platform.receiptsReady || platform.busy || references.length > 0)} onClick={() => void generate()}
                        />}
                    />
                </div>
            }>
                <section aria-label="图片生成结果" className="min-w-0 space-y-4">
                    {platformMode ? <>
                        <div className="space-y-5" aria-label="图片创作对话">
                            {platform.rounds.map(round => <PlatformImageTask key={round.key} platform={platform} round={round}>
                                {round.state.receipt?.taskId && roundImages[round.state.receipt.taskId] ? <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                                    {roundImages[round.state.receipt.taskId].map((image, index) =>
                                        <ResultImageCard key={image.id} image={image} index={index} onDownload={downloadImage}
                                            onSaveAsset={(item, position) => saveResultToAssets(item, position, round.prompt)} />)}
                                </div> : null}
                            </PlatformImageTask>)}
                        </div>
                        {platform.initializationError ? <WorkspaceFeedback state="error"
                            action={<WorkspaceButton variant="outline" className={workspaceAction} onClick={() => void platform.retryInitialization()}><RefreshCw aria-hidden="true" />重新读取</WorkspaceButton>}>{platform.initializationError}</WorkspaceFeedback> : null}
                        {platform.error ? <Alert type="warning" title={platform.error} /> : null}
                        <div ref={roundEnd} />
                    </> : null}
                    {results.length ? <>
                        <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-lg font-semibold">{t("workbench.results")}</h2>{running ? <Tag>{t("workbench.waiting", { time: formatDuration(elapsedMs) })}</Tag> : null}</div>
                        <div className="grid min-w-0 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                            {results.map((result, index) => result.status === "success" && result.image
                                ? <ResultImageCard key={result.id} image={result.image} index={index} onEdit={addResultToReferences} onDownload={downloadImage} onSaveAsset={saveResultToAssets} />
                                : result.status === "failed" ? <FailedImageCard key={result.id} error={result.error || t("workbench.generationFailed")} onRetry={() => retryResult(index)} /> : <PendingImageCard key={result.id} />)}
                        </div>
                    </> : null}
                </section>
            </CreationWorkbench>
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void addReferences(event.target.files);
                    event.target.value = "";
                }}
            />
            <Drawer title={platformMode ? "图片任务回执" : t("workbench.logs")} placement="bottom" size="large" open={logsOpen} onClose={() => setLogsOpen(false)}>
                {platformMode ? <PlatformImageReceipts platform={platform} onOpen={(id) => {
                    if (!current()) return;
                    setLogsOpen(false);
                    if (id && id !== conversationId) navigate(imageConversationPath(id));
                }} /> : <LogPanel
                    logs={logs}
                    selectedLogIds={selectedLogIds}
                    activeLogId={previewLog?.id}
                    onSelectedLogIdsChange={setSelectedLogIds}
                    onCreateSession={createSession}
                    onDeleteSelected={() => setDeleteConfirmOpen(true)}
                    onPreviewLog={(log) => void previewGenerationLog(log)}
                />}
            </Drawer>
            <PromptSelectDialog open={promptDialogOpen} onOpenChange={setPromptDialogOpen} onSelect={setPrompt} />
            <AssetPickerModal open={assetPickerOpen} defaultTab="my-assets" onInsert={(payload) => void insertPickedAsset(payload)} onClose={() => setAssetPickerOpen(false)} />
            <Modal title={t("workbench.deleteLogs")} open={deleteConfirmOpen} onCancel={() => setDeleteConfirmOpen(false)} onOk={deleteSelectedLogs} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>
                {t("workbench.deleteLogsConfirm", { count: selectedLogIds.length })}
            </Modal>
        </>
    );
}

type PlatformWorkbench = ReturnType<typeof usePlatformImageWorkbench>;

export function PlatformImageReceipts({ platform, onOpen }: { platform: PlatformWorkbench; onOpen?: (id?: string) => void }) {
    return <div className="mb-5 space-y-2">
        <Typography.Text strong>平台任务回执</Typography.Text>
        <p className="text-xs opacity-70">离页不会取消已受理任务。返回后查询原回执，查询不会再次生成。</p>
        {!platform.receiptsReady ? platform.initializationError || platform.error ? <Alert type="warning" showIcon title={platform.initializationError || platform.error} />
            : <div className="flex items-center gap-2" role="status"><Spin size="small" /><span>正在读取本机回执…</span></div>
            : !platform.receipts.length ? <p className="text-xs opacity-70">暂无平台任务回执</p> : null}
        {platform.receipts.map(receipt => <div key={receipt.idempotencyKey} className="space-y-1 border-b border-stone-200 py-2 dark:border-stone-800">
            <p className="break-all text-xs">{receipt.taskId ?? receipt.idempotencyKey}</p>
            <Button size="small" disabled={platform.loading} onClick={() => void platform.restore(receipt).then(id => onOpen?.(id))}>{receipt.rejection ? "核对未受理记录" : "核对原任务 / 查看图片"}</Button>
        </div>)}
    </div>;
}

export function PlatformImageTask({ platform, round, children }: { platform: PlatformWorkbench; round: PlatformImageRound; children?: ReactNode }) {
    const { state } = round, task = state.view?.task;
    const status = task ? { pending: "待处理", queued: "排队中", running: "生成中", succeeded: "生成完成", failed: "生成失败", unknown: "结果待核对", cancelled: "已取消", timeout: "结果待核对" }[task.executionStatus]
        : state.phase === "preparing" || state.phase === "ready" ? "正在核对费用" : state.phase === "submitting" ? "正在提交" : state.phase === "rejected" ? "本次未受理" : state.phase === "failed" ? "发送未完成" : "提交结果待核对";
    const billing = task ? { reserved: "积分已冻结", captured: "积分已结算", released: "冻结积分已退回", pending_review: "费用待核对", unbilled: "未计费" }[task.billingStatus] : "";
    return <article className="min-w-0 space-y-2.5" data-image-round={round.key}>
        {round.prompt ? <p className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-muted px-4 py-2.5 text-sm">{round.prompt}</p> : null}
        <div className="space-y-2 border-l-2 border-border pl-3 sm:pl-4">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 break-words text-sm" role="status">
                <span className="font-medium">{round.model || task?.modelId || "图片任务"}</span>
                <span>{status}</span>
                {round.count ? <span className="text-xs text-muted-foreground">{round.count} 张</span> : null}
                {task || state.quote ? <span className="text-xs text-muted-foreground">{task?.quotedUnits ?? state.quote?.quotedUnits} 积分</span> : null}
                {billing ? <span className="text-xs text-muted-foreground">{billing}</span> : null}
            </p>
            {state.error || round.imageError ? <Alert type="warning" title={round.imageError || state.error?.message} /> : null}
            {round.imageBusy ? <p className="text-xs text-muted-foreground" role="status">正在读取图片…</p> : null}
            {children}
            {state.receipt ? <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">任务回执</summary>
                <div className="mt-2 space-y-2">
                    <p className="break-all">{state.receipt.taskId ?? state.receipt.idempotencyKey}</p>
                    <ImageSpecHistory snapshot={task?.imageSpecSnapshot} />
                    {state.phase !== "rejected" ? <Button size="small" loading={state.busy} onClick={() => platform.refresh(round.key)}>核对原任务</Button> : null}
                </div>
            </details> : null}
            {round.imageError ? <Button size="small" loading={round.imageBusy} onClick={() => platform.loadImage(round.key)}>重新读取图片</Button> : null}
        </div>
    </article>;
}

function GenerationSettings({ config, updateConfig }: { config: AiConfig; updateConfig: UpdateAiConfig }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return <ImageSettingsPanel config={config} onConfigChange={(key, value) => updateConfig(key, value)} theme={theme} showTitle={false} showInlineHelp={false} className="space-y-4" maxCount={10} />;
}

function ResultImageCard({
    image,
    index,
    onEdit,
    onDownload,
    onSaveAsset,
}: {
    image: GeneratedImage;
    index: number;
    onEdit?: (image: GeneratedImage, index: number) => void;
    onDownload: (image: GeneratedImage, index: number) => void;
    onSaveAsset: (image: GeneratedImage, index: number) => void;
}) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    return (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-background dark:border-stone-800">
            <Image src={previewUrlFor(image.storageKey) || image.dataUrl} preview={{ src: image.dataUrl }} alt={t("imageWorkbench.resultAlt", { count: index + 1 })} className={onEdit ? "aspect-square object-cover" : "mx-auto max-h-[360px] w-full object-contain"} />
            <div className="space-y-2 border-t border-stone-200 px-3 py-2.5 dark:border-stone-800">
                <div className="flex min-w-0 gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                    <span>
                        {image.width}x{image.height}
                    </span>
                    <span>{formatBytes(image.bytes)}</span>
                    <span>{formatDuration(image.durationMs)}</span>
                </div>
                <div className={`grid min-w-0 gap-2 ${onEdit ? "grid-cols-3" : "grid-cols-2"}`}>
                    <Tooltip title={t("common.addToAssets")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<FolderPlus className="size-3.5" />} onClick={() => void onSaveAsset(image, index)}>
                            {t("common.addToAssets")}
                        </Button>
                    </Tooltip>
                    {onEdit ? <Tooltip title={t("imageWorkbench.addReference")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<PenLine className="size-3.5" />} onClick={() => void onEdit(image, index)}>
                            {t("imageWorkbench.addReference")}
                        </Button>
                    </Tooltip> : null}
                    <Tooltip title={t("common.download")}>
                        <Button className={RESULT_ACTION_BUTTON_CLASS} size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(image, index)}>
                            {t("common.download")}
                        </Button>
                    </Tooltip>
                </div>
            </div>
        </div>
    );
}

function PendingImageCard() {
    const { t } = useTranslation();
    return (
        <div className="relative aspect-square overflow-hidden rounded-lg border border-dashed border-stone-300 bg-stone-50 dark:border-stone-700 dark:bg-stone-900">
            <div
                className="absolute inset-0 opacity-60"
                style={{
                    backgroundImage: "radial-gradient(circle, rgba(120,113,108,0.35) 1.4px, transparent 1.6px)",
                    backgroundSize: "16px 16px",
                }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-stone-500 dark:text-stone-400">
                <LoaderCircle className="size-6 animate-spin" />
                <span>{t("workbench.generating")}</span>
            </div>
        </div>
    );
}

function FailedImageCard({ error, onRetry }: { error: string; onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="overflow-hidden rounded-lg border border-red-200 bg-red-50 dark:border-red-950 dark:bg-red-950/20">
            <div className="flex aspect-square flex-col items-center justify-center gap-3 p-5 text-center">
                <div className="text-sm font-medium text-red-600 dark:text-red-300">{t("workbench.failed")}</div>
                <Typography.Paragraph ellipsis={{ rows: 4 }} className="!mb-0 !text-xs !text-red-500 dark:!text-red-300">
                    {error}
                </Typography.Paragraph>
            </div>
            <div className="flex justify-end border-t border-red-200 p-3 dark:border-red-950">
                <Button size="small" danger onClick={onRetry}>
                    {t("workbench.retry")}
                </Button>
            </div>
        </div>
    );
}

function updateResultAt(results: GenerationResult[], index: number, next: Partial<GenerationResult>) {
    return results.map((item, itemIndex) => (itemIndex === index ? { ...item, ...next } : item));
}

function LogPanel({
    logs,
    selectedLogIds,
    activeLogId,
    onSelectedLogIdsChange,
    onCreateSession,
    onDeleteSelected,
    onPreviewLog,
}: {
    logs: GenerationLog[];
    selectedLogIds: string[];
    activeLogId?: string;
    onSelectedLogIdsChange: (ids: string[]) => void;
    onCreateSession: () => void;
    onDeleteSelected: () => void;
    onPreviewLog: (log: GenerationLog) => void;
}) {
    const { t } = useTranslation();
    const allSelected = Boolean(logs.length) && selectedLogIds.length === logs.length;
    const toggleAll = () => onSelectedLogIdsChange(allSelected ? [] : logs.map((log) => log.id));

    return (
        <>
            <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                    <h2 className="text-base font-semibold">{t("workbench.logs")}</h2>
                </div>
                <Tag className="m-0">{logs.length}</Tag>
            </div>
            <div className="mb-4 flex flex-wrap gap-2">
                <Button size="small" icon={<Plus className="size-3.5" />} onClick={onCreateSession}>
                    {t("workbench.new")}
                </Button>
                <Button size="small" icon={<CheckSquare className="size-3.5" />} disabled={!logs.length} onClick={toggleAll}>
                    {allSelected ? t("common.cancel") : t("workbench.selectAll")}
                </Button>
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} disabled={!selectedLogIds.length} onClick={onDeleteSelected}>
                    {t("common.delete")}
                </Button>
            </div>
            <div className="space-y-3">
                {logs.map((log) => (
                    <LogCard
                        key={log.id}
                        log={log}
                        selected={selectedLogIds.includes(log.id)}
                        active={activeLogId === log.id}
                        onSelectedChange={(checked) => onSelectedLogIdsChange(checked ? [...selectedLogIds, log.id] : selectedLogIds.filter((id) => id !== log.id))}
                        onClick={() => onPreviewLog(log)}
                    />
                ))}
                {!logs.length ? <div className="flex min-h-48 items-center justify-center rounded-lg border border-dashed border-stone-300 text-center text-sm text-stone-500 dark:border-stone-700">{t("workbench.noLogs")}</div> : null}
            </div>
        </>
    );
}

function LogCard({ log, selected, active, onSelectedChange, onClick }: { log: GenerationLog; selected: boolean; active: boolean; onSelectedChange: (checked: boolean) => void; onClick: () => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const thumbnails = log.images.filter((image) => image.dataUrl).slice(0, 4);

    return (
        <button
            type="button"
            className={`block w-full rounded-lg border p-2 text-left transition ${active ? "border-stone-900 bg-blue-50 dark:border-stone-100 dark:bg-blue-950/20" : "border-stone-200 bg-background hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-900"}`}
            onClick={onClick}
        >
            <div className="grid grid-cols-[minmax(128px,1fr)_auto] gap-2">
                <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-2">
                    <Checkbox className="mt-0.5" checked={selected} onClick={(event) => event.stopPropagation()} onChange={(event) => onSelectedChange(event.target.checked)} />
                    <div className="min-w-0">
                        <div className="truncate text-sm font-semibold leading-5">{log.title}</div>
                        {thumbnails.length ? (
                            <div className="mt-2 flex gap-1 overflow-hidden">
                                {thumbnails.map((image) => (
                                    <img key={image.id} src={previewUrlFor(image.storageKey) || image.dataUrl} alt="" className="size-8 shrink-0 rounded-md object-cover" />
                                ))}
                            </div>
                        ) : null}
                    </div>
                </div>
                <div className="grid justify-items-end gap-2">
                    <div className="flex gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="blue">
                            {t("workbench.successCount", { count: log.successCount ?? log.imageCount })}
                        </Tag>
                        {log.failCount ? (
                            <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="red">
                                {t("workbench.failCount", { count: log.failCount })}
                            </Tag>
                        ) : null}
                    </div>
                    <div className="flex flex-wrap justify-end gap-1">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{t("workbench.itemCount", { count: log.imageCount })}</Tag>
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none" color="green">
                            {formatDuration(log.durationMs)}
                        </Tag>
                    </div>
                    <div className="flex justify-end">
                        <Tag className="m-0 flex h-6 items-center rounded-md px-1.5 text-xs leading-none">{log.time}</Tag>
                    </div>
                </div>
            </div>
        </button>
    );
}

async function readStoredLogs(scope?: CreationMediaScope) {
    if (typeof window === "undefined") return [];
    try {
        const values: GenerationLog[] = [];
        await logStore(scope).iterate<GenerationLog, void>((value) => {
            values.push(value);
        });
        const logs = await Promise.all(values.map(normalizeLog));
        return logs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    } catch {
        return [];
    }
}

async function normalizeLog(log: Partial<GenerationLog>): Promise<GenerationLog> {
    const references = await Promise.all(
        (log.references || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const images = await Promise.all(
        (log.images || []).map(async (item) => {
            void ensureImagePreview(item.storageKey);
            return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        }),
    );
    const config = normalizeLogConfig(log);
    return {
        id: log.id || nanoid(),
        createdAt: log.createdAt || Date.now(),
        title: log.title || log.model || i18n.t("workbench.untitled"),
        prompt: log.prompt || log.title || "",
        time: log.time || new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model: log.model || config.imageModel || "",
        config,
        references,
        durationMs: log.durationMs || 0,
        successCount: log.successCount ?? log.imageCount ?? 0,
        failCount: log.failCount || 0,
        imageCount: log.imageCount || log.successCount || 0,
        size: log.size || config.size || "",
        quality: log.quality || config.quality || "",
        status: log.status || "success",
        images,
    };
}

function serializeLog(log: GenerationLog): GenerationLog {
    return {
        ...log,
        references: log.references.map((item) => ({ ...item, dataUrl: item.storageKey ? "" : item.dataUrl })),
        images: log.images.map((image) => ({ ...image, dataUrl: image.storageKey ? "" : image.dataUrl })),
    };
}

function normalizeLogConfig(log: Partial<GenerationLog>): GenerationLogConfig {
    return {
        model: log.config?.model || log.model || "",
        imageModel: log.config?.imageModel || log.model || "",
        quality: log.config?.quality || log.quality || "",
        size: log.config?.size || log.size || "",
        count: log.config?.count || String(log.imageCount || log.successCount || 1),
    };
}

function moveListItem<T>(items: T[], index: number, offset: number) {
    const targetIndex = index + offset;
    if (targetIndex < 0 || targetIndex >= items.length) return items;
    const next = [...items];
    [next[index], next[targetIndex]] = [next[targetIndex], next[index]];
    return next;
}

function ReferenceOrderButtons({ index, total, onMove }: { index: number; total: number; onMove: (offset: number) => void }) {
    if (total <= 1) return null;
    return (
        <div className="absolute inset-x-1 bottom-1 flex justify-between">
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowLeft className="size-3" />} disabled={index <= 0} onClick={() => onMove(-1)} />
            <Button size="small" className="!h-6 !w-6 !min-w-6 !rounded-full !bg-white/85 !p-0 !shadow-sm" icon={<ArrowRight className="size-3" />} disabled={index >= total - 1} onClick={() => onMove(1)} />
        </div>
    );
}

function buildLog({
    prompt,
    model,
    config,
    references,
    durationMs,
    successCount,
    failCount,
    status,
    images,
}: {
    prompt: string;
    model: string;
    config: GenerationLogConfig;
    references: ReferenceImage[];
    durationMs: number;
    successCount: number;
    failCount: number;
    status: GenerationLog["status"];
    images: GeneratedImage[];
}): GenerationLog {
    const logConfig = {
        model: config.model,
        imageModel: config.imageModel,
        quality: config.quality,
        size: config.size,
        count: config.count,
    };
    return {
        id: nanoid(),
        createdAt: Date.now(),
        title: prompt.slice(0, 12) || i18n.t("workbench.untitled"),
        prompt,
        time: new Date().toLocaleString(i18n.resolvedLanguage, { hour12: false }),
        model,
        config: logConfig,
        references,
        durationMs,
        successCount,
        failCount,
        imageCount: Number(logConfig.count) || successCount,
        size: logConfig.size,
        quality: logConfig.quality,
        status,
        images,
    };
}
