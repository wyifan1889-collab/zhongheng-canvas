import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Collapse, Input, Modal, Space, Typography } from "antd";
import { normalizeCreditAmount, compareCreditAmounts } from "../../../../packages/shared/src/credit-amounts";
import { useAccountStore } from "@/stores/use-account-store";
import { GenerationError, type GenerationScope } from "@/services/saas/generation";
import { createTextGenerationClient, type TextGenerationModel, type TextQuoteSnapshot, type TextGenerationTaskView } from "@/services/saas/text-generation";
import { createCanvasTextGenerationController, type CanvasTextGenerationState } from "@/services/saas/canvas-text-generation";
import type { TextConfigBinding, TextGenerationReceipt, TextTargetBinding } from "@/services/saas/canvas-text-receipt";
import { generationTracker } from "@/stores/use-generation-tracker";
import { ModelBrandIcon } from "@/components/model-brand-icon";

export type PlatformTextApplication = { status: "filled" | "added-linked" | "saved-new" | "already-applied" | "application-uncertain" | "protected"; reason?: string; saved?: boolean };
type Props = {
    projectId: string; isProjectCurrent: () => boolean; onClose: () => void;
    initialPrompt?: string; target?: TextTargetBinding; beforeTargetReceipt?: (target: TextTargetBinding) => Promise<void>;
    configTarget?: TextConfigBinding; beforeConfigReceipt?: (target: TextConfigBinding) => Promise<void>; isConfigIntentCurrent?: () => boolean;
    onInsert?: (value: { taskId: string; text: string }) => boolean;
    onApply?: (value: { taskId: string; text: string; target?: TextTargetBinding; configTarget?: TextConfigBinding; receipt?: TextGenerationReceipt }, destination: "original" | "new", isOperationCurrent: () => boolean) => Promise<PlatformTextApplication>;
};
type Controller = ReturnType<typeof createCanvasTextGenerationController>;
export function TextRateLines({ rates }: { rates: Pick<TextQuoteSnapshot, "inputCreditsPerMillion" | "cachedInputCreditsPerMillion" | "outputCreditsPerMillion"> }) {
    const cached = rates.cachedInputCreditsPerMillion !== undefined;
    return <>
        <Typography.Paragraph>{cached ? "非缓存输入" : "输入"}：{rates.inputCreditsPerMillion} 积分 / 百万 Token<br />
            {cached && <>缓存读取：{rates.cachedInputCreditsPerMillion} 积分 / 百万 Token<br /></>}输出：{rates.outputCreditsPerMillion} 积分 / 百万 Token</Typography.Paragraph>
        <Typography.Paragraph type="secondary">{cached ? "输入总量减去缓存读取后按非缓存输入计价，缓存读取单独计价；输出包含推理，不重复累加。须明确返回缓存读取和写入计数，且写入为 0；明细缺失或出现写入时费用待核对。" : "本价目按全部输入和全部输出计量，缓存读取含在输入中，推理含在输出中，不重复累加。"}</Typography.Paragraph>
    </>;
}
export function TextBillingExplanationLines({ task }: { task: TextGenerationTaskView["task"] }) {
    const explanation = task.textBillingExplanation;
    if (!explanation || explanation.policy === "invalid") return <Typography.Paragraph type="secondary">原任务计费说明暂无法核对；以上是确认时费率基准，不能据此认定实际结算档位或费用。</Typography.Paragraph>;
    const quantities = explanation.quantities;
    return <>
        <Typography.Paragraph type="secondary">原价格版本 {explanation.priceVersion} · {explanation.policy === "context_tiers"
            ? `本平台按输入与输出总量判档，272000 Token 及以下为短档，超过为长档。实际${explanation.tier === "short" ? "采用短档" : explanation.tier === "long" ? "采用长档" : "档位尚无法核对"}。`
            : "沿用本任务原固定费率，不追溯切档。"}</Typography.Paragraph>
        {explanation.totalTokens !== null && <Typography.Paragraph type="secondary">实际总量 {explanation.totalTokens} Token（输入 + 输出；缓存与推理子集不重复累加）</Typography.Paragraph>}
        {explanation.rates ? <><Typography.Paragraph strong>本任务实际采用的{explanation.tier === "long" ? "长档" : explanation.tier === "short" ? "短档" : "固定"}费率</Typography.Paragraph><TextRateLines rates={explanation.rates} /></>
            : <Typography.Paragraph type="secondary">用量或原档位证据不足，实际费率和应扣金额尚无法核对。</Typography.Paragraph>}
        {quantities && <Typography.Paragraph type="secondary">计量：输入总量 {quantities.inputTokens} Token{explanation.rates?.cachedInputCreditsPerMillion !== undefined && quantities.cachedInputTokens !== null
            ? `，其中非缓存输入 ${quantities.inputTokens - quantities.cachedInputTokens} Token、缓存读取 ${quantities.cachedInputTokens} Token` : ""}；输出 {quantities.outputTokens} Token。</Typography.Paragraph>}
        {explanation.expectedCredits !== null && <Typography.Paragraph>按原版本计量应扣 {explanation.expectedCredits} 积分（计算结果，不代表已经扣款）</Typography.Paragraph>}
    </>;
}
export function CanvasPlatformTextModal(props: Props) {
    const account = useAccountStore(), scope = account.getDraftScope();
    return <TextDialog key={`${scope?.accountId}:${scope?.epoch}:${props.projectId}`} {...props} scope={scope ? { ...scope, projectId: props.projectId } : null} />;
}
function TextDialog({ scope, ...props }: Props & { scope: GenerationScope | null }) {
    const controller = useRef<Controller | null>(null), currentProps = useRef(props); currentProps.current = props;
    const [state, setState] = useState<CanvasTextGenerationState | null>(null), [models, setModels] = useState<TextGenerationModel[]>([]);
    const [loading, setLoading] = useState(true), [modelId, setModelId] = useState<string>(), [prompt, setPrompt] = useState(() => props.initialPrompt ?? "");
    const [budget, setBudget] = useState(""), [query, setQuery] = useState(""), [expanded, setExpanded] = useState<string[]>([]);
    const [quotedInput, setQuotedInput] = useState<{ modelId: string; prompt: string; budgetCredits: string } | null>(null);
    const [receipts, setReceipts] = useState<TextGenerationReceipt[]>([]), [reading, setReading] = useState(false), [newIntent, setNewIntent] = useState(false);
    const [notice, setNotice] = useState(""), [added, setAdded] = useState(false), [protectedTarget, setProtectedTarget] = useState(false), [applying, setApplying] = useState(false);
    useLayoutEffect(() => {
        let active = true;
        const originRoute = window.location.pathname;
        const getContext = () => {
            const current = useAccountStore.getState().getDraftScope();
            return active && scope && currentProps.current.isProjectCurrent() && current?.accountId === scope.accountId && current.epoch === scope.epoch ? scope : null;
        };
        if (!scope || !getContext()) { setLoading(false); setNotice("请先登录，再从当前画布打开文本生成。"); return; }
        const client = createTextGenerationClient({ scope, getScope: getContext }), next = createCanvasTextGenerationController({ client, getContext,
            ...(props.configTarget ? { configTarget: props.configTarget, getIntentCurrent: () => currentProps.current.isConfigIntentCurrent?.() === true,
                beforeConfigReceipt: (target: TextConfigBinding) => currentProps.current.beforeConfigReceipt?.(target) ?? Promise.reject(new Error("原配置保护尚未就绪，未提交生成。")) } : {}),
            ...(props.target ? { target: props.target, beforeTargetReceipt: (target: TextTargetBinding) => currentProps.current.beforeTargetReceipt?.(target) ?? Promise.reject(new Error("目标保护尚未就绪，请保留创作要求。")) } : {}) });
        controller.current = next; setState(next.getState());
        const unsubscribe = next.subscribe(() => {
            if (!active) return;
            const current = next.getState();
            setState(current);
            if (next.isCurrent() && current.phase === "tracking" && current.receipt?.taskId === current.view?.task.id && current.view) {
                const task = current.view.task;
                generationTracker.getState().register({ accountId: scope.accountId, epoch: scope.epoch, taskId: task.id,
                    projectId: scope.projectId, modelId: task.modelId, originRoute, kindHint: "text",
                    executionStatus: task.executionStatus, deliveryStatus: task.deliveryStatus, billingStatus: task.billingStatus });
            }
        });
        setReading(true);
        void next.listReceipts().then(items => { if (next.isCurrent()) { setReceipts(items); setNewIntent(items.length === 0); } })
            .catch(() => { if (next.isCurrent()) setNotice("本机文本任务回执读取失败，请保留原任务编号核对。"); }).finally(() => { if (active) setReading(false); });
        void client.models().then(items => { if (next.isCurrent()) { setModels(items); if (!items.length) setNotice("暂无已开放且已定价的文本模型，请管理员完成渠道、分组和价格配置。"); } })
            .catch(error => { if (next.isCurrent()) setNotice(error instanceof GenerationError ? error.message : "文本模型读取失败。"); }).finally(() => { if (active) setLoading(false); });
        return () => { active = false; unsubscribe(); next.close(); if (controller.current === next) controller.current = null; };
    }, [scope?.accountId, scope?.epoch, scope?.projectId]);
    const close = () => { controller.current?.close(); props.onClose(); };
    const configIntentChanged = !!props.configTarget && props.isConfigIntentCurrent?.() !== true;
    useLayoutEffect(() => { if (configIntentChanged) { controller.current?.invalidateIntent(); setQuotedInput(null); } }, [configIntentChanged]);
    const task = state?.view?.task, result = state?.view?.result;
    const locked = !!state?.receipt || !!state?.busy, budgetValue = normalizeCreditAmount(budget);
    const inputBlocked = !!state?.intentInvalidated || configIntentChanged;
    const validBudget = budgetValue !== null && compareCreditAmounts(budgetValue, "0") > 0;
    const quoteMatches = !inputBlocked && state?.phase === "ready" && quotedInput?.modelId === modelId && quotedInput?.prompt === prompt && quotedInput?.budgetCredits === budget;
    const search = query.trim().toLocaleLowerCase(), groups = new Map<string, { key: string; name: string; order: number; items: TextGenerationModel[] }>();
    for (const model of models) {
        if (search && ![model.id, model.displayName, model.group?.name ?? "其他模型"].some(value => value.toLocaleLowerCase().includes(search))) continue;
        const key = model.group?.id ?? "ungrouped", group = groups.get(key) ?? { key, name: model.group?.name ?? "其他模型", order: model.group?.order ?? Number.MAX_SAFE_INTEGER, items: [] };
        group.items.push(model); groups.set(key, group);
    }
    const grouped = [...groups.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
    const selected = models.find(model => model.id === modelId), usage = result?.resultSnapshot.usageEvidence;
    const canInsert = !state?.receipt?.application && task?.executionStatus === "succeeded" && ["saved", "visible"].includes(task.deliveryStatus) && result?.status === "succeeded" && result.resultSnapshot.kind === "text" && !!result.resultSnapshot.text?.trim();
    const execution = task ? ({ pending: "待处理", queued: "排队中", running: "生成中", succeeded: "生成完成", failed: "生成失败", unknown: "结果待核对", cancelled: "已取消", timeout: "结果待核对" }[task.executionStatus]) : "提交结果待核对";
    const settlement = task && !task.billing ? "账务待核对" : task ? ({ unbilled: "结算处理中", reserved: "预算已冻结", captured: "已按实耗结算", released: "冻结积分已退回", pending_review: "结算待核对" }[task.billingStatus]) : "";
    const apply = async (destination: "original" | "new") => {
        const owner = controller.current, text = result?.resultSnapshot.text, target = state?.receipt?.textTarget, configTarget = state?.receipt?.configTarget;
        if (!owner?.isCurrent() || !task || !text || applying || added) return;
        setApplying(true);
        try {
            if (!currentProps.current.onApply) {
                if (target || configTarget || destination === "original" || !currentProps.current.onInsert) throw new Error("此回执需要原画布目标保护，请保留回执后回到原画布核对。");
                const inserted = currentProps.current.onInsert({ taskId: task.id, text });
                if (owner.isCurrent()) { setAdded(true); setNotice(inserted ? "文本已添加到当前画布，请查看本地保存状态。" : "这份文本已在当前画布中，保留现有编辑。"); }
                return;
            }
            const outcome = await currentProps.current.onApply({ taskId: task.id, text, ...(target ? { target } : {}),
                ...(configTarget ? { configTarget, receipt: state!.receipt! } : {}) }, destination, owner.isCurrent);
            if (!owner.isCurrent()) return;
            if (outcome.status === "protected") { setProtectedTarget(true); setNotice(outcome.reason || "原节点已变化，已保留现有内容。可手动另存结果。"); return; }
            if (outcome.status === "application-uncertain") { setAdded(true); setNotice("本机落结果状态待核对，请保留回执和文本并查看原画布保存状态，不会重复添加。"); return; }
            setAdded(true); setProtectedTarget(false);
            const action = outcome.status === "filled" ? "结果已填回原节点。" : outcome.status === "added-linked" ? "文本已新增并连接原配置节点。" : outcome.status === "saved-new" ? "结果已另存为新文本节点。" : "该任务已处理，保留现有编辑。";
            setNotice(action + (outcome.saved === true ? "本地保存完成。" : "本地保存尚未确认，请保留本页并查看画布保存状态；此处不代表云保存。"));
        } catch (error) { if (owner.isCurrent()) setNotice(error instanceof Error ? error.message : "结果写入未完成，请保留任务回执。"); }
        finally { if (owner.isCurrent()) setApplying(false); }
    };
    return <Modal open title="平台生成文本" onCancel={close} footer={<Button onClick={close}>返回画布</Button>}>
        <Space orientation="vertical" className="w-full">
            <Typography.Paragraph>选择文本模型，填写本次预算并查看费率。确认后先冻结预算，成功后按实际用量结算，退回剩余积分。</Typography.Paragraph>
            {props.target && !state?.receipt && <Typography.Paragraph type="secondary">本次生成一份纯文本，结果填回发起的空白节点；生成期间正文若被编辑，将保留编辑并由你选择另存。个人型号、推理和批量配置不带入。</Typography.Paragraph>}
            {props.configTarget && !state?.receipt && <Typography.Paragraph type="secondary">本次使用已预览的完整文本，成功后在原配置旁新增文本并连线，保留配置与已有内容。源要求、引用或设置变化后须返回重新预览。</Typography.Paragraph>}
            {inputBlocked && !state?.receipt?.taskId && <Alert type="warning" showIcon title="原输入已变化，旧意图与报价已失效。请返回画布重新预览；已有回执仍可核对。" />}
            {notice && <Alert title={notice} type="info" showIcon />}
            {state?.error && <Alert title={state.error.message} type="warning" showIcon />}
            {!newIntent && !state?.receipt && <><Typography.Text>可先核对下方已有任务；新生成会另行计费。</Typography.Text><Button disabled={inputBlocked || loading || reading || !models.length} onClick={() => setNewIntent(true)}>开始新的文本生成</Button></>}
            {state?.phase === "rejected" && <><Typography.Text>本次请求未受理，没有新任务或冻结。重新查看费用后仍需确认。</Typography.Text><Button onClick={() => { if (controller.current?.startNew()) { setQuotedInput(null); setNewIntent(true); } }}>重新填写并查看费用</Button></>}
            {newIntent && <>
                <Input aria-label="搜索文本模型或分组" placeholder="搜索模型名称、型号或分组" allowClear value={query} disabled={inputBlocked || locked || loading} onChange={event => setQuery(event.target.value)} />
                <Typography.Text type="secondary">{selected ? `已选：${selected.displayName}（${selected.id}）` : "展开分组并选择文本模型"}</Typography.Text>
                {loading ? <Typography.Text>正在读取文本模型…</Typography.Text> : grouped.length ? <Collapse size="small" activeKey={search ? grouped.map(group => group.key) : expanded} onChange={keys => { if (!search) setExpanded(typeof keys === "string" ? [keys] : keys); }}
                    items={grouped.map(group => ({ key: group.key, label: `${group.name}（${group.items.length}）`, children: <Space orientation="vertical" className="w-full">{group.items.map(model => <Button key={model.id} block className="h-auto text-left whitespace-normal" type={model.id === modelId ? "primary" : "default"} disabled={inputBlocked || locked} aria-pressed={model.id === modelId} onClick={() => { setQuotedInput(null); setModelId(model.id); }}><ModelBrandIcon model={model.id} label={model.displayName} /><span className="block w-full min-w-0 break-words">{model.displayName}<span className="block text-xs opacity-80">{model.id}</span></span></Button>)}</Space> }))} /> : <Typography.Text type="secondary">暂无匹配的可用文本模型。</Typography.Text>}
                <label htmlFor="platform-text-prompt">创作要求</label><Input.TextArea id="platform-text-prompt" value={prompt} readOnly={!!props.configTarget} disabled={inputBlocked || locked || !models.length} onChange={event => { setQuotedInput(null); setPrompt(event.target.value); }} autoSize placeholder="描述你希望生成的文本" />
                <label htmlFor="platform-text-budget">本次预算（积分）</label><Input id="platform-text-budget" inputMode="decimal" value={budget} disabled={inputBlocked || locked || !models.length} onChange={event => { setQuotedInput(null); setBudget(event.target.value); }} placeholder="填写本次同意冻结的积分，可用小数" />
                <Typography.Text type="secondary">预算是本次同意冻结的金额，不是固定售价，也不保证供应商在此金额停止生成。用量缺失或超预算时转为待核对，不会自动追加扣款。</Typography.Text>
                {!state?.receipt && <Button disabled={inputBlocked || locked || !modelId || !prompt.trim() || !validBudget} loading={state?.phase === "preparing"} onClick={() => { if (!modelId) return; const input = { modelId, prompt, budgetCredits: budget }; setQuotedInput(input); void controller.current?.prepare(input); }}>查看费用</Button>}
            </>}
            {quoteMatches && state?.quote && <div role="status"><Typography.Paragraph strong>本次先冻结 {state.quote.budgetCredits} 积分</Typography.Paragraph>
                <Typography.Paragraph type="secondary">确认报价费率基准</Typography.Paragraph>
                <TextRateLines rates={state.quote} />
                <Typography.Paragraph type="secondary">价格版本 {state.quote.priceVersion}。</Typography.Paragraph>
                {state.quote.textPriceDerivation && <Typography.Paragraph type="secondary">官方基价 × 渠道模型倍率 {state.quote.textPriceDerivation.saleMultiplier} × 100 积分；美元与人民币按数值 1:1 计价。来源 {state.quote.textPriceDerivation.sourceId} · 基准版本 {state.quote.textPriceDerivation.sourceVersion}。本次报价采用上述已发布版本。</Typography.Paragraph>}
                {state.quote.priceNote && <Typography.Paragraph className="whitespace-pre-wrap break-words">{state.quote.priceNote}</Typography.Paragraph>}
                <Button type="primary" disabled={locked} onClick={() => { void controller.current?.confirm(); }}>确认生成并冻结 {state.quote.budgetCredits} 积分</Button></div>}
            {state?.receipt && <div className="space-y-2"><Typography.Paragraph className="break-all">任务回执：{state.receipt.taskId ?? state.receipt.idempotencyKey}</Typography.Paragraph><p role="status">{execution}{settlement && ` · ${settlement}`}</p>
                {task && <><Typography.Paragraph type="secondary">模型 {task.modelId} · 价格版本 {task.priceVersion} · 确认时费率基准</Typography.Paragraph><TextRateLines rates={task.textQuoteSnapshot} /><TextBillingExplanationLines task={task} /></>}
                {task?.billing && <Typography.Paragraph>初始冻结预算 {task.billing.reservedCredits} 积分 · 已扣 {task.billing.capturedCredits} 积分 · 已退回 {task.billing.releasedCredits} 积分</Typography.Paragraph>}
                {usage && <Typography.Paragraph type="secondary">{usage.status === "complete" ? `输入 ${usage.inputTokens} Token，输出 ${usage.outputTokens} Token` : "实际用量不完整，暂不能确认费用。"}{usage.cachedInputTokens !== null && `；其中缓存读取 ${usage.cachedInputTokens}`}{usage.cacheWriteTokens !== undefined && `；缓存写入 ${usage.cacheWriteTokens}`}{usage.reasoningOutputTokens !== null && `；其中推理 ${usage.reasoningOutputTokens}`}</Typography.Paragraph>}
                {task && (!task.billing || task.billingStatus === "pending_review" || ["unknown", "timeout"].includes(task.executionStatus)) && <Alert type="warning" title="结果或费用待核对" description="保留任务编号并查询原任务，不会自动追加扣款。请勿重复生成；长期未更新可联系管理员。" />}
                {state.phase !== "rejected" && state.phase !== "failed" && <Button disabled={state.busy} loading={state.busy} onClick={() => { void controller.current?.refresh(); }}>查看进度 / 核对原请求</Button>}
                {canInsert && <><Typography.Paragraph className="whitespace-pre-wrap break-words" style={{ maxHeight: 240, overflow: "auto" }}>{result?.resultSnapshot.text}</Typography.Paragraph>
                    {state.receipt.configTarget && <Typography.Text type="secondary">此回执的原配置：{state.receipt.configTarget.nodeId}。恢复不会绑定当前选择。</Typography.Text>}
                    {state.receipt.textTarget && <Typography.Text type="secondary">此回执的原目标：{state.receipt.textTarget.nodeId}。重新打开入口不会改变目标。</Typography.Text>}
                    <Button type="primary" disabled={added || state.busy || applying || protectedTarget} loading={applying} onClick={() => { void apply(state.receipt?.textTarget || state.receipt?.configTarget ? "original" : "new"); }}>{added ? "任务结果已处理" : state.receipt.configTarget ? "新增文本并连接原配置节点" : state.receipt.textTarget ? "填回原空白文本节点" : "添加到当前画布"}</Button>
                    {protectedTarget && !added && <Button disabled={state.busy || applying} loading={applying} onClick={() => { void apply("new"); }}>{state.receipt.configTarget ? "另存文本（不连接配置）" : "另存为新文本节点"}</Button>}
                </>}
                {state.receipt.application && <><Alert type={state.receipt.application === "pending" ? "warning" : "info"} showIcon title={state.receipt.application === "pending"
                    ? "本机落结果状态待核对，请核对原画布保存状态，不会重复添加。" : "本任务已处理；后续编辑或删除结果不会被重复查询覆盖或重建。"} />
                    <Typography.Paragraph className="whitespace-pre-wrap break-words">{result?.resultSnapshot.text}</Typography.Paragraph></>}
                <Typography.Text type="secondary">关闭不会取消已提交任务。再次打开本画布的文本生成，可以凭回执继续查询。</Typography.Text>
            </div>}
            <Button type="text" disabled={!controller.current || !!state?.busy || reading} loading={reading} onClick={async () => { const owner = controller.current; if (!owner) return; setReading(true); try { const items = await owner.listReceipts(); if (owner.isCurrent()) setReceipts(items); } catch { if (owner.isCurrent()) setNotice("回执读取失败，请保留任务编号。"); } finally { if (owner.isCurrent()) setReading(false); } }}>读取本画布的文本生成记录</Button>
            {receipts.map(receipt => <div key={receipt.idempotencyKey} className="flex items-center gap-2"><Typography.Text className="min-w-0 flex-1 break-all">{receipt.taskId ?? receipt.idempotencyKey}</Typography.Text><Button disabled={!!state?.busy || !!state?.receipt} onClick={() => { setAdded(false); setProtectedTarget(false); void controller.current?.restoreReceipt(receipt); }}>{receipt.rejection ? "查看未受理记录" : "查询此任务"}</Button></div>)}
        </Space>
    </Modal>;
}
