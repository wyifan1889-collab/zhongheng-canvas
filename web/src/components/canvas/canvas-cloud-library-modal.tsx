import { useLayoutEffect, useRef, useState } from "react";
import { Button, Modal } from "antd";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAccountStore } from "@/stores/use-account-store";
import type { DraftAccountScope, DraftPage } from "@/services/saas/drafts";
import { createCanvasCloudLibrary, CanvasCloudLibraryError } from "@/services/saas/canvas-cloud-library";
import type { CanvasVersionSelection } from "@/services/saas/canvas-version-save";

export function CanvasCloudLibraryModal({ localProjectId, onOpenCloud, onSelectVersion, onClose, openMode }: { localProjectId: string; onOpenCloud?: (id: string, revision: number) => void; onSelectVersion?: (selection: CanvasVersionSelection) => void | Promise<void>; onClose: () => void; openMode?: "cloud-route" }) {
    const account = useAccountStore(), scope = account.getDraftScope(), enabled = account.site?.cloudCanvas === true;
    return <LibraryDialog key={JSON.stringify([localProjectId, scope?.accountId, scope?.epoch, enabled])}
        localProjectId={localProjectId} scope={scope} enabled={enabled} onOpenCloud={onOpenCloud} onSelectVersion={onSelectVersion} onClose={onClose} openMode={openMode} />;
}

