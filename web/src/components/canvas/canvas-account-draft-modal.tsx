import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, Modal, theme } from "antd";

import type { JsonObject } from "../../../../packages/shared/src/index";
import { validateCanvasDocumentMount, type CanvasDocumentMount } from "@/services/saas/canvas-document-mount";
import { CanvasDocumentMountControllerError, createCanvasDocumentMountController, type CanvasDocumentMountPlan } from "@/services/saas/canvas-document-mount-controller";
import { AccountDraftWorkspaceError, createAccountDraftWorkspace, type AccountDraftWorkspaceState } from "@/services/saas/account-draft-workspace";
import { revokeCloudMediaObjectUrls } from "@/services/saas/cloud-media-hydration";
import type { AccountDraftSummary } from "@/services/saas/account-draft-store";
import { useAccountStore } from "@/stores/use-account-store";
import { saveCanvasMountRecovery, type CanvasProject } from "@/stores/canvas/use-canvas-store";
import type { DraftAccountScope } from "@/services/saas/drafts";
import type { CanvasNodeData } from "@/types/canvas";

type Props = {
    localProjectId: string;
    initialCloudId?: string | null;
    initialCloudRevision?: number | null;
    getCurrentProject: () => JsonObject | null;
    onMount?: (plan: CanvasDocumentMountPlan) => void;
    onClose: () => void;
};

const formatDate = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString();
};

function mountReferenceMessage(mount: CanvasDocumentMount): string {
    const imageNodeCount = mount.project.nodes.filter((node: CanvasNodeData) => node.type === "image").length;
    const cloudMediaCount = new Set(
        mount.unresolvedReferences
            .filter((reference) => reference.kind === "cloud-media" && reference.cloudMediaId)
            .map((reference) => reference.cloudMediaId!.toLowerCase()),
    ).size;
    // A blob URL next to a cloudMediaId is the session-only preview created by
    // hydration. It is intentionally retained in the staged document and is
    // removed again before a cloud save, so it is not an unresolved reference.
    const pendingCount = mount.unresolvedReferences.filter((reference) => !["cloud-media", "blob-url"].includes(reference.kind)).length;
    if (imageNodeCount > 0 && cloudMediaCount === 0 && pendingCount === 0) {
        return `检测到 ${imageNodeCount} 个图片节点，但没有云端素材编号；挂载后不会恢复图片。请回到原画布从“云端素材”重新插入后再保存。`;
    }
    if (cloudMediaCount > 0) {
        return pendingCount > 0
            ? `已恢复 ${cloudMediaCount} 个云端媒体；仍有 ${pendingCount} 个待后续解析的媒体/任务引用。`
            : `已恢复 ${cloudMediaCount} 个云端媒体；没有待后续解析的媒体/任务引用。`;
    }
    return mount.unresolvedReferences.length
        ? `已通过严格结构校验；发现 ${mount.unresolvedReferences.length} 个待后续解析的媒体/任务引用。`
        : "已通过严格结构校验；没有待后续解析的媒体/任务引用。";
}

/**
 * Account-local draft seam. It stages and previews by default; an explicit
 * two-step confirmation may hand a checked plan to the page. Media hydration,
 * generation recovery and cloud requests remain outside this component.
 */
export function CanvasAccountDraftModal({ localProjectId, initialCloudId, initialCloudRevision, getCurrentProject, onMount, onClose }: Props) {
    const account = useAccountStore();
    const scope = account.getDraftScope();
    const scopeKey = `${scope?.accountId ?? "none"}:${scope?.epoch ?? "none"}:${localProjectId}:${initialCloudId ?? "none"}:${initialCloudRevision ?? "none"}`;
    return <AccountDraftDialog key={`account-draft:${scopeKey}`} scope={scope} localProjectId={localProjectId} initialCloudId={initialCloudId} initialCloudRevision={initialCloudRevision} getCurrentProject={getCurrentProject} onMount={onMount} onClose={onClose} />;
}

