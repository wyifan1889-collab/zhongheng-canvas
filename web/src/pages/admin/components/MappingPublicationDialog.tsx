import { useEffect, useRef, useState } from "react";
import { Alert, Button, Card, Modal, Space, Tag, Typography } from "antd";
import { createMappingPublicationClient } from "@/services/saas/model-mapping-publication";
import { getAdminGenerationScope, PlatformServiceError } from "@/services/saas/platform";
import type { MappingPublicationPreview, MappingPublicationReceipt, MappingPublicationWrite } from "../../../../../packages/shared/src/model-mapping-publications";
import { PRICE_METERS, PRICE_TEMPLATES, type ModelPriceRules } from "../../../../../packages/shared/src/model-pricing-drafts";

const fields: Record<string, string> = { size: "尺寸", quality: "画质", mode: "模式", resolution: "分辨率", durationSeconds: "秒数", generateAudio: "声音", aspectRatio: "比例" };
const values: Record<string, string> = { high: "高", medium: "中", low: "低", text: "文生视频", first_frame: "首帧生视频", true: "开启", false: "关闭" };
function PriceLines({ rules, scalar }: { rules: ModelPriceRules | null; scalar?: number | null }) {
    if (!rules) return <Typography.Text type="secondary">{scalar ? `${scalar} 积分` : "尚无价格记录"}</Typography.Text>;
    return <div className="space-y-2"><Typography.Text type="secondary">{PRICE_TEMPLATES[rules.sale.template].label}</Typography.Text>{rules.sale.bands.map((band, index) => <div key={index} className="break-words">
        <div>{Object.entries(band.parameters).map(([key, value]) => `${fields[key] ?? key} ${values[value] ?? value}`).join(" · ") || "默认规格"}</div>
        <Typography.Text strong>{Object.entries(band.rates).map(([key, value]) => `${value ?? "未定价"} 积分 / ${PRICE_METERS[key as keyof typeof PRICE_METERS].unit}`).join(" · ")}</Typography.Text>
    </div>)}</div>;
}

