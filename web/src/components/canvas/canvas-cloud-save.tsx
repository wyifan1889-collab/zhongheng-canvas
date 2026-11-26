import { useLayoutEffect, useRef, useState } from "react";
import { Button, Modal } from "antd";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useAccountStore } from "@/stores/use-account-store";
import type { DraftAccountScope } from "@/services/saas/drafts";
import { createCanvasVersionSession, CanvasVersionSaveError, type CanvasMountedVersion, type CanvasVersionSelection, type CanvasVersionWindowState } from "@/services/saas/canvas-version-save";
import { CanvasFirstSaveModal } from "./canvas-first-save-modal";
import { CanvasCloudLibraryModal } from "./canvas-cloud-library-modal";
import { createCanvasCloudSelection } from "./canvas-cloud-selection";

type Session = ReturnType<typeof createCanvasVersionSession>;
type Props = { localProjectId: string; mountedVersion?: CanvasMountedVersion | null; open: boolean; getProject: () => unknown; onClose: () => void; onReviewReceipts: () => void; onSaved?: (saved: { id: string }) => void };

/** Keeps only an acknowledged baseline in this page lifetime, never in the local artwork store. */
export function CanvasCloudSave(props: Props) {
    const account = useAccountStore(), scope = account.getDraftScope();
    return <BoundCloudSave key={JSON.stringify([props.localProjectId, scope?.accountId, scope?.epoch, account.site?.cloudCanvas === true, props.mountedVersion])}
        {...props} scope={scope} />;
}

function BoundCloudSave({ localProjectId, mountedVersion, open, getProject, onClose, onReviewReceipts, onSaved, scope }: Props & { scope: DraftAccountScope | null }) {
    const active = useRef(true), session = useRef<Session | null>(null);
    const parentOpen = useRef(open), directoryOpen = useRef(false);
    parentOpen.current = open;
    const selection = useRef<ReturnType<typeof createCanvasCloudSelection> | null>(null);
    const [mode, setMode] = useState<"first" | "version" | null>(null);
    const [selectVersionOpen, setSelectVersionOpen] = useState(false);
    useLayoutEffect(() => {
        active.current = true;
        if (mountedVersion && scope && mountedVersion.accountId === scope.accountId && mountedVersion.epoch === scope.epoch && mountedVersion.localProjectId === localProjectId && getContext()?.cloudCanvas) {
            const current = createCanvasVersionSession(getContext);
            current.seedMounted(mountedVersion);
            session.current = current;
        }
        return () => {
            active.current = false; directoryOpen.current = false;
            selection.current?.cancel(); selection.current = null;
            session.current?.dispose(); session.current = null;
        };
    }, []);
    useLayoutEffect(() => {
        if (!open) closeDirectory();
        setMode(open ? session.current?.getState().id ? "version" : "first" : null);
    }, [open]);
    function getContext() {
        const account = useAccountStore.getState(), current = account.getDraftScope();
        return active.current && scope && current?.accountId === scope.accountId && current.epoch === scope.epoch
            ? { ...current, localProjectId, cloudCanvas: account.site?.cloudCanvas === true } : null;
    }
    function closeDirectory() {
        directoryOpen.current = false;
        selection.current?.cancel();
        setSelectVersionOpen(false);
    }
    function closeWindow() { closeDirectory(); onClose(); }
    function resumeFromDirectorySelection(value: CanvasVersionSelection) {
        if (!getContext()?.cloudCanvas) throw new Error("cloud unavailable");
        if (session.current) throw new CanvasVersionSaveError("already_seeded", "not-sent");
        const controller = selection.current ??= createCanvasCloudSelection(
            () => active.current && parentOpen.current && directoryOpen.current,
            () => createCanvasVersionSession(getContext),
            (current) => {
                if (session.current) throw new CanvasVersionSaveError("already_seeded", "unknown");
                session.current = current;
                const id = current.getState().id;
                if (id) onSaved?.({ id });
                directoryOpen.current = false;
                setSelectVersionOpen(false); setMode("version");
            },
        );
        return controller.confirm(value);
    }
    if (!open) return null;
    if (selectVersionOpen) return <CanvasCloudLibraryModal localProjectId={localProjectId}
        onSelectVersion={resumeFromDirectorySelection} onClose={closeDirectory} />;
    if (mode === "version" && session.current) return <VersionSaveDialog session={session.current}
        getProject={getProject} onClose={closeWindow} onReviewReceipts={onReviewReceipts} onSaved={onSaved} />;
    return mode === "first" ? <CanvasFirstSaveModal localProjectId={localProjectId} getProject={getProject}
        onClose={closeWindow} onReviewReceipts={onReviewReceipts} onChooseCloudVersion={() => {
            directoryOpen.current = true; setSelectVersionOpen(true);
        }} onSaved={(saved) => {
            if (!getContext()?.cloudCanvas) return;
            onSaved?.(saved);
            const current = session.current ??= createCanvasVersionSession(getContext);
            current.seedCreation(saved);
        }} /> : null;
}