function LibraryDialog({ localProjectId, scope, enabled, onOpenCloud, onSelectVersion, onClose, openMode }: {
    localProjectId: string; scope: DraftAccountScope | null; enabled: boolean; onOpenCloud?: (id: string, revision: number) => void; onSelectVersion?: (selection: CanvasVersionSelection) => void | Promise<void>; onClose: () => void; openMode?: "cloud-route";
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const accountName = useAccountStore((state) => state.user?.name ?? "");
    const [page, setPage] = useState<DraftPage | null>(null), [pageNumber, setPageNumber] = useState(0), [selected, setSelected] = useState<DraftPage["items"][number] | null>(null);
    const [message, setMessage] = useState("尚未读取。打开窗口不会请求云端，也不会上传本机作品。");
    const [busy, setBusy] = useState(false), [blocked, setBlocked] = useState(false), [selectionBusy, setSelectionBusy] = useState(false), [selectionError, setSelectionError] = useState("");
    const active = useRef(true), pending = useRef(false), selecting = useRef(false);
    const library = useRef<ReturnType<typeof createCanvasCloudLibrary> | null>(null);
    useLayoutEffect(() => {
        active.current = true;
        return () => { active.current = false; library.current?.dispose(); library.current = null; };
    }, []);
    function getContext() {
        const account = useAccountStore.getState(), current = account.getDraftScope();
        return active.current && scope && current?.accountId === scope.accountId && current.epoch === scope.epoch
            ? { ...current, localProjectId, cloudCanvas: account.site?.cloudCanvas === true } : null;
    }
    function close() { active.current = false; library.current?.dispose(); onClose(); }
    async function read(next = false) {
        if (pending.current || selecting.current || !getContext()?.cloudCanvas || blocked) return;
        const current = library.current ??= createCanvasCloudLibrary(getContext);
        pending.current = true; setBusy(true); setPage(null); setSelected(null);
        setMessage(next ? "正在读取下一页云稿目录…" : "正在读取云稿目录首页…");
        try {
            const result = await (next ? current.loadNext() : current.loadFirst());
            if (!getContext()?.cloudCanvas || library.current !== current) return;
            setPage(result); setPageNumber((previous) => next ? previous + 1 : 1);
            setMessage("目录读取完成；仅显示标题、编号和版本信息，未下载或打开作品正文。");
        } catch (error) {
            if (!getContext()?.cloudCanvas || library.current !== current) return;
            setPage(null); setPageNumber(0);
            setBlocked(current.getState().phase === "blocked");
            setMessage(error instanceof CanvasCloudLibraryError ? error.message : "目录读取未完成；不是空目录，也没有改动本机作品。请主动重新读取首页。");
        } finally {
            if (active.current && library.current === current) { pending.current = false; setBusy(false); }
        }
    }
    return <Modal title="我的云稿 · 只读目录" open centered onCancel={close}
        modalRender={(node) => <div data-canvas-shortcuts-ignore
            onKeyDown={(event) => { if (event.code === "Space") event.stopPropagation(); }}
            onKeyUp={(event) => { if (event.code === "Space") event.stopPropagation(); }}>{node}</div>}
        footer={<Button onClick={close}>返回画布</Button>}>
        <div className="space-y-4 text-sm leading-6" style={{ color: theme.node.text }}>
            <p style={{ color: theme.node.muted }}>{openMode === "cloud-route" ? "云稿属于登录账号；请选择实际云稿编号打开，正文与私有媒体仍按当前权限核验。不会将云稿冒充缺失的本机原稿。" : "云稿属于登录账号；原版“我的画布”仍是本机作品。打开云稿会先进入账号草稿隔离区，检查正文和私有媒体，再由你确认是否挂载到当前画布。"}</p>
            {!scope ? <p role="status">当前没有已确认的登录账号，请先通过账户入口确认连接。</p>
                : !enabled ? <p role="status">云画布尚未开放，当前不能读取目录。本机作品保持不变。</p>
                    : <>
                        <p className="break-all">当前账号：{accountName}（{scope.accountId}）</p>
                        <div className="flex flex-wrap gap-2">
                            <Button type="text" disabled={busy || selectionBusy || blocked} onClick={() => void read()}>读取 / 刷新首页</Button>
                            {page?.nextCursor ? <Button type="text" disabled={busy || selectionBusy || blocked} onClick={() => void read(true)}>下一页</Button> : null}
                        </div>
                        <p role="status" aria-live="polite">{message}</p>
                        {page ? <>
                            <p>第 {pageNumber} 页 · 本页 {page.items.length} 条{page.nextCursor ? " · 还有下一页" : " · 本次查询没有更多页"}</p>
                            {page.items.length ? <ul aria-label="当前账号云稿目录" className="max-h-64 space-y-4 overflow-y-auto">
                                {page.items.map((item) => <li key={item.id} className="break-all">
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                        <p className="font-medium">{item.title || "未命名云稿"}</p>
                                        {onSelectVersion ? <Button type="link" size="small" disabled={busy || selectionBusy} onClick={() => {
                                            if (!pending.current && !selecting.current) { setSelected(item); setSelectionError(""); }
                                        }}>{selected?.id === item.id ? "已选择此版本" : "选择此版本"}</Button>
                                            : onOpenCloud ? <Button type="link" size="small" disabled={busy} onClick={() => onOpenCloud(item.id, item.revision)}>{openMode === "cloud-route" ? "打开云稿" : "打开并准备挂载"}</Button> : null}
                                    </div>
                                    <p className="font-mono text-xs" style={{ color: theme.node.muted }}>{item.id}</p>
                                    <p>版本 {item.revision} · 更新于 {new Date(item.updatedAt).toLocaleString()}</p>
                                </li>)}
                            </ul> : <p>本次查询未返回当前账号可见的云稿；不代表本机作品已上传，也不能据此重试结果不明的保存。</p>}
                        </> : null}
                    </>}
            {selected && onSelectVersion ? <div className="rounded border border-amber-500/50 p-3" role="region" aria-label="确认云稿版本">
                <p>已选择云稿版本，请确认后建立再次保存基准：</p>
                <p className="break-all">账号：{accountName}（{scope?.accountId}）</p>
                <p className="break-all">云稿编号：{selected.id}</p>
                <p>版本：{selected.revision} · 更新于 {new Date(selected.updatedAt).toLocaleString()}</p>
                <Button disabled={busy || selectionBusy} onClick={async () => {
                    if (!scope || !getContext()?.cloudCanvas || pending.current || selecting.current) return;
                    selecting.current = true;
                    setSelectionBusy(true); setSelectionError("");
                    try { await onSelectVersion({ accountId: scope.accountId, id: selected.id, revision: selected.revision }); }
                    catch { if (active.current) setSelectionError("无法确认此版本，目录可能已变化；请重新读取后再选择。"); }
                    finally { selecting.current = false; if (active.current) setSelectionBusy(false); }
                }}>确认以此版本续存</Button>
                {selectionError ? <p role="alert" className="text-red-500">{selectionError}</p> : null}
            </div> : null}
            <p style={{ color: theme.node.muted }}>目录不代表当前编辑内容已保存。不会自动读取下一页、下载正文或恢复生成任务；关闭窗口即丢弃这次目录显示。</p>
        </div>
    </Modal>;
}
