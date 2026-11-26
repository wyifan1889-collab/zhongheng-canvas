import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Input, InputNumber, Modal, Space, Typography } from "antd";
import { useAccountStore } from "@/stores/use-account-store";
import { GenerationError, type GenerationImageSpecSnapshot, type GenerationScope, type GenerationParameters, type GenerationTaskView } from "@/services/saas/generation";
import { createMappedImageGenerationClient, selectedImageMapping, type ImageMappingModel, type ImageMappingSelection } from "@/services/saas/mapped-image-generation";
import { ImageMappingFields } from "./canvas-platform-image-settings";
import { createCanvasImageGenerationController, sameImageTargetBinding, type CanvasImageGenerationState, type GenerationReceipt } from "@/services/saas/canvas-image-generation";
import { insertGeneratedImage, type CanvasGeneratedImage } from "@/services/saas/canvas-generated-image";
import { createMediaClient } from "@/services/api/media";
import type { ImageTargetBinding } from "@/lib/canvas/platform-image-target";
import type { PlatformImageLocalSettings } from "@/lib/canvas/platform-image-input";
import { generationTracker } from "@/stores/use-generation-tracker";
import { imageRequestCounts } from "../../../../packages/shared/src/generation-image-batch";
import { ModelBrandIcon } from "@/components/model-brand-icon";
import { GEMINI_IMAGE_PROTOCOL } from "../../../../packages/shared/src/generation-gemini-image";

export type PlatformImageApplication = { status: "filled-original" | "added-linked" | "saved-new" | "already-applied" | "application-uncertain" | "protected"; reason?: string; committed?: boolean };
type Props = { projectId: string; isProjectCurrent: () => boolean; initialPrompt?: string; imageTarget?: ImageTargetBinding; localSettings?: PlatformImageLocalSettings;
    initialSelection?: ImageMappingSelection;
    recoveryTask?: { taskId: string; target: ImageTargetBinding };
    beforeImageReceipt?: (target: ImageTargetBinding, nodeId?: string) => Promise<void>; isIntentCurrent?: () => boolean;
    onTaskState?: (value: { receipt: GenerationReceipt | null; view: GenerationTaskView | null }) => void;
    onApply: (image: CanvasGeneratedImage, receipt: GenerationReceipt, destination: "original" | "new", isOperationCurrent: () => boolean) => Promise<PlatformImageApplication>;
    onClose: () => void };
type Controller = ReturnType<typeof createCanvasImageGenerationController>;
function requestSummary(count: number, limit?: number) {
    const requests = imageRequestCounts(count, limit ?? count);
    return requests.length > 1 ? `分批：${requests.join(" + ")} 张，共 ${requests.length} 次请求` : null;
}

export function CanvasPlatformImageModal(props: Props) {
    const account = useAccountStore(), scope = account.getDraftScope();
    return <ImageDialog key={`${scope?.accountId}:${scope?.epoch}:${props.projectId}`} {...props}
        scope={scope ? { ...scope, projectId: props.projectId } : null} />;
}

/** Display the owner task's original projection, never the current model or price catalog. */
export function ImageSpecHistory({ snapshot }: { snapshot?: GenerationImageSpecSnapshot }) {
    if (!snapshot) return null;
    if (snapshot.status === "invalid") return <Alert type="warning" showIcon title="受理时图片规格无法核对"
        description="原规格快照未通过校验。请保留任务号核对原任务，不以当前模型配置补齐规格。" />;
    return <div aria-label="受理时图片规格" className="space-y-1">
        <Typography.Text strong>受理时图片规格</Typography.Text>
        {snapshot.parameters.size !== undefined ? <p>尺寸：{snapshot.parameters.size}</p> : null}
        {snapshot.parameters.quality !== undefined ? <p>质量：{snapshot.parameters.quality}</p> : null}
        {(snapshot.parameters.n ?? 1) > 1 ? <p>张数：{snapshot.parameters.n}</p> : null}
        {requestSummary(snapshot.parameters.n ?? 1, snapshot.maxImagesPerRequest) ? <p>{requestSummary(snapshot.parameters.n ?? 1, snapshot.maxImagesPerRequest)}</p> : null}
        <Typography.Paragraph type="secondary" className="!mb-0">来自原任务保存的规格，不以当前模型配置补齐。</Typography.Paragraph>
    </div>;
}

