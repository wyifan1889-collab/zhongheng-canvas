import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAccountStore } from "@/stores/use-account-store";
import { ContentSafetyError, createContentSafetyClient, type AbuseReportView, type ContentSafetyScope } from "@/services/saas/content-safety";

function currentScope(): ContentSafetyScope | null {
    const account = useAccountStore.getState(), scope = account.getDraftScope();
    return scope && account.user ? { ...scope, role: account.user.role } : null;
}

export default function AbuseReportDialog(props: { open: boolean; onOpenChange(open: boolean): void }) {
    const account = useAccountStore(), scope = account.getDraftScope();
    return scope && account.user ? <AccountAbuseReport key={`${scope.accountId}:${scope.epoch}`} {...props} scope={{ ...scope, role: account.user.role }} /> : null;
}

function AccountAbuseReport({ open, onOpenChange, scope }: { open: boolean; onOpenChange(open: boolean): void; scope: ContentSafetyScope }) {
    const id = useId(), [subject, setSubject] = useState(""), [details, setDetails] = useState(""), [lookupId, setLookupId] = useState("");
    const [pendingId, setPendingId] = useState<string | null>(null), [item, setItem] = useState<AbuseReportView | null>(null);
    const [busy, setBusy] = useState(false), [error, setError] = useState("");
    const running = useRef(false), returnFocus = useRef<HTMLElement | null>(null), [client, setClient] = useState<ReturnType<typeof createContentSafetyClient> | null>(null);
    useEffect(() => {
        const instance = createContentSafetyClient({ scope, getScope: currentScope, onAccountInvalidated: () => {
            const next = currentScope(); if (next?.accountId === scope.accountId && next.epoch === scope.epoch && next.role === scope.role) void useAccountStore.getState().refresh();
        } });
        setClient(instance); return () => instance.close();
    }, [scope.accountId, scope.epoch, scope.role]);
    const current = () => { try { if (!client) return false; client.syncScope(); return true; } catch { return false; } };
    async function submit() {
        if (!client || running.current || pendingId || item || !subject.trim() || !details.trim()) return;
        running.current = true; setBusy(true); setError("");
        const submissionId = crypto.randomUUID(); setPendingId(submissionId); setLookupId(submissionId);
        try {
            const receipt = await client.submitReport({ id: submissionId, subject, details });
            if (current()) { setItem(receipt); setPendingId(null); }
        } catch (failure) {
            if (current()) {
                setError(failure instanceof ContentSafetyError ? failure.message : "提交结果尚未确认，请按原编号查询。");
                if (failure instanceof ContentSafetyError && failure.outcome !== "unknown") setPendingId(null);
            }
        } finally { running.current = false; if (current()) setBusy(false); }
    }
    async function lookup() {
        if (!client || running.current || !lookupId.trim()) return;
        running.current = true; setBusy(true); setError("");
        try {
            const receipt = await client.readOwnReport(pendingId ?? lookupId.trim());
            if (current()) { setItem(receipt); setPendingId(null); }
        } catch (failure) { if (current()) setError(failure instanceof ContentSafetyError ? failure.message : "读取未完成，请保留原编号后手动重试。"); }
        finally { running.current = false; if (current()) setBusy(false); }
    }
    return <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg"
            onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
            onCloseAutoFocus={event => { event.preventDefault(); if (current() && returnFocus.current?.isConnected) returnFocus.current.focus(); }}>
            <DialogHeader><DialogTitle>投诉与举报</DialogTitle><DialogDescription>提交后可按本人回执编号查询；“已受理”表示管理员已记录收到，不代表已裁定或退款。</DialogDescription></DialogHeader>
            <form className="space-y-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
                <label className="block space-y-1.5" htmlFor={`${id}-subject`}><span>投诉主题</span><Input id={`${id}-subject`} value={subject} onChange={event => setSubject(event.target.value)} disabled={busy || !!pendingId || !!item} /></label>
                <label className="block space-y-1.5" htmlFor={`${id}-details`}><span>情况说明</span><Textarea id={`${id}-details`} rows={5} value={details} onChange={event => setDetails(event.target.value)} disabled={busy || !!pendingId || !!item} placeholder="说明遇到的问题及相关作品或任务编号，请勿填写密码或密钥。" /></label>
                <Button type="submit" disabled={!client || busy || !!pendingId || !!item || !subject.trim() || !details.trim()} aria-busy={busy}>提交投诉</Button>
            </form>
            {error && <p role="alert" className="m-0 break-words text-sm text-destructive">{error}</p>}
            {pendingId && <p role="status" className="m-0 break-all text-sm">提交结果待核对，请保留原编号：{pendingId}；查询尚未找到也不能据此重复提交。</p>}
            <div className="space-y-2 border-t border-border pt-4">
                <label className="block space-y-1.5" htmlFor={`${id}-lookup`}><span>本人回执编号</span><Input id={`${id}-lookup`} value={lookupId} onChange={event => setLookupId(event.target.value)} disabled={busy || !!pendingId} autoComplete="off" /></label>
                <Button variant="outline" onClick={() => void lookup()} disabled={!client || busy || !lookupId.trim()} aria-busy={busy}>查询原投诉</Button>
                <p className="m-0 text-xs leading-5 text-muted-foreground">请保留回执编号；刷新页面后可使用原编号查询，查询操作不会重复提交。</p>
            </div>
            {item && <section aria-label="投诉回执" className="space-y-2 rounded-lg border border-border p-3 text-sm">
                <p role="status" className="m-0 font-medium">{item.status === "received" ? "已受理" : "已提交"}</p>
                <p className="m-0 break-all">回执：{item.id}</p><p className="m-0 break-words font-medium">{item.subject}</p>
                <p className="m-0 whitespace-pre-wrap break-words">{item.details}</p>
                <Button variant="outline" onClick={() => { setItem(null); setSubject(""); setDetails(""); setLookupId(""); setError(""); }} disabled={busy}>填写另一条投诉</Button>
            </section>}
        </DialogContent>
    </Dialog>;
}
