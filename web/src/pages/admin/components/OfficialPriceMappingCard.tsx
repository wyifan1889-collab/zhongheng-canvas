import { useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Card, Checkbox, Select, Space, Typography } from "antd";
import { useAccountStore } from "@/stores/use-account-store";
import { getAdminGenerationScope, sameModelPriceBinding, PlatformServiceError, type AdminGenerationScope, type PriceDraftModel } from "@/services/saas/platform";
import { createAdminOfficialPriceReferenceClient, OFFICIAL_PRICE_SOURCES, type AdminOfficialPriceCatalog } from "@/services/saas/official-price-references";
import { OfficialPriceReference, OfficialPriceSourceUpdates } from "@/components/account/official-price-reference";

export default function OfficialPriceMappingCard({ model, disabled = false }: { model: PriceDraftModel; disabled?: boolean }) {
    const account = useAccountStore(), draftScope = account.getDraftScope();
    const scope = account.user?.role === "admin" && draftScope ? { ...draftScope, role: "admin" as const } : null;
    if (!scope || model.binding.capability !== "text") return null;
    return <MappingPanel key={`${scope.accountId}:${scope.epoch}:${model.modelId}:${JSON.stringify(model.binding)}`} model={model} scope={scope} disabled={disabled} />;
}
function MappingPanel({ model, scope, disabled }: { model: PriceDraftModel; scope: AdminGenerationScope; disabled: boolean }) {
    const client = useRef<ReturnType<typeof createAdminOfficialPriceReferenceClient> | null>(null), busyRef = useRef(false), dirty = useRef(false);
    const [catalog, setCatalog] = useState<AdminOfficialPriceCatalog | null>(null), [referenceId, setReferenceId] = useState<string | null>(null);
    const [busy, setBusy] = useState<"read" | "save" | null>(null), [blocked, setBlocked] = useState(true), [confirmed, setConfirmed] = useState(false);
    const [error, setError] = useState(""), [notice, setNotice] = useState("");
    const mapping = catalog?.mappings.find(m => m.modelId === model.modelId);
    const source = catalog?.sources.find(s => s.entries.some(entry => entry.id === referenceId)), entry = source?.entries.find(e => e.id === referenceId);
    const mismatch = mapping && (!mapping.bindingMatchesCurrent || !sameModelPriceBinding(mapping.binding, model.binding));
    async function read(owner = client.current) {
        if (!owner?.isCurrent() || busyRef.current) return;
        busyRef.current = true; setBusy("read"); setError(""); setConfirmed(false);
        try { const data = await owner.load(); if (!data || client.current !== owner || !owner.isCurrent()) return;
            setCatalog(data); setBlocked(false);
            const current = data.mappings.find(m => m.modelId === model.modelId);
            if (!dirty.current) setReferenceId(current?.referenceId ?? null);
            else setNotice("已读取当前对照，保留你的选择；请核对后明确确认再保存。");
        } catch (failure) { if (client.current === owner && owner.isCurrent()) { setError(failure instanceof PlatformServiceError ? failure.message : "参考目录读取失败。"); setBlocked(true); } }
        finally { if (client.current === owner && owner.isCurrent()) { busyRef.current = false; setBusy(null); } }
    }
    useLayoutEffect(() => {
        const owner = createAdminOfficialPriceReferenceClient({ scope, getScope: getAdminGenerationScope }); client.current = owner; void read(owner);
        return () => { owner.close(); if (client.current === owner) { client.current = null; busyRef.current = false; } };
    }, [scope.accountId, scope.epoch]);
    async function save() {
        const owner = client.current; if (!owner?.isCurrent() || busyRef.current || disabled || blocked || !confirmed || !catalog) return;
        busyRef.current = true; setBusy("save"); setError(""); setNotice("");
        try { const saved = await owner.save({ modelId: model.modelId, expectedVersion: mapping?.version ?? 0, binding: model.binding, referenceId });
            if (!saved || client.current !== owner || !owner.isCurrent()) return;
            setCatalog({ ...catalog, mappings: [...catalog.mappings.filter(m => m.modelId !== model.modelId), saved] }); dirty.current = false; setConfirmed(false);
            setNotice(`官方对照版本 ${saved.version} 已保存；成本、售价和草稿均未改变。`);
        } catch (failure) { if (client.current === owner && owner.isCurrent()) { setBlocked(true); setConfirmed(false); setError(failure instanceof PlatformServiceError ? failure.message : "保存结果未确认，请重新读取核对。"); } }
        finally { if (client.current === owner && owner.isCurrent()) { busyRef.current = false; setBusy(null); } }
    }
    return <Card size="small" title="官方参考价" extra={<Button disabled={disabled || busy !== null} loading={busy === "read"} onClick={() => void read()}>重新读取参考目录</Button>}>
        <Space orientation="vertical" size="middle" className="w-full">
            <Typography.Text type="secondary">官方 Standard 文本来源由后台每 6 小时核对；此处只读取已核对目录。对照关系仅用于比较，不联动渠道成本、售价或价格草稿。</Typography.Text>
            {error ? <Alert type="warning" showIcon title={error} /> : null}{notice ? <Typography.Paragraph role="status" className="!mb-0">{notice}</Typography.Paragraph> : null}
            {catalog ? <OfficialPriceSourceUpdates sources={catalog.sources} /> : null}
            {mismatch ? <Alert type="warning" showIcon title="当前渠道绑定已变化，旧官方对照不再用于公开展示；请核对型号与适用条件后重新保存。" /> : null}
            <Select aria-label="官方价格对照条目" className="w-full" showSearch optionFilterProp="label" value={referenceId ?? ""} disabled={disabled || busy !== null || !catalog}
                options={[{ value: "", label: "不设置官方对照" }, ...(catalog?.sources.flatMap(s => s.entries.map(e => ({ value: e.id, label: `${OFFICIAL_PRICE_SOURCES[s.id].name} · ${e.modelName}${s.status === "stale" ? "（旧参考价）" : ""}` }))) ?? [])]}
                onChange={value => { setReferenceId(value || null); dirty.current = true; setConfirmed(false); setNotice(""); }} />
            {entry && source?.checkedAt ? <OfficialPriceReference sourceId={source.id} entry={entry} version={source.version} checkedAt={source.checkedAt} changedAt={source.changedAt} stale={source.status !== "ready"} changed={source.changedEntryIds.includes(entry.id)} />
                : <Typography.Text type="secondary">{referenceId ? "原官方条目当前不可用，请重新核对型号和来源；未知价格不按 0 处理。" : "尚未设置官方对照；未收录的模型不猜测官方价格，也不按 0 处理。"}</Typography.Text>}
            {catalog?.sources.filter(s => s.status === "unavailable").map(s => <Typography.Text type="secondary" key={s.id}>{OFFICIAL_PRICE_SOURCES[s.id].name}：尚无成功核对的官方目录。</Typography.Text>)}
            <Checkbox checked={confirmed} disabled={disabled || busy !== null || blocked} onChange={event => setConfirmed(event.target.checked)}>我已核对当前渠道型号与官方条目的适用条件（或明确移除对照）</Checkbox>
            <Button disabled={disabled || busy !== null || blocked || !confirmed || (referenceId !== null && !entry)} loading={busy === "save"} onClick={() => void save()}>保存官方对照</Button>
        </Space>
    </Card>;
}
