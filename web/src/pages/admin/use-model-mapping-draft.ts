import { useEffect, useRef, useState } from "react";
import { getAdminGenerationScope, PlatformServiceError } from "@/services/saas/platform";
import { createModelMappingDraftClient } from "@/services/saas/model-mapping-draft";
import { emptyMappingDraft, parseMappingDraft, type MappingCatalog } from "./model-mapping-plan";

export function useModelMappingDraft(directoryChange: number) {
    const [draft, setDraft] = useState(emptyMappingDraft), draftRef = useRef(draft); draftRef.current = draft;
    const [catalog, setCatalog] = useState<MappingCatalog | null>(null), catalogRef = useRef(catalog); catalogRef.current = catalog;
    const [incoming, setIncoming] = useState<MappingCatalog | null>(null);
    const [busy, setBusy] = useState<"read" | "save" | null>("read"), busyRef = useRef(false);
    const [blocked, setBlocked] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
    const client = useRef<ReturnType<typeof createModelMappingDraftClient> | null>(null);
    const directoryVersion = useRef(directoryChange);
    const live = (owner: NonNullable<typeof client.current>) => client.current === owner && owner.isCurrent();
    const dirty = !!catalog && JSON.stringify(draft) !== JSON.stringify(catalog.draft);
    function accept(value: MappingCatalog, keepInput = false) {
        catalogRef.current = value; setCatalog(value);
        if (!keepInput) { draftRef.current = value.draft; setDraft(value.draft); }
        setIncoming(null); setBlocked(false); setError("");
        setNotice(keepInput ? `已核对服务器版本 ${value.version}，保留本地输入；下次保存会按此版本提交。` : `已读取配置草稿版本 ${value.version}。`);
    }
    async function read(owner = client.current) {
        if (!owner || !live(owner) || busyRef.current) return;
        busyRef.current = true; setBusy("read"); setError("");
        try {
            const value = await owner.load(); if (!value || !live(owner)) return;
            if (catalogRef.current && JSON.stringify(draftRef.current) !== JSON.stringify(catalogRef.current.draft)) { setIncoming(value); setBlocked(true); }
            else accept(value);
        } catch (failure) { if (live(owner)) { setError(failure instanceof PlatformServiceError ? failure.message : "配置读取未完成，请重新核对。"); setBlocked(true); } }
        finally { if (live(owner)) { busyRef.current = false; setBusy(null); } }
    }
    useEffect(() => {
        const scope = getAdminGenerationScope();
        if (!scope) { setBusy(null); setError("管理员会话尚未确认，请重新登录。"); return; }
        const owner = createModelMappingDraftClient({ scope, getScope: getAdminGenerationScope }); client.current = owner; void read(owner);
        return () => { owner.close(); if (client.current === owner) { client.current = null; busyRef.current = false; } };
    }, []);
    useEffect(() => {
        if (directoryVersion.current === directoryChange || busy) return;
        directoryVersion.current = directoryChange;
        void read();
    }, [directoryChange, busy]);
    async function save() {
        const owner = client.current, base = catalogRef.current;
        if (!owner || !live(owner) || !base || blocked || incoming || busyRef.current) return;
        const parsed = parseMappingDraft(draftRef.current);
        if (!parsed) { setError("请补齐模型名称，核对规格、来源和正整数积分草稿。"); return; }
        busyRef.current = true; setBusy("save"); setError(""); setNotice("");
        try {
            const providers = [...new Set(parsed.bindings.map(item => item.providerId))].map(providerId => ({ providerId, revision: base.providers.find(item => item.providerId === providerId)?.revision ?? null }));
            const saved = await owner.save({ expectedVersion: base.version, draft: parsed, providers });
            if (!saved || !live(owner)) return;
            accept({ ...base, ...saved }); setNotice(`配置草稿版本 ${saved.version} 已保存，刷新后可恢复；尚未应用到节点或生效价格。`);
        } catch (failure) { if (live(owner)) { setError(failure instanceof PlatformServiceError ? failure.message : "保存结果尚未确认，请先重新读取核对。"); setBlocked(true); } }
        finally { if (live(owner)) { busyRef.current = false; setBusy(null); } }
    }
    return { draft, setDraft, catalog, incoming, busy, blocked, dirty, error, notice, setNotice, read: () => { void read(); }, save: () => { void save(); },
        acceptIncoming: (keepInput: boolean) => { if (incoming) accept(incoming, keepInput); } };
}
