import { useLayoutEffect, useRef, useState } from "react";
import { Button, Modal } from "antd";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAccountStore } from "@/stores/use-account-store";
import { createCanvasReceiptReview, CanvasReceiptReviewError, type CanvasReceiptReviewRow } from "@/services/saas/canvas-receipt-review";
import type { DraftAccountScope } from "@/services/saas/drafts";

export function CanvasReceiptReviewModal({ localProjectId, onClose }: { localProjectId: string; onClose: () => void }) {
    // Subscribe to stable store state, not getDraftScope()'s newly allocated object.
    const account = useAccountStore();
    const scope = account.getDraftScope();
    return <ReceiptDialog key={JSON.stringify([localProjectId, scope?.accountId, scope?.epoch])}
        localProjectId={localProjectId} scope={scope} onClose={onClose} />;
}

function ReceiptDialog({ localProjectId, scope, onClose }: { localProjectId: string; scope: DraftAccountScope | null; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [rows, setRows] = useState<CanvasReceiptReviewRow[] | null>(null);
    const [message, setMessage] = useState("尚未读取回执；打开此窗口不会上传或请求云端。");
    const [busy, setBusy] = useState(false);
    const pending = useRef(false);
    const active = useRef(true);
    const review = useRef<ReturnType<typeof createCanvasReceiptReview> | null>(null);
    useLayoutEffect(() => {
        active.current = true;
        return () => { active.current = false; review.current?.dispose(); review.current = null; };
    }, []);
    const getContext = () => {
        const current = useAccountStore.getState().getDraftScope();
        return active.current && scope && current?.accountId === scope.accountId && current.epoch === scope.epoch
            ? { ...current, localProjectId } : null;
    };
    const close = () => { active.current = false; review.current?.dispose(); onClose(); };
    async function run(id?: string) {
        if (pending.current || !getContext()) return;
        const current = review.current ??= createCanvasReceiptReview(getContext);
        pending.current = true;
        setBusy(true);
        setMessage(id ? "正在主动核对云端记录…" : "正在读取本账号、当前画布的本机回执…");
        if (!id) setRows(null);
        else setRows((previous) => previous?.map((row) => row.id === id ? { id, status: "unchecked" } : row) ?? null);
        try {
            if (id) {
                const result = await current.check(id);
                if (!getContext() || review.current !== current) return;
                setRows((previous) => previous?.map((row) => row.id === id ? result : row) ?? null);
                setMessage("本次核对结束；没有修改画布或回执，也不会自动重试。");
            } else {
                const result = await current.load();
                if (!getContext() || review.current !== current) return;
                setRows(result);
                setMessage("本机回执读取完成；尚未因此请求云端。");
            }
        } catch (error) {
            if (!getContext() || review.current !== current) return;
            if (error instanceof CanvasReceiptReviewError && ["account_changed", "unauthorized", "account_context_required"].includes(error.code)) setRows(null);
            setMessage(error instanceof CanvasReceiptReviewError ? error.message : "核对未完成，请保留当前作品和回执；未显示原始错误。");
        } finally {
            if (active.current && review.current === current) { pending.current = false; setBusy(false); }
        }
    }
    return (
        <Modal title="保存回执 · 只读核对" open onCancel={close} footer={<Button onClick={close}>返回画布</Button>} centered
            modalRender={(node) => <div data-canvas-shortcuts-ignore>{node}</div>}>
            <div className="space-y-4 text-sm leading-6" style={{ color: theme.node.text }}>
                <p>回执是这台浏览器留下的保存编号，不是作品备份，也不代表当前编辑内容已保存。</p>
                <p style={{ color: theme.node.muted }}>这里只用于核对已有关联，不上传旧作品、不重传、不载入或覆盖云稿正文；核对结果不能作为再次保存的版本基准。</p>
                {!scope ? <p role="status">当前没有已确认的登录账号，暂不能读取或核对。请通过右上角账户入口确认连接；本地作品保持不变。</p> : <>
                    <Button type="text" onClick={() => void run()} disabled={busy}>读取本机回执</Button>
                    <p role="status" aria-live="polite">{message}</p>
                    {rows?.length === 0 ? <p>未找到本账号、当前画布的本机回执。这不证明云端没有作品；请勿据此重复新建。</p> : null}
                    {rows && rows.length > 0 ? <ul className="max-h-64 space-y-4 overflow-y-auto" aria-label="当前画布保存回执">
                        {rows.map((row) => <li key={row.id}>
                            <p className="break-all font-mono text-xs">{row.id}</p>
                            <p>{row.status === "found-current" ? `找到当前云稿：版本 ${row.revision}，更新时间 ${new Date(row.updatedAt).toLocaleString()}。不代表本页内容已经保存。`
                                : row.status === "not-found-yet" ? "暂未查到当前账户可见的记录；可能仍在处理或不可见，不等于保存失败。"
                                    : "尚未核对云端。"}</p>
                            <Button type="text" disabled={busy} aria-label={`主动核对 ${row.id}`} onClick={() => void run(row.id)}>主动核对</Button>
                        </li>)}
                    </ul> : null}
                </>}
                <p style={{ color: theme.node.muted }}>仅保留账号、画布、保存编号；没有额外备份正文或密钥。不会自动清理回执，清除浏览器网站数据仍可能丢失这些线索。当前原版本地作品尚未按平台账号隔离。</p>
            </div>
        </Modal>
    );
}