function AccountDraftDialog({ scope, localProjectId, initialCloudId, initialCloudRevision, getCurrentProject, onMount, onClose }: Props & { scope: DraftAccountScope | null }) {
    const { token } = theme.useToken();
    const workspaceRef = useRef<ReturnType<typeof createAccountDraftWorkspace> | null>(null);
    function workspace() {
        return workspaceRef.current ??= createAccountDraftWorkspace(() => {
            const account = useAccountStore.getState();
            const current = account.getDraftScope();
            return scope && current?.accountId === scope.accountId && current.epoch === scope.epoch
                ? { ...current, cloudCanvas: account.site?.cloudCanvas === true }
                : null;
        });
    }
    const active = useRef(true);
    const [summaries, setSummaries] = useState<AccountDraftSummary[]>([]);
    const [selected, setSelected] = useState<AccountDraftWorkspaceState["draft"]>(null);
    const [mount, setMount] = useState<CanvasDocumentMount | null>(null);
    const [mountPlan, setMountPlan] = useState<CanvasDocumentMountPlan | null>(null);
    const mountControllerRef = useRef<ReturnType<typeof createCanvasDocumentMountController> | null>(null);
    const [message, setMessage] = useState("打开窗口不会读取或上传内容。请点击按钮执行本机草稿操作。");
    const [busy, setBusy] = useState(false);
    const [state, setState] = useState<AccountDraftWorkspaceState>({ phase: "idle", draft: null, project: null, dirty: false });
    const initialCloudOpened = useRef(false);
    const cloudOpenRequest = useRef(0);
    const committing = useRef(false);
    const latest = useRef({ getCurrentProject, localProjectId, onMount });
    latest.current = { getCurrentProject, localProjectId, onMount };

    function close() {
        active.current = false;
        mountControllerRef.current?.dispose();
        onClose();
    }

    // Invalidate synchronously on unmount, before an IndexedDB completion can
    // arrive between the route commit and passive effect cleanup.
    useLayoutEffect(() => {
        active.current = true;
        return () => {
            active.current = false;
            workspaceRef.current?.dispose();
            workspaceRef.current = null;
            mountControllerRef.current?.dispose();
            mountControllerRef.current = null;
            cloudOpenRequest.current += 1;
            initialCloudOpened.current = false;
        };
    }, []);

    useEffect(() => {
        if (!initialCloudId || initialCloudOpened.current || !scope) return;
        initialCloudOpened.current = true;
        const request = ++cloudOpenRequest.current;
        setBusy(true); setMessage("正在读取云稿并下载当前账号拥有的私有媒体…");
        void workspace().openCloud(initialCloudId, initialCloudRevision ?? undefined).then((opened) => {
            const checked = validateCanvasDocumentMount(opened.project);
            if (!active.current || request !== cloudOpenRequest.current) return;
            setSelected(opened); setMount(checked); setMountPlan(null);
            setMessage("云稿已在隔离区准备完成；确认挂载前不会替换当前画布。"); sync();
        }).catch((error) => {
            if (active.current && request === cloudOpenRequest.current) { setSelected(null); setMount(null); setMountPlan(null); setMessage(error instanceof AccountDraftWorkspaceError ? error.message : "云稿读取未完成；当前画布保持不变。"); sync(); }
        }).finally(() => { if (active.current && request === cloudOpenRequest.current) setBusy(false); });
    }, [initialCloudId, initialCloudRevision, scope]);

    function sync() { if (active.current) setState(workspaceRef.current?.getState() ?? { phase: "idle", draft: null, project: null, dirty: false }); }
    async function refresh() {
        if (busy) return;
        setBusy(true); setMessage("正在读取当前账号的本机草稿目录…");
        try {
            const next = await workspace().listLocal();
            if (!active.current) return;
            setSummaries(next); setMessage(`已读取 ${next.length} 份本机账号草稿。`); sync();
        } catch (error) {
            if (active.current) { setMessage(error instanceof AccountDraftWorkspaceError ? error.message : "本机草稿目录读取未完成。"); sync(); }
        } finally { if (active.current) setBusy(false); }
    }
    async function saveCurrent() {
        if (busy) return;
        const current = getCurrentProject();
        if (!current) { setMessage("当前画布尚未准备好，未保存账号草稿。"); return; }
        setBusy(true); setMessage("正在把当前画布保存为账号本机草稿…");
        try {
            const controller = workspace(), open = controller.getState();
            if (open.project && open.draft?.localProjectId === localProjectId && open.project.id === current.id) controller.edit(current);
            else controller.createLocal(current);
            const saved = await controller.saveLocal();
            if (active.current) {
                setSelected(saved); setMount(null); setMountPlan(null); setMessage(`已保存“${String(saved.project.title)}”，本机版本 ${saved.revision}。`);
                const next = await controller.listLocal();
                if (active.current) setSummaries(next);
            }
        } catch (error) {
            if (active.current) { setMessage(error instanceof AccountDraftWorkspaceError ? error.message : "账号草稿保存未完成；当前画布保持不变。"); sync(); }
        } finally { if (active.current) setBusy(false); }
    }
    async function openLocal(id: string) {
        if (busy) return;
        setBusy(true); setMessage("正在打开本机账号草稿的隔离预览…"); setMount(null);
        try {
            const opened = await workspace().openLocal(id);
            const checked = validateCanvasDocumentMount(opened.project);
            if (active.current) { setSelected(opened); setMount(checked); setMountPlan(null); setMessage("隔离预览已准备，当前画布保持不变；素材读取结果见下方预览。"); sync(); }
        } catch (error) {
            if (active.current) { setSelected(null); setMount(null); setMessage(error instanceof AccountDraftWorkspaceError ? error.message : "草稿未通过挂载前校验，原版画布没有被替换。"); sync(); }
        } finally { if (active.current) setBusy(false); }
    }
    function prepareMount() {
        if (!scope || !mount) return;
        const currentProject = getCurrentProject();
        if (!currentProject) { setMessage("当前画布尚未准备好，未进入正式挂载确认。"); return; }
        try {
            const controller = mountControllerRef.current ??= createCanvasDocumentMountController();
            const next = controller.prepare({ accountId: scope.accountId, epoch: scope.epoch, projectId: localProjectId, currentProject, candidate: mount,
                cloudVersion: selected?.cloud ? { accountId: selected.accountId, ...selected.cloud } : undefined,
                mediaObjectUrls: workspace().getCloudMediaObjectUrls() });
            setMountPlan(next);
            setMessage("已锁定当前画布快照。请再次确认后才会生成恢复副本并替换当前项目。");
        } catch (error) {
            setMountPlan(null);
            setMessage(error instanceof CanvasDocumentMountControllerError ? error.message : "正式挂载准备未完成，当前画布保持不变。");
        }
    }
    async function commitMount() {
        if (!scope || !mountPlan || !onMount || busy || committing.current) return;
        committing.current = true;
        setBusy(true); setMessage("正在保留当前画布的本机恢复副本，完成后才会挂载…");
        let recoverySaved = false;
        try {
            const controller = mountControllerRef.current;
            if (!controller) { setMountPlan(null); setMessage("正式挂载控制器尚未准备好，当前画布保持不变。"); return; }
            await controller.commitAfterRecovery(() => {
                const currentScope = useAccountStore.getState().getDraftScope();
                if (!active.current) throw new CanvasDocumentMountControllerError("closed");
                const currentProject = latest.current.getCurrentProject();
                if (!currentScope || !currentProject || !latest.current.onMount) throw new CanvasDocumentMountControllerError("context_changed");
                return { ...currentScope, projectId: latest.current.localProjectId, currentProject };
            }, async (plan) => {
                await saveCanvasMountRecovery(plan.recoveryProject as Partial<CanvasProject>);
                recoverySaved = true;
            }, (committed) => {
                const mediaObjectUrls = workspace().takeCloudMediaObjectUrls();
                try { latest.current.onMount!({ ...committed, mediaObjectUrls }); }
                catch (error) { revokeCloudMediaObjectUrls(mediaObjectUrls); throw error; }
            });
        } catch (error) {
            if (active.current) {
                setMountPlan(null);
                setMessage(error instanceof CanvasDocumentMountControllerError ? error.message : recoverySaved
                    ? "恢复副本已保存，但正式挂载未完成。请保留页面并从本机项目列表核对恢复副本。"
                    : "本机恢复副本未能确认保存，尚未替换当前画布。请保留页面并导出本机内容后核对。");
            }
        } finally {
            committing.current = false;
            if (active.current) setBusy(false);
        }
    }
    function downloadSelected() {
        if (!selected) return;
        const blob = new Blob([JSON.stringify(selected.project, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob), anchor = document.createElement("a");
        anchor.href = url; anchor.download = `${String(selected.project.title || "canvas-draft")}.json`; anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
        setMessage("已导出隔离预览正文 JSON；其中媒体引用仍需后续单独迁移。 ");
    }

    return <Modal title="账号草稿 · 本机隔离区" open centered onCancel={close}
        modalRender={(node) => <div data-canvas-shortcuts-ignore
            onKeyDown={(event) => { if (event.code === "Space") event.stopPropagation(); }}
            onKeyUp={(event) => { if (event.code === "Space") event.stopPropagation(); }}>{node}</div>}
        footer={<Button onClick={close}>返回画布</Button>}>
        <div className="space-y-4 text-sm leading-6" style={{ color: token.colorText }}>
            {!scope ? <p role="status">当前没有已确认的登录账号。账号草稿不会读取匿名或其他账号的数据。</p> : <>
                <p style={{ color: token.colorTextSecondary }}>账号本机草稿按账号和登录会话隔离。这里可以保存当前画布、打开隔离预览和导出 JSON；不会自动替换正式画布。</p>
                <div className="flex flex-wrap gap-2">
                    <Button type="text" disabled={busy} onClick={() => void refresh()}>刷新本机草稿</Button>
                    <Button type="primary" disabled={busy} onClick={() => void saveCurrent()}>保存当前画布</Button>
                </div>
                <p role="status" aria-live="polite">{message}</p>
                {summaries.length ? <ul aria-label="账号本机草稿列表" className="max-h-56 space-y-3 overflow-y-auto">
                    {summaries.map((item) => <li key={item.localProjectId} className="flex items-start justify-between gap-3 rounded-lg border px-3 py-2" style={{ borderColor: token.colorBorderSecondary }}>
                        <div className="min-w-0"><p className="truncate font-medium">{item.title || "未命名草稿"}</p><p className="text-xs" style={{ color: token.colorTextSecondary }}>本机版本 {item.revision} · {formatDate(item.updatedAt)}</p></div>
                        <Button type="link" disabled={busy} onClick={() => void openLocal(item.localProjectId)}>打开隔离预览</Button>
                    </li>)}
                </ul> : <p style={{ color: token.colorTextSecondary }}>尚未读取目录，或当前账号还没有本机草稿。</p>}
                {selected ? <div className="space-y-2 rounded-lg border p-3" style={{ background: token.colorFillAlter, color: token.colorText, borderColor: token.colorBorderSecondary }}>
                    <p className="font-medium">预览：{String(selected.project.title)} · 本机版本 {selected.revision}</p>
                    <p>节点 {Array.isArray(selected.project.nodes) ? selected.project.nodes.length : 0} · 连线 {Array.isArray(selected.project.connections) ? selected.project.connections.length : 0} · 对话 {Array.isArray(selected.project.chatSessions) ? selected.project.chatSessions.length : 0}</p>
                    <p style={{ color: token.colorTextSecondary }}>{mount ? mountReferenceMessage(mount) : "未通过严格结构校验，不能安全交给原版编辑器。"}</p>
                    <div className="flex flex-wrap gap-2">
                        <Button type="link" disabled={!mount} onClick={downloadSelected}>导出隔离 JSON</Button>
                        {onMount ? <Button type="link" disabled={!mount || busy || Boolean(mountPlan)} onClick={prepareMount}>准备正式挂载</Button> : null}
                    </div>
                    {mountPlan ? <div className="space-y-2 rounded border p-2" style={{ background: token.colorWarningBg, borderColor: token.colorWarningBorder, color: token.colorText }} role="alert">
                        <p>将先保存当前画布的本机恢复副本，再把这份草稿挂载到当前项目。本机媒体、外部链接和生成任务不会自动恢复。</p>
                        <div className="flex flex-wrap gap-2">
                            <Button type="primary" disabled={busy} onClick={() => void commitMount()}>确认挂载到当前画布</Button>
                            <Button disabled={busy} onClick={() => { setMountPlan(null); setMessage("已取消正式挂载，当前画布保持不变。"); }}>取消</Button>
                        </div>
                    </div> : null}
                </div> : null}
                <p className="text-xs" style={{ color: token.colorTextSecondary }}>含云端素材的草稿会先在隔离区校验正文并读取私有媒体；只有点击“确认挂载到当前画布”后，才会保存恢复副本并替换当前画布。不会自动续查视频或恢复生成任务。</p>
            </>}
        </div>
    </Modal>;
}
