import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Select, Spin, Tabs, Tag, theme } from "antd";

import { useCopyText } from "@/hooks/use-copy-text";
import { useAccountStore } from "@/stores/use-account-store";
import { CanvasSharingError, createCanvasSharingClient, type CanvasMember, type CanvasShareRole, type CanvasSharingState } from "@/services/saas/canvas-sharing";
import type { DraftAccountScope } from "@/services/saas/drafts";

type Props = { open: boolean; canvasId: string; mode?: "manage" | "information"; onClose: () => void };
type Confirmation = { kind: "reset"; role: CanvasShareRole } | { kind: "remove"; member: CanvasMember };
const roleOptions = [{ value: "viewer", label: "查看者" }, { value: "editor", label: "编辑者" }];
const roleName = (role: string) => role === "owner" ? "所有者" : role === "editor" ? "编辑者" : "查看者";

/** Every open/account lifetime gets fresh state; invitation tokens remain in memory only. */
export function CanvasShareDialog({ open, canvasId, mode = "manage", onClose }: Props) {
    const account = useAccountStore();
    const scope = account.getDraftScope();
    if (!open) return null;
    if (!scope || account.site?.cloudCanvas !== true) return <Modal open centered title="分享画布" onCancel={onClose} footer={<Button onClick={onClose}>返回画布</Button>}>
        <p role="status">请先确认登录账户并开启云端画布，再管理分享。</p>
    </Modal>;
    // Do not mount the owner client, its effects, or owner-only content for members.
    if (mode === "information") return <Modal open centered title="分享协作" onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>}
        modalRender={(node) => <div data-canvas-shortcuts-ignore>{node}</div>}>
        <p role="status">只有所有者可管理分享</p>
    </Modal>;
    return <ShareDialog key={JSON.stringify([scope.accountId, scope.epoch, canvasId])} canvasId={canvasId} scope={scope} onClose={onClose} />;
}

