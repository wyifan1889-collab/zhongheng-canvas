import { useState } from "react";
import { Alert, Button, Input, Select, Space, Typography } from "antd";
import { geminiImageDraftSpecs, type GeminiImagePriceTrial as Trial } from "../../../../../packages/shared/src/gemini-image-price-trial";
import { PlatformServiceError, type createAdminModelPricePublicationClient, type ModelPricePublicationPreview } from "@/services/saas/platform";

export default function GeminiImagePriceTrial({ source, client }: {
    source: ModelPricePublicationPreview; client: ReturnType<typeof createAdminModelPricePublicationClient>;
}) {
    const [selection, setSelection] = useState<number>();
    const [budget, setBudget] = useState("");
    const [result, setResult] = useState<Trial | null>(null);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState(false);
    const specs = source.draft && geminiImageDraftSpecs(source.draft);
    if (!specs?.length) return <Alert showIcon type="info" title="请选择完整的比例与分辨率档位，并为每个组合填写有效的按张售价。" />;
    const selected = selection === undefined ? undefined : specs[selection];
    const budgetCredits = /^[1-9]\d*$/.test(budget) ? Number(budget) : NaN;
    const canCalculate = !!selected && Number.isSafeInteger(budgetCredits) && !busy;
    async function calculate() {
        if (!selected || !canCalculate) return;
        setBusy(true); setError(""); setResult(null);
        try { setResult(await client.trialGeminiImagePrice(source, selected.parameters, budgetCredits)); }
        catch (failure) { setError(failure instanceof PlatformServiceError ? failure.message : "试算未完成，请重新核对草稿。"); }
        finally { setBusy(false); }
    }
    return <Space orientation="vertical" className="w-full" size="middle">
        <Typography.Text type="secondary">已保存草稿 v{source.draft?.version} · {source.latestPriceVersion ? `当前价格 v${source.latestPriceVersion}` : "暂无已发布价格"}</Typography.Text>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            <div className="min-w-0"><Typography.Paragraph className="!mb-1">图片规格</Typography.Paragraph>
                <Select className="w-full" aria-label="试算图片规格" disabled={busy} placeholder="选择已定价的组合" value={selection}
                    options={specs.map((item, value) => ({ value, label: `${item.parameters.aspectRatio} · ${item.parameters.imageSize}` }))}
                    onChange={value => { setSelection(value); setError(""); setResult(null); }} /></div>
            <div className="min-w-0"><Typography.Paragraph className="!mb-1">样例预算（积分）</Typography.Paragraph>
                <Input aria-label="样例预算（积分）" inputMode="numeric" disabled={busy} value={budget}
                    onChange={event => { setBudget(event.target.value); setError(""); setResult(null); }} /></div>
        </div>
        {selected && <Typography.Text>每张 {selected.creditsPerImage} 积分</Typography.Text>}
        <div><Button type="primary" loading={busy} disabled={!canCalculate} onClick={() => { void calculate(); }}>核对费用</Button></div>
        {error && <Alert type="warning" showIcon title={error} />}
        {result && <Alert type="success" showIcon title={`预算 ${result.budgetCredits} 积分可覆盖 ${result.coveredImages} 张`}
            description={`按成功交付张数收费，每张 ${result.creditsPerImage} 积分。覆盖张数仅用于费用试算。`} />}
    </Space>;
}
