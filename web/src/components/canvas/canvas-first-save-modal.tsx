import { useLayoutEffect, useRef, useState } from "react";
import { Button, Modal } from "antd";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAccountStore } from "@/stores/use-account-store";
import { createCanvasFirstSave, CanvasFirstSaveError, type CanvasFirstSaveSummary } from "@/services/saas/canvas-first-save";
import type { DraftAccountScope } from "@/services/saas/drafts";

type SaveState = ReturnType<ReturnType<typeof createCanvasFirstSave>["getState"]>;
type Props = { localProjectId: string; getProject: () => unknown; onClose: () => void; onReviewReceipts: () => void; onSaved: (saved: CanvasFirstSaveSummary) => void; onChooseCloudVersion: () => void };

export function CanvasFirstSaveModal(props: Props) {
    const account = useAccountStore();
    const scope = account.getDraftScope();
    const enabled = account.site?.cloudCanvas === true;
    return <FirstSaveDialog key={JSON.stringify([props.localProjectId, scope?.accountId, scope?.epoch, enabled])}
        {...props} scope={scope} enabled={enabled} accountName={account.user?.name ?? ""} />;
}

function FirstSaveDialog({ localProjectId, getProject, onClose, onReviewReceipts, onSaved, onChooseCloudVersion, scope, enabled, accountName }:
    Props & { scope: DraftAccountScope | null; enabled: boolean; accountName: string }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [state, setState] = useState<SaveState>({ phase: "idle" });
    const [message, setMessage] = useState("尚未准备保存。打开窗口不会读取回执、上传或改动作品。");
    const [busy, setBusy] = useState(false);
    const active = useRef(true), pending = useRef(false);
    const controller = useRef<ReturnType<typeof createCanvasFirstSave> | null>(null);
    useLayoutEffect(() => {
        active.current = true;
        return () => { active.current = false; controller.current?.dispose(); controller.current = null; };
    }, []);
    const getContext = () => {
        const account = useAccountStore.getState(), current = account.getDraftScope();
        return active.current && scope && current?.accountId === scope.accountId && current.epoch === scope.epoch
            ? { ...current, localProjectId, cloudCanvas: account.site?.cloudCanvas === true } : null;
    };
    function close() { active.current = false; controller.current?.dispose(); onClose(); }
    async function run(action: "prepare" | "submit" | "reconcile") {
        if (pending.current || !getContext()?.cloudCanvas) return;
        const current = controller.current ??= createCanvasFirstSave(getContext);
        pending.current = true;
        setBusy(true);
        setMessage(action === "prepare" ? "正在检查本次快照及已有回执，尚未上传…"
            : action === "submit" ? "正在保存本次快照；请勿重复提交。" : "正在主动核对这个保存编号…");
        try {
            const operation = action === "prepare" ? current.prepare(getProject()) : action === "submit" ? current.submit() : current.reconcile();
            setState(current.getState());
            const result = await operation;
            if (!getContext()?.cloudCanvas || controller.current !== current) return;
            if (action === "prepare") setMessage("准备完成，尚未上传。请确认下方账号和快照概况，再点击确认保存。");
            else if (action === "submit" && "revision" in result) {
                // Only an acknowledged POST establishes an editing baseline; read-back never does.
                onSaved(result);
                setMessage(`本次提交快照已保存，版本 ${result.revision}。返回画布继续编辑后，可从同一菜单再次保存；这不代表准备之后的新修改或素材已备份。`);
            }
            else if ("status" in result) setMessage(result.status === "found-current"
                ? `找到该编号的当前云稿，版本 ${result.revision}；不代表当前编辑内容或最初快照与它一致。没有载入或覆盖画布。`
                : "暂未查到当前账号可见的记录，不等于保存失败。请保留作品和编号，不要另建编号重试。");
        } catch (error) {
            if (!getContext()?.cloudCanvas || controller.current !== current) return;
            if (error instanceof CanvasFirstSaveError && error.code === "existing_receipts" && error.creationId) {
                setMessage("当前画布已有保存回执。回执只能只读核对；请从当前账号云稿目录主动选择并确认云稿编号和版本，才能继续保存。");
            } else {
                setMessage(error instanceof CanvasFirstSaveError ? error.message : "操作未完成，请保留当前作品与回执，先核对结果；不会自动重传。");
            }
        } finally {
            if (active.current && controller.current === current) {
                setState(current.getState());
                pending.current = false;
                setBusy(false);
            }
        }
    }
    return <Modal title="手动云保存 · 首次保存" open onCancel={close} centered
        modalRender={(node) => <div data-canvas-shortcuts-ignore>{node}</div>}
        footer={<Button onClick={close}>返回画布</Button>}>
        <div className="space-y-4 text-sm leading-6" style={{ color: theme.node.text }}>
            <p>每次保存由你主动确认，不自动上传旧作品，也不会改动当前本地画布。</p>
            <p>更新已有云稿，请先点击“从当前账号云稿目录选择版本”；只有新建云稿才使用首次保存。</p>
            <p style={{ color: theme.node.muted }}>本次会保存画布正文和已上传的云端素材引用；本机素材、外部地址和未完成任务不会自动上传。重新打开云稿时会校验正文并读取当前账号拥有的云端素材，确认挂载后恢复。刷新或离开本页后，旧回执仅供核对，不能直接续存。</p>
            {!scope ? <p role="status">当前没有已确认的登录账号，不能准备或提交。请通过右上角账户入口确认连接；本地作品保持不变。</p>
                : !enabled ? <p role="status">平台尚未开放云保存；即使已经登录，也不会读取回执或提交作品。</p>
                    : <>
                        <p>保存到账号：<span className="break-all">{accountName}（{scope.accountId}）</span></p>
                        <p role="status" aria-live="polite">{message}</p>
                        {state.id ? <p className="break-all text-xs">本次保存编号：{state.id}</p> : null}
                        {state.counts ? <p>本次准备快照：{state.counts.nodes} 个节点、{state.counts.connections} 条连线、{state.counts.chats} 个助手会话。仅为数量检查，不是素材完整性证明。</p> : null}
                        <div className="flex flex-wrap gap-2">
                            {state.phase === "idle" ? <Button type="text" disabled={busy} onClick={() => void run("prepare")}>检查并准备首次保存</Button> : null}
                            {state.phase === "prepared" ? <Button disabled={busy} onClick={() => void run("submit")}>确认保存本次快照</Button> : null}
                            {state.phase === "submitted" ? <Button type="text" disabled={busy} onClick={() => void run("reconcile")}>主动核对本次保存</Button> : null}
                            <Button disabled={busy} onClick={() => onChooseCloudVersion()}>从当前账号云稿目录选择版本</Button>
                        </div>
                    </>}
            <Button type="text" disabled={busy} onClick={() => { close(); onReviewReceipts(); }}>查看已有保存回执（只读）</Button>
            <p style={{ color: theme.node.muted }}>已有回执时先核对，不另建副本。回执只另存账号、画布、保存编号，不额外存正文或密钥。关闭窗口不能撤销已经发送的请求；结果不明时请保留回执，稍后主动核对。</p>
        </div>
    </Modal>;
}