function phaseMessage(phase: CanvasVersionWindowState["phase"]) {
    if (phase === "conflict") return "云端已有不同版本，本次保存未覆盖它。当前编辑内容仍保留在本机，云端保留现有版本；不是两份都已云端备份。请先主动核对，不会自动合并或覆盖。";
    if (phase === "unknown" || phase === "submitting") return "先前更新结果尚未确认。关闭窗口不能撤销已发送请求；目前只允许主动核对，不会重新提交。";
    if (phase === "blocked" || phase === "closed") return "本次不能继续写入，请保留本机作品和回执，先主动核对已有编号。";
    return "本页已确认云稿版本基准。检查当前快照后，由你确认保存；打开窗口不会读取或提交正文。";
}

function VersionSaveDialog({ session, getProject, onClose, onReviewReceipts, onSaved }: Pick<Props, "getProject" | "onClose" | "onReviewReceipts" | "onSaved"> & { session: Session }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const accountName = useAccountStore((state) => state.user?.name ?? "");
    const windowRef = useRef<ReturnType<Session["open"]> | null>(null), active = useRef(true), pending = useRef(false);
    const [state, setState] = useState<CanvasVersionWindowState>({ phase: "idle" });
    const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
    useLayoutEffect(() => {
        active.current = true;
        const current = session.open();
        windowRef.current = current;
        const initial = current.getState();
        setState(initial); setMessage(phaseMessage(initial.phase));
        return () => { active.current = false; current.close(); windowRef.current = null; };
    }, [session]);
    function close() { active.current = false; windowRef.current?.close(); onClose(); }
    async function run(action: "prepare" | "submit" | "reconcile") {
        const current = windowRef.current;
        if (!active.current || pending.current || !current) return;
        pending.current = true; setBusy(true);
        setMessage(action === "prepare" ? "正在检查本次快照，尚未提交…" : action === "submit" ? "正在保存新版本，请勿重复提交…" : "正在主动核对云端当前版本…");
        try {
            const operation = action === "prepare" ? current.prepare(getProject()) : action === "submit" ? current.submit() : current.reconcile();
            setState(current.getState());
            const result = await operation;
            if (!active.current || windowRef.current !== current) return;
            if (action === "submit" && "revision" in result) onSaved?.({ id: result.id });
            if (action === "prepare") setMessage("快照准备完成，尚未上传。确认后仅按下方基准版本保存；若云端已有其他更新，将拒绝覆盖。");
            else if (action === "submit" && "revision" in result) setMessage(`本次快照已保存为版本 ${result.revision}。返回画布继续编辑后可再次保存；不代表之后的新修改或素材已经备份。`);
            else if ("status" in result) setMessage(result.status === "found-current"
                ? `查到当前云端版本 ${result.revision}。这不能证明刚才的更新成功，也不会解除冲突或未确认状态；本机内容未被替换。`
                : "暂未查到当前账号可见的记录，不等于更新失败；不会重新提交或新建副本，请保留本机作品与回执。");
        } catch (error) {
            if (!active.current || windowRef.current !== current) return;
            setMessage(current.getState().phase === "conflict" ? phaseMessage("conflict")
                : error instanceof CanvasVersionSaveError ? error.message : "操作未完成，请保留当前作品与回执，先主动核对；不会自动重传。");
        } finally {
            if (active.current && windowRef.current === current) {
                setState(current.getState()); pending.current = false; setBusy(false);
            }
        }
    }
    return <Modal title="手动云保存 · 再次保存" open centered onCancel={close}
        modalRender={(node) => <div data-canvas-shortcuts-ignore>{node}</div>}
        footer={<Button onClick={close}>返回画布，保留本机内容</Button>}>
        <div className="space-y-4 text-sm leading-6" style={{ color: theme.node.text }}>
            <p>保存到账号：<span className="break-all">{accountName}</span></p>
            <p style={{ color: theme.node.muted }}>仅在本页已确认的版本上继续保存。已上传的云端素材会随云稿引用恢复；本机素材、外部地址和未完成任务不会自动上传。刷新、切项目或切账号后，不会凭回执猜测版本续存。</p>
            {state.id ? <p className="break-all text-xs">云稿编号：{state.id}</p> : null}
            {state.expectedRevision ? <p>本次基准版本：{state.expectedRevision}{state.observedRevision ? `；服务器提示的当前版本：${state.observedRevision}（不会自动采用）` : ""}</p> : null}
            <p role="status" aria-live="polite">{message}</p>
            {state.counts ? <p>本次快照：{state.counts.nodes} 个节点、{state.counts.connections} 条连线、{state.counts.chats} 个助手会话。不是素材完整性证明。</p> : null}
            <div className="flex flex-wrap gap-2">
                {state.phase === "idle" ? <Button type="text" disabled={busy} onClick={() => void run("prepare")}>检查并准备再次保存</Button> : null}
                {state.phase === "prepared" ? <Button disabled={busy} onClick={() => void run("submit")}>确认保存新版本</Button> : null}
                {["saved", "conflict", "unknown", "blocked"].includes(state.phase) ? <Button type="text" disabled={busy} onClick={() => void run("reconcile")}>只读核对当前云稿</Button> : null}
                <Button type="text" disabled={busy} onClick={() => { close(); onReviewReceipts(); }}>查看保存回执（只读）</Button>
            </div>
            <p style={{ color: theme.node.muted }}>不会自动覆盖、合并、另存或重试。关闭不能撤销已经发送的请求；发现冲突或结果不明时，本页后续仅可核对。</p>
        </div>
    </Modal>;
}