export function GeminiImageHistory({ task, delivered }: { task: GenerationTaskView["task"]; delivered?: number }) {
    const original = task.geminiImage;
    if (!original) return null;
    return <div aria-label="受理时原生图片规格" className="space-y-1">
        <Typography.Text strong>受理时图片规格</Typography.Text>
        <p>{original.parameters.imageSize} · {original.parameters.aspectRatio} · PNG</p>
        <p>每张 {original.creditsPerImage} 积分 · 原预算 {original.parameters.budgetCredits} 积分</p>
        {delivered !== undefined ? <p>已交付 {delivered} 张</p> : null}
        {task.billing ? <p>预留 {task.billing.reservedCredits} · 实扣 {task.billing.capturedCredits} · 退回 {task.billing.releasedCredits} 积分</p> : null}
        <Typography.Text type="secondary">受理时价格版本 {task.priceVersion}</Typography.Text>
    </div>;
}

function ImageDialog({ scope, ...props }: Props & { scope: GenerationScope | null }) {
    const controller = useRef<Controller | null>(null), currentProps = useRef(props), abort = useRef<AbortController | null>(null);
    currentProps.current = props;
    const [state, setState] = useState<CanvasImageGenerationState | null>(null);
    const [models, setModels] = useState<ImageMappingModel[]>([]), [loading, setLoading] = useState(true);
    const [selection, setSelection] = useState<ImageMappingSelection>(props.initialSelection ?? {}), [prompt, setPrompt] = useState(props.initialPrompt ?? "");
    const reloadModels = useRef<(() => Promise<void>) | null>(null);
    const [quotedInput, setQuotedInput] = useState<string | null>(null);
    const [budget, setBudget] = useState<number | null>(null);
    const [receipts, setReceipts] = useState<GenerationReceipt[]>([]), [readingReceipts, setReadingReceipts] = useState(false);
    const [newIntent, setNewIntent] = useState(false);
    const [notice, setNotice] = useState(""), [adding, setAdding] = useState(false), [added, setAdded] = useState(false), [protectedResult, setProtectedResult] = useState(false), [applicationBlocked, setApplicationBlocked] = useState(false);

    useLayoutEffect(() => {
        let active = true, catalogRequest = 0;
        const originRoute = window.location.pathname;
        const getContext = () => {
            const account = useAccountStore.getState(), current = account.getDraftScope();
            return active && scope && currentProps.current.isProjectCurrent() && account.site?.cloudMedia && current?.accountId === scope.accountId && current.epoch === scope.epoch ? scope : null;
        };
        if (!scope || !getContext()) { setLoading(false); setNotice("请先登录并确认云端素材服务已开放。"); return; }
        const client = createMappedImageGenerationClient({ scope, getScope: getContext });
        const next = createCanvasImageGenerationController({ client, getContext, imageTarget: props.recoveryTask?.target ?? props.imageTarget, readOnly: !!props.recoveryTask,
            beforeImageReceipt: (target, nodeId) => currentProps.current.beforeImageReceipt!(target, nodeId),
            getIntentCurrent: () => currentProps.current.isIntentCurrent?.() ?? true });
        controller.current = next;
        setState(next.getState());
        const unsubscribe = next.subscribe(() => {
            if (!active || !next.isCurrent()) return;
            const current = next.getState();
            setState(current);
            currentProps.current.onTaskState?.({ receipt: current.receipt, view: current.view });
            if (next.isCurrent() && current.phase === "tracking" && current.receipt?.taskId === current.view?.task.id && current.view) {
                const task = current.view.task;
                generationTracker.getState().register({ accountId: scope.accountId, epoch: scope.epoch, taskId: task.id,
                    projectId: scope.projectId, ...(task.nodeId ? { nodeId: task.nodeId } : {}), modelId: task.modelId, originRoute, kindHint: "image",
                    executionStatus: task.executionStatus, deliveryStatus: task.deliveryStatus, billingStatus: task.billingStatus });
            }
        });
        setReadingReceipts(true);
        void next.listReceipts().then((items) => {
            if (!next.isCurrent()) return;
            const requested = currentProps.current.recoveryTask;
            const recovery = requested ? items.find(item => item.taskId === requested.taskId && sameImageTargetBinding(item.imageTarget, requested.target))
                : currentProps.current.imageTarget ? items.find(item => item.taskId && sameImageTargetBinding(item.imageTarget, currentProps.current.imageTarget)) : undefined;
            setReceipts(items); setNewIntent(recovery ? false : !!currentProps.current.imageTarget || items.length === 0);
            if (recovery) void next.restoreReceipt(recovery);
            else if (requested) setNotice("未找到此原任务的有效本机回执，请保留任务号核对。");
        }).catch((error) => { if (next.isCurrent()) setNotice(error instanceof GenerationError ? error.message : "本机生成记录读取失败。"); })
            .finally(() => { if (active) setReadingReceipts(false); });
        reloadModels.current = async () => {
            if (!next.isCurrent()) return;
            const request = ++catalogRequest;
            next.invalidateQuote(); setQuotedInput(null); setModels([]); setSelection(currentProps.current.initialSelection ?? {}); setLoading(true); setNotice("");
            try {
                const items = await client.mappedModels();
                if (next.isCurrent() && request === catalogRequest) { setModels(items); if (!items.length) setNotice("暂无已生效的图片模型，请联系管理员完成模型配置。"); }
            } catch (error) { if (next.isCurrent() && request === catalogRequest) setNotice(error instanceof GenerationError ? error.message : "模型读取失败，请点击更新模型列表重试。"); }
            finally { if (active && request === catalogRequest) setLoading(false); }
        };
        if (props.recoveryTask) setLoading(false);
        else void reloadModels.current();
        return () => { active = false; reloadModels.current = null; unsubscribe(); next.close(); abort.current?.abort(); if (controller.current === next) controller.current = null; };
    // The keyed dialog owns one immutable account epoch and project.
    }, [scope?.accountId, scope?.epoch, scope?.projectId]);

    const close = () => { controller.current?.close(); abort.current?.abort(); props.onClose(); };
    const view = state?.view, task = view?.task;
    const completed = task?.imageSpecSnapshot?.status !== "invalid" && (!task?.geminiImage || task.billingStatus === "captured") && task?.executionStatus === "succeeded" && ["saved", "visible"].includes(task.deliveryStatus) && view?.result?.status === "succeeded" && !!view.result.resultSnapshot.media;
    const locked = !!state?.receipt || !!state?.busy || adding;
    const selectedModel = models.find(model => model.id === selection.modelId);
    const selectedSpec = selectedImageMapping(models, selection);
    const count = Number(props.localSettings?.count ?? 1);
    const native = selectedSpec?.execution.protocol === GEMINI_IMAGE_PROTOCOL;
    const parameters: GenerationParameters = selectedSpec ? selectedSpec.execution.protocol === GEMINI_IMAGE_PROTOCOL
        ? { protocol: GEMINI_IMAGE_PROTOCOL, ...selectedSpec.execution.parameters, budgetCredits: budget ?? 0 }
        : { ...selectedSpec.execution.parameters, ...(count !== 1 ? { n: count } : {}) } : {};
    const budgetValid = !native || budget !== null && Number.isSafeInteger(budget) && budget >= (selectedSpec?.credits ?? 1);
    const executableId = selectedSpec?.available ? selectedSpec.nodeModelId : undefined;
    const inputSignature = JSON.stringify({ selection, executableId, prompt, parameters, nodeId: props.imageTarget?.nodeId });
    const inputCurrent = props.isIntentCurrent?.() ?? true;
    const quoteMatches = state?.phase === "ready" && !state.intentInvalidated && inputCurrent && !!selectedSpec && quotedInput === inputSignature;
    const invalidateQuote = () => { controller.current?.invalidateQuote(); setQuotedInput(null); };
    const status = task ? ({ pending: "待处理", queued: "排队中", running: "生成中", succeeded: "生成完成", failed: "生成失败", unknown: "结果待核对", cancelled: "已取消", timeout: "结果待核对" }[task.executionStatus]) : "";
    const resultUncertain = task && (["unknown", "timeout"].includes(task.executionStatus) || task.deliveryStatus === "unknown");
    async function addImage(destination: "original" | "new" = "original") {
        const owner = controller.current;
        const reference = state?.receipt;
        if (!owner || !view || !reference || adding || !owner.isCurrent()) return;
        const operation = new AbortController();
        abort.current = operation; setAdding(true); setNotice("");
        try {
            let application: PlatformImageApplication | undefined;
            await insertGeneratedImage({ view, signal: operation.signal, isCurrent: owner.isCurrent,
                media: createMediaClient(() => owner.isCurrent() ? scope!.accountId : null),
                commit: async image => {
                    if (!owner.isCurrent()) return false;
                    application = await currentProps.current.onApply(image, reference, destination, owner.isCurrent);
                    return application.committed === true;
                } });
            if (owner.isCurrent() && application) {
                setProtectedResult(application.status === "protected");
                setApplicationBlocked(application.status === "application-uncertain");
                setAdded(!["protected", "application-uncertain"].includes(application.status));
                setNotice(application.reason ?? (application.status === "protected" ? "原目标已变化，保留现有内容。可明确选择另存新图片。"
                    : application.status === "application-uncertain" ? "落点保存状态待核对，请保留原回执；不要重复添加。"
                    : application.status === "already-applied" ? "此任务结果已保存，不会因删除节点而重新创建。" : "图片结果已保存到画布。"));
            }
        } catch (error) { if (owner.isCurrent()) setNotice(error instanceof Error ? error.message : "图片添加失败，请保留任务记录。"); }
        finally { if (owner.isCurrent()) setAdding(false); }
    }
    return <Modal open title={props.initialSelection ? "确认图片生成" : "平台生成图片"} style={{ top: 24 }} onCancel={close} styles={{ body: { maxHeight: "calc(100dvh - 200px)", overflowY: "auto" } }} footer={<Button onClick={close}>返回画布</Button>}>
        <Space orientation="vertical" className="w-full">
            <Typography.Paragraph>{props.recoveryTask ? "只读核对原任务，不会重新生成或扣费。应用结果仍检查原目标；目标变化时可明确另存。" : native ? "按实际交付张数计费，剩余预留积分退回。" : `本次生成 ${count} 张 PNG 图片。`}</Typography.Paragraph>
            {props.localSettings && !props.initialSelection ? <details><summary className="cursor-pointer text-sm">原节点设置说明</summary><Typography.Paragraph type="secondary">原设置：数量 {String(props.localSettings.count)}，模型 {props.localSettings.model || "未选择"}，比例 {props.localSettings.size}，质量 {props.localSettings.quality}。已有图片不作参考。</Typography.Paragraph></details> : null}
            {!state?.receipt && (!inputCurrent || state?.intentInvalidated) ? <Alert type="warning" showIcon title="原节点、输入或个人设置已变化，旧确认已失效；请返回原节点重新打开。" /> : null}
            {notice ? <Alert title={notice} type="info" showIcon /> : null}
            {state?.error ? <Alert title={state.error.message} type="warning" showIcon /> : null}
            {state?.phase === "failed" ? <Typography.Paragraph>本次未完成提交。返回画布，再打开此窗口可重新查看费用并确认。</Typography.Paragraph> : null}
            {state?.phase === "rejected" ? <>
                <Typography.Paragraph>本次请求未受理，未创建任务，也未冻结积分。重新查看费用后，仍需由你确认生成。</Typography.Paragraph>
                <Button onClick={() => {
                    if (controller.current?.startNew()) { setQuotedInput(null); setNewIntent(true); setNotice(""); }
                }}>重新填写并查看费用</Button>
            </> : null}
            {!props.recoveryTask && !newIntent && !state?.receipt ? <>
                <Typography.Paragraph>先从下方记录核对已有任务。若要生成另一张图片，请明确开始新的生成。</Typography.Paragraph>
                <Button disabled={loading || readingReceipts || !models.length} onClick={() => setNewIntent(true)}>开始另一张生成（另行计费）</Button>
                <Button type="text" disabled={locked || loading} onClick={() => { void reloadModels.current?.(); }}>更新模型列表</Button>
            </> : null}
            {!props.recoveryTask && newIntent ? <>
            {props.initialSelection ? <div aria-label="本次图片选择" className="space-y-1">
                <div className="flex items-center gap-2">
                    {selectedModel ? <ModelBrandIcon model={selectedModel.id} label={selectedModel.displayName} brand={selectedModel.group} /> : null}
                    <Typography.Text strong>{selectedModel?.displayName ?? (loading ? "正在核对模型…" : "所选模型已不可用")}</Typography.Text>
                </div>
                {selectedSpec ? selectedSpec.execution.protocol === GEMINI_IMAGE_PROTOCOL
                    ? <p>{selectedSpec.execution.parameters.imageSize} · {selectedSpec.execution.parameters.aspectRatio} · PNG · 每张 {selectedSpec.credits} 积分</p>
                    : <p>{selection.specification} · {selectedSpec.execution.parameters.size.replace("x", " × ")} · {{ low: "低", medium: "标准", high: "高" }[selectedSpec.execution.parameters.quality]}画质 · {count} 张 · PNG</p>
                    : !loading ? <p role="alert">所选模型或规格已变化，请返回图片节点重新选择。</p> : null}
            </div> : <>
                <Button type="text" size="small" disabled={locked || loading} onClick={() => { void reloadModels.current?.(); }}>更新模型列表</Button>
                <ImageMappingFields models={models} selection={selection} loading={loading} disabled={locked}
                    onChange={value => { invalidateQuote(); setSelection(value); }} />
            </>}
            <label htmlFor="platform-image-prompt">完整画面描述{props.imageTarget ? "（原节点冻结输入，只读）" : ""}</label>
            <Input.TextArea id="platform-image-prompt" value={prompt} readOnly={!!props.imageTarget} disabled={locked || !models.length} onChange={(event) => { invalidateQuote(); setPrompt(event.target.value); }} autoSize placeholder="描述你想生成的图片" />
            {native ? <div className="space-y-1">
                <label htmlFor="platform-image-budget">本次费用上限（积分）</label>
                <InputNumber id="platform-image-budget" aria-label="本次费用上限（积分）" className="!w-full" min={selectedSpec?.credits} changeOnBlur={false}
                    value={budget} disabled={locked} placeholder={`至少 ${selectedSpec?.credits} 积分`} onChange={value => { invalidateQuote(); setBudget(value); }} />
                {budget !== null && !budgetValid ? <p role="alert">费用上限须为整数，且至少为 {selectedSpec?.credits} 积分。</p> : null}
                <Typography.Text type="secondary">每张 {selectedSpec?.credits} 积分；张数由本次返回结果决定。超出预算时待核对。</Typography.Text>
            </div> : null}
            {!state?.receipt ? <Button disabled={locked || loading || !budgetValid || !inputCurrent || !!state?.intentInvalidated || !executableId || !prompt.trim()} loading={state?.phase === "preparing"} onClick={() => {
                if (!executableId) return; setQuotedInput(inputSignature); void controller.current?.prepare({ modelId: executableId, prompt, parameters, ...(props.imageTarget ? { nodeId: props.imageTarget.nodeId } : {}) });
            }}>查看费用（不扣费）</Button> : null}
            </> : null}
            {quoteMatches && state?.quote ? <div role="status">
                <Typography.Paragraph strong>{state.quote.billingUnit === "image" ? `每张 ${state.quote.creditsPerUnit} 积分 · 本次最多 ${state.quote.quotedUnits} 积分`
                    : `生成 ${state.quote.imageSpec?.parameters.n ?? 1} 张图片 · 本次 ${state.quote.quotedUnits} 积分`}</Typography.Paragraph>
                {state.quote.imageSpec && requestSummary(state.quote.imageSpec.parameters.n ?? 1, state.quote.imageSpec.maxImagesPerRequest) ?
                    <Typography.Paragraph>{requestSummary(state.quote.imageSpec.parameters.n ?? 1, state.quote.imageSpec.maxImagesPerRequest)}</Typography.Paragraph> : null}
                {state.quote.imageSpec ? <Typography.Paragraph>本次明确规格：{Object.entries(state.quote.imageSpec.parameters).map(([key, value]) => `${key === "size" ? "尺寸" : key === "n" ? "张数" : "质量"} ${value}`).join(" · ")} · PNG</Typography.Paragraph> : null}
                {state.quote.priceNote ? <Typography.Paragraph className="whitespace-pre-wrap break-words">{state.quote.priceNote}</Typography.Paragraph> : null}
                <Typography.Paragraph type="secondary">价格版本 {state.quote.priceVersion} · 确认后冻结上述积分，任务按此版本结算。失败是否退回以任务结算状态为准。</Typography.Paragraph>
                <Button type="primary" disabled={locked} onClick={() => { void controller.current?.confirm(); }}>{state.quote.billingUnit === "image" ? "确认并预留" : "确认生成"}（{state.quote.quotedUnits} 积分）</Button>
            </div> : null}
            {state?.receipt ? <div className="space-y-2">
                <Typography.Paragraph className="break-all">{state.receipt.rejection ? "未受理请求回执" : "任务回执"}：{state.receipt.taskId || state.receipt.idempotencyKey}</Typography.Paragraph>
                <p role="status">{task ? `${status} · ${task.billingStatus === "captured" ? "已结算" : task.billingStatus === "released" ? "积分已退回" : task.billingStatus === "pending_review" ? "结算待核对" : "结算处理中"}` : state.phase === "rejected" ? "本次请求未受理" : state.phase === "failed" ? "本次未创建新任务" : "提交结果待核对"}</p>
                <ImageSpecHistory snapshot={task?.imageSpecSnapshot} />
                {task ? <GeminiImageHistory task={task} delivered={view?.result?.resultSnapshot.media ? view.result.consumedUnits : undefined} /> : null}
                {task?.imageSpecSnapshot?.status === "recorded" ? <Typography.Paragraph type="secondary">受理时价格版本 {task.priceVersion} · 原任务报价 {task.quotedUnits} 积分</Typography.Paragraph> : null}
                {task?.executionStatus === "failed" && task.billingStatus === "released" && !resultUncertain ? <Typography.Paragraph>本次冻结积分已退回；再次生成需重新查看并确认费用。</Typography.Paragraph>
                    : task && (resultUncertain || task.billingStatus === "pending_review") ? <Typography.Paragraph>
                        {resultUncertain ? "结果尚未确认" : "任务结算尚未确认"}，{task.billingStatus === "captured" ? "积分已结算" : task.billingStatus === "released" ? "本次冻结积分已退回" : "积分仍待核对"}；先查询原任务，长期未更新保留任务号联系管理员。不要重复生成。
                    </Typography.Paragraph> : null}
                {state.phase !== "failed" && state.phase !== "rejected" ? <Button loading={state.busy} disabled={state.busy || adding} onClick={() => { void controller.current?.refresh(); }}>查看进度 / 核对原请求</Button> : null}
                {state.receipt.application ? <Typography.Paragraph>{state.receipt.application === "applied" ? "此任务结果已落画布，删除或刷新不会重新创建。" : "结果落点保存待核对，不会重复添加。"}</Typography.Paragraph> : null}
                {completed ? <Button type="primary" loading={adding} disabled={adding || added || applicationBlocked || state.busy || !!state.receipt.application} onClick={() => { void addImage(); }}>{added || state.receipt.application === "applied" ? "此任务已保存" : state.receipt.imageTarget?.sourceType === "config" ? "保存到原 Config 旁并连线" : state.receipt.imageTarget ? "应用到原目标（已有内容另存）" : "另存到当前画布"}</Button> : null}
                {completed && protectedResult ? <Button disabled={adding || added || applicationBlocked || state.busy || !!state.receipt.application} onClick={() => { void addImage("new"); }}>明确另存新图片（不覆盖、不连接已变目标）</Button> : null}
                <Typography.Paragraph type="secondary">{state.receipt.rejection ? "未受理原因已保存在本机，关闭或刷新后仍可查看。" : "关闭窗口不会取消已提交的生成。返回本画布后，可从下方记录继续查询。"}</Typography.Paragraph>
            </div> : null}
            <Button type="text" loading={readingReceipts} disabled={!controller.current || !!state?.busy || adding || readingReceipts} onClick={async () => {
                const owner = controller.current; if (!owner) return; setReadingReceipts(true);
                try { const items = await owner.listReceipts(); if (owner.isCurrent()) { setReceipts(items); if (!items.length) setNotice("本画布还没有生成记录。"); } }
                catch (error) { if (owner.isCurrent()) setNotice(error instanceof GenerationError ? error.message : "记录读取失败。"); }
                finally { if (owner.isCurrent()) setReadingReceipts(false); }
            }}>读取本画布的生成记录</Button>
            {receipts.map((receipt) => <div key={receipt.idempotencyKey} className="flex items-center gap-2">
                <Typography.Text className="min-w-0 flex-1 break-all">{receipt.taskId || receipt.idempotencyKey}</Typography.Text>
                {receipt.rejection ? <Typography.Text type="secondary">{receipt.rejection === "price_changed" ? "未受理：价格已变化" : "未受理：积分不足"}</Typography.Text> : null}
                <Button disabled={!!state?.busy || !!state?.receipt || adding} onClick={() => { setAdded(false); void controller.current?.restoreReceipt(receipt); }}>{receipt.rejection ? "查看未受理记录" : "查询此任务"}</Button>
            </div>)}
            {receipts.length > 0 && state?.receipt ? <Typography.Text type="secondary">查询其他任务，请关闭并重新打开此窗口。</Typography.Text> : null}
        </Space>
    </Modal>;
}