function ShareDialog({ canvasId, scope, onClose }: Omit<Props, "open"> & { scope: DraftAccountScope }) {
    const { token } = theme.useToken();
    const copyText = useCopyText();
    const [client] = useState(() => createCanvasSharingClient(() => {
        const current = useAccountStore.getState().getDraftScope();
        return current?.accountId === scope.accountId && current.epoch === scope.epoch ? current : null;
    }));
    const [state, setState] = useState<CanvasSharingState | null>(null);
    const [linkRole, setLinkRole] = useState<CanvasShareRole>("viewer");
    const [userId, setUserId] = useState("");
    const [memberRole, setMemberRole] = useState<CanvasShareRole>("viewer");
    const [busy, setBusy] = useState(false);
    const [uncertain, setUncertain] = useState(false);
    const [notice, setNotice] = useState("正在读取当前分享设置…");
    const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
    const active = useRef(false);
    const inFlight = useRef(false);
    const loaded = useRef(false);
    const sequence = useRef(0);

    function current() {
        const next = useAccountStore.getState().getDraftScope();
        return active.current && next?.accountId === scope.accountId && next.epoch === scope.epoch;
    }
    useLayoutEffect(() => {
        active.current = true;
        return () => { active.current = false; };
    }, []);

    async function read() {
        if (inFlight.current || !current()) return;
        inFlight.current = true;
        const request = ++sequence.current;
        setBusy(true); setConfirmation(null); setNotice("正在读取核对分享和成员状态…");
        try {
            const next = await client.read(canvasId);
            if (!current() || request !== sequence.current) return;
            setState(next); setUncertain(false);
            if (!loaded.current) setLinkRole(next.share?.role ?? "viewer");
            loaded.current = true;
            setNotice("已读取当前状态。只有所有者可以管理分享和成员。");
        } catch (error) {
            if (current() && request === sequence.current) {
                setState(null);
                setNotice(error instanceof CanvasSharingError ? error.message : "分享状态读取未完成，请检查连接后重新读取。");
            }
        } finally {
            inFlight.current = false;
            if (current() && request === sequence.current) setBusy(false);
        }
    }
    useEffect(() => { void read(); }, []);

    async function mutate(action: () => Promise<CanvasSharingState>, success: string) {
        if (inFlight.current || uncertain || !state || !current()) return;
        inFlight.current = true;
        const request = ++sequence.current;
        setBusy(true); setConfirmation(null); setNotice("正在提交，请等待结果确认…");
        try {
            const next = await action();
            if (!current() || request !== sequence.current) return;
            setState(next); setNotice(success);
        } catch (error) {
            if (current() && request === sequence.current) {
                setUncertain(!(error instanceof CanvasSharingError) || error.outcome === "unknown");
                if (error instanceof CanvasSharingError && ["account_changed", "account_context_required", "unauthorized", "not_found"].includes(error.code)) setState(null);
                setNotice(error instanceof CanvasSharingError ? error.message : "操作结果尚未确认，请先读取核对，不要重复提交。");
            }
        } finally {
            inFlight.current = false;
            if (current() && request === sequence.current) setBusy(false);
        }
    }
    function createLink(reset = false, selectedRole = linkRole) {
        if (!state) return;
        const snapshot = state;
        void mutate(async () => ({ ...snapshot, share: await client.createLink(canvasId, { role: selectedRole, ...(reset ? { reset: true } : {}) }) }),
            reset ? "链接已重置。旧链接无法再加入，已加入成员的权限保持不变。" : "分享链接已生成，请仅转交给可信任的人。");
    }
    function updateMember(targetUserId: string, selectedRole: CanvasShareRole, adding = false) {
        if (!state) return;
        const snapshot = state;
        void mutate(async () => {
            const member = await client.addMember(canvasId, { userId: targetUserId, role: selectedRole });
            const members = snapshot.members.some((item) => item.userId === member.userId)
                ? snapshot.members.map((item) => item.userId === member.userId ? member : item)
                : [...snapshot.members, member];
            if (current() && adding) setUserId("");
            return { ...snapshot, members };
        }, "成员设置已更新。待加入用户仍需用当前链接登录并接受邀请。");
    }
    function removeMember(member: CanvasMember) {
        if (!state || member.role === "owner") return;
        const snapshot = state;
        void mutate(async () => {
            await client.removeMember(canvasId, member.userId);
            return { ...snapshot, members: snapshot.members.filter((item) => item.userId !== member.userId) };
        }, "成员已移除。如需阻止通过旧链接重新加入，请同时重置分享链接。");
    }
    function close() { active.current = false; sequence.current++; onClose(); }

    const blocked = busy || uncertain || !state;
    const share = state?.share;
    const selectedLink = share?.role === linkRole ? share : null;
    const shareUrl = selectedLink ? new URL(`/canvas/join/${selectedLink.token}`, window.location.origin).href : "";

    return <Modal open centered title="分享画布" width={600} onCancel={close} footer={<Button onClick={close}>返回画布</Button>}
        modalRender={(node) => <div data-canvas-shortcuts-ignore
            onKeyDown={(event) => { if (event.code === "Space") event.stopPropagation(); }}
            onKeyUp={(event) => { if (event.code === "Space") event.stopPropagation(); }}>{node}</div>}>
        <div className="space-y-4 text-sm leading-6" style={{ color: token.colorText }}>
            <Alert type="info" showIcon title="共享当前云稿内容" description="成员可以查看当前云稿的聊天、提示词、插件内容和引用素材。编辑者可以修改云稿，新上传素材归上传者自己的账户。请先保存需要共享的内容。" />
            <div className="flex items-start justify-between gap-3">
                <div role="status" aria-live="polite">{busy ? <Spin size="small" className="mr-2" /> : null}{notice}</div>
                <Button type="text" disabled={busy} onClick={() => void read()}>读取核对</Button>
            </div>
            {uncertain ? <Alert type="warning" showIcon title="先核对，再继续管理" description="上次操作可能已经生效。读取核对成功前暂停写入，不会自动重复提交。" /> : null}
            {state ? <>
                <section aria-label="分享链接" className="space-y-2">
                    <h3 className="font-medium">通过链接邀请</h3>
                    <Tabs activeKey={linkRole} onChange={(value) => { setLinkRole(value as CanvasShareRole); setConfirmation(null); }} items={roleOptions.map((item) => ({ key: item.value, label: item.label, disabled: busy }))} />
                    <p style={{ color: token.colorTextSecondary }}>{linkRole === "viewer" ? "查看者可以打开共享云稿，不能修改。" : "编辑者可以修改共享云稿；多人保存仍可能发生版本冲突。"}</p>
                    {selectedLink ? <>
                        <Input aria-label="当前分享链接" readOnly value={uncertain ? "请先读取核对当前链接" : shareUrl} />
                        <div className="flex flex-wrap gap-2">
                            <Button type="text" disabled={blocked} onClick={() => { if (current() && !inFlight.current && !uncertain) copyText(shareUrl, "分享链接已复制"); }}>复制链接</Button>
                            <Button type="text" disabled={blocked} onClick={() => setConfirmation({ kind: "reset", role: linkRole })}>重置链接</Button>
                        </div>
                        {selectedLink.expiresAt ? <p style={{ color: token.colorTextSecondary }}>到期时间：{new Date(selectedLink.expiresAt).toLocaleString("zh-CN")}</p> : null}
                    </> : share ? <>
                        <p style={{ color: token.colorTextSecondary }}>当前链接授予{roleName(share.role)}权限。切换为{roleName(linkRole)}需要重置链接。</p>
                        <Button type="text" disabled={blocked} onClick={() => setConfirmation({ kind: "reset", role: linkRole })}>重置为{roleName(linkRole)}链接</Button>
                    </> : <Button type="text" disabled={blocked} onClick={() => createLink()}>生成{roleName(linkRole)}链接</Button>}
                    <p className="text-xs" style={{ color: token.colorTextSecondary }}>链接可以转交，持有人登录并加入后才获得访问权。重置只使旧链接无法继续加入，不会撤销已加入成员。</p>
                </section>
                <section aria-label="画布成员" className="space-y-3">
                    <h3 className="font-medium">成员</h3>
                    <div className="flex flex-wrap gap-2">
                        <Input className="min-w-40 flex-1" aria-label="受邀用户编号" placeholder="输入已注册用户的用户编号" value={userId} disabled={blocked} onChange={(event) => setUserId(event.target.value)} />
                        <Select<CanvasShareRole> aria-label="邀请角色" value={memberRole} options={roleOptions} disabled={blocked} onChange={setMemberRole} />
                        <Button type="text" disabled={blocked || !userId.trim()} onClick={() => updateMember(userId, memberRole, true)}>添加成员</Button>
                    </div>
                    <p className="text-xs" style={{ color: token.colorTextSecondary }}>添加成员仅记录待加入邀请，请自行向对方提供当前链接。待加入用户接受时，按邀请角色与链接角色中较低权限加入；已加入用户将直接更新角色。</p>
                    <ul aria-label="画布成员列表" className="max-h-56 space-y-2 overflow-y-auto">
                        {state.members.map((member) => <li key={member.userId} className="flex flex-wrap items-center justify-between gap-2 border-b py-2" style={{ borderColor: token.colorBorderSecondary }}>
                            <div className="min-w-0 flex-1 break-all"><span>{member.userId}</span> <Tag>{member.joinedAt === null ? "待加入" : "已加入"}</Tag></div>
                            {member.role === "owner" ? <span style={{ color: token.colorTextSecondary }}>所有者</span> : <div className="flex items-center gap-1">
                                <Select<CanvasShareRole> aria-label={`${member.userId}的角色`} value={member.role} options={roleOptions} disabled={blocked} onChange={(value) => updateMember(member.userId, value)} />
                                <Button type="text" danger disabled={blocked} onClick={() => setConfirmation({ kind: "remove", member })}>移除</Button>
                            </div>}
                        </li>)}
                    </ul>
                </section>
                {confirmation ? <div className="space-y-2 rounded-lg border p-3" role="alert" style={{ background: token.colorWarningBg, borderColor: token.colorWarningBorder }}>
                    <p>{confirmation.kind === "reset"
                        ? `确认重置为${roleName(confirmation.role)}链接？旧链接将失效，已加入成员的角色和访问权保持不变。`
                        : `确认移除用户 ${confirmation.member.userId}？对方仍可通过当前有效链接重新加入；需要时请另行重置链接。`}</p>
                    <div className="flex gap-2">
                        <Button danger type="primary" disabled={blocked} onClick={() => confirmation.kind === "reset" ? createLink(true, confirmation.role) : removeMember(confirmation.member)}>确认{confirmation.kind === "reset" ? "重置" : "移除"}</Button>
                        <Button type="text" onClick={() => setConfirmation(null)}>取消</Button>
                    </div>
                </div> : null}
            </> : null}
        </div>
    </Modal>;
}