export default function MappingPublicationDialog({ open, draftVersion, onClose, onPublished }: {
    open: boolean; draftVersion: number; onClose: () => void; onPublished: (receipt: MappingPublicationReceipt) => void;
}) {
    const [preview, setPreview] = useState<MappingPublicationPreview | null>(null), [result, setResult] = useState<MappingPublicationReceipt | null>(null);
    const [busy, setBusy] = useState<"read" | "publish" | null>(null), [error, setError] = useState("");
    const client = useRef<ReturnType<typeof createMappingPublicationClient> | null>(null), pending = useRef(false);
    const attempt = useRef<MappingPublicationWrite | null>(null), notified = useRef(0), callback = useRef(onPublished); callback.current = onPublished;
    const live = (owner: NonNullable<typeof client.current>) => client.current === owner && owner.isCurrent();
    function applied(receipt: MappingPublicationReceipt) {
        setResult(receipt);
        if (receipt.version !== notified.current) { notified.current = receipt.version; callback.current(receipt); }
    }
    async function read() {
        const owner = client.current;
        if (!owner || !live(owner) || pending.current) return;
        pending.current = true; setBusy("read"); setError(""); setPreview(null); setResult(null);
        try {
            const next = await owner.load(); if (!next || !live(owner)) return;
            setPreview(next);
            const sent = attempt.current;
            if (sent && next.current?.fingerprint === sent.fingerprint && next.current.draftVersion === sent.expectedDraftVersion && next.current.version === sent.expectedPublicationVersion + 1) applied(next.current);
            attempt.current = null;
        } catch (failure) { if (live(owner)) setError(failure instanceof PlatformServiceError ? failure.message : "读取未完成，请重新核对。"); }
        finally { if (live(owner)) { pending.current = false; setBusy(null); } }
    }
    useEffect(() => {
        const scope = getAdminGenerationScope(); if (!scope) return;
        const owner = createMappingPublicationClient({ scope, getScope: getAdminGenerationScope }); client.current = owner;
        return () => { owner.close(); if (client.current === owner) { client.current = null; pending.current = false; } };
    }, []);
    useEffect(() => { if (open) void read(); }, [open]);
    async function publish() {
        const owner = client.current;
        if (!owner || !live(owner) || pending.current || !preview || result || error || preview.issues.length || preview.draftVersion !== draftVersion) return;
        const write = { expectedDraftVersion: preview.draftVersion, expectedPublicationVersion: preview.publicationVersion, fingerprint: preview.fingerprint };
        attempt.current = write; pending.current = true; setBusy("publish"); setError("");
        try { const receipt = await owner.publish(write); if (receipt && live(owner)) { applied(receipt); attempt.current = null; } }
        catch (failure) { if (live(owner)) { setPreview(null); setError(failure instanceof PlatformServiceError ? failure.message : "生效结果尚未确认，请读取回执核对。"); } }
        finally { if (live(owner)) { pending.current = false; setBusy(null); } }
    }
    return <Modal getContainer={false} open={open} title="核对模型与积分" width={820} style={{ top: 24 }} styles={{ body: { maxHeight: "calc(100dvh - 200px)", overflowY: "auto", overflowX: "hidden" } }}
        onCancel={onClose} closable={!busy} maskClosable={!busy} keyboard={!busy}
        footer={<Space wrap><Button disabled={!!busy} onClick={onClose}>{result ? "完成" : "返回配置"}</Button><Button loading={busy === "read"} disabled={!!busy} onClick={() => void read()}>重新读取核对</Button>
            <Button type="primary" loading={busy === "publish"} disabled={!!busy || !!error || !!result || !preview || !!preview.issues.length || preview.draftVersion !== draftVersion} onClick={() => void publish()}>确认生效</Button></Space>}>
        <div className="space-y-4">
            <Typography.Paragraph>本次将保存的模型配置与各规格积分一起生效。生效影响后续报价，已提交任务继续使用原价格；本操作不生成内容，也不扣积分。</Typography.Paragraph>
            {error && <Alert type="warning" showIcon title={error} />}
            {result && <Alert type="success" showIcon title={`已确认生效版本 ${result.version}（草稿 ${result.draftVersion}）`} description="可以继续免费报价核对；实际可用规格仍受站点开放状态和生成能力约束。" />}
            {preview && !result && <><Space wrap><Tag>草稿 {preview.draftVersion}</Tag><Tag>{preview.current ? `当前生效版本 ${preview.current.version} · 草稿 ${preview.current.draftVersion}` : "尚未生效"}</Tag></Space>
                {preview.draftVersion !== draftVersion && <Alert type="warning" showIcon title="服务器草稿已变化，请返回配置并读取核对后再生效。" />}
                {preview.issues.length > 0 && <Alert type="warning" showIcon title="以下配置需要处理" description={<ul className="m-0 pl-4">{preview.issues.map((issue, i) => <li key={i}>{issue.modelId} {issue.specification}：{issue.message}</li>)}</ul>} />}
                {preview.changes.length === 0 && <Typography.Text type="secondary">当前没有可执行的参数组合；展示标签本身不会开放生成。</Typography.Text>}
                {preview.changes.map(change => <Card key={change.modelId} size="small" title={<span className="whitespace-normal break-all">{change.displayName}</span>} extra={<Tag>{change.action === "disable" ? "停用旧来源" : change.previous ? "更新" : "新增"}</Tag>}>
                    <Typography.Paragraph type="secondary" className="break-all">{change.providerId} · {change.providerModel}</Typography.Paragraph>
                    {change.action === "disable" ? <Typography.Text>此来源不再接收新任务；有未结束或待核对任务时会拒绝本次生效。</Typography.Text> : <>
                        <div className="grid min-w-0 gap-4 sm:grid-cols-2"><div><Typography.Title level={5}>最近价目</Typography.Title><PriceLines rules={change.previous?.rules ?? null} scalar={change.previous?.scalarCredits} />
                            {change.previous && <Typography.Paragraph type="secondary">价目版本 {change.previous.priceVersion} · {change.previous.priceEnabled ? "已启用" : "未启用"}
                                {change.previous.effectiveFrom && <><br />生效：{new Date(change.previous.effectiveFrom).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（北京时间）</>}
                                {change.previous.effectiveTo && <><br />截止：{new Date(change.previous.effectiveTo).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}（北京时间）</>}
                            </Typography.Paragraph>}</div>
                            <div><Typography.Title level={5}>生效后</Typography.Title><PriceLines rules={change.rules} /></div></div>
                        {change.previous?.publicPriceNote && <Alert className="!mt-3" type="info" title="原价格说明将清空，以本次规格积分为准" description={change.previous.publicPriceNote} />}
                        {change.rules?.cost && <Typography.Paragraph type="secondary" className="!mb-0 !mt-3">保留当前绑定的成本草稿；本次只按已填写积分设置售价。</Typography.Paragraph>}
                    </>}
                </Card>)}
            </>}
        </div>
    </Modal>;
}
