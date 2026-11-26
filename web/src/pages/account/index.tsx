import { useEffect, useState } from "react";
import { ArrowLeft, Flag, Loader2 } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Alert, CreationUiBoundary } from "@/components/creation/ui";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

import { AccountPanel } from "@/components/account/account-panel";
import { AccountAuth } from "@/components/account/account-auth";
import AbuseReportDialog from "@/components/account/abuse-report-dialog";
import { WalletLedger } from "@/components/account/wallet-ledger";
import { PlatformModelCatalog, usePlatformOverview } from "@/components/account/platform-overview";
import { clearAccountReturn, readAccountReturn } from "@/services/saas/account-return";
import { safeAccountReturn } from "@/services/saas/account-navigation";
import { useAccountStore } from "@/stores/use-account-store";

function AccountDashboard({ onAuthenticated }: { onAuthenticated: () => void }) {
    const account = useAccountStore();
    const { current, references, referenceFailed } = usePlatformOverview();
    const [tab, setTab] = useState("credits"), [reportOpen, setReportOpen] = useState(false);
    const selected = account.user ? tab : "security";
    const ready = current?.status === "ready" ? current : null;
    const balancePlaceholder = current?.status === "unavailable" ? "暂不可用" : "读取中…";

    return <>
        <header hidden={!account.user} className="mb-7">
            <h1 className="m-0 text-xl font-semibold">个人中心</h1>
            <p className="mb-0 mt-2 break-words text-sm text-muted-foreground">{account.user?.name}</p>
        </header>
        <dl aria-label="账户摘要" aria-live="polite" hidden={!account.user} className={`${!account.user ? "hidden" : "grid"} mb-7 grid-cols-2 gap-x-6 gap-y-5 border-y border-border py-6 sm:grid-cols-3`}>
            <div className="min-w-0"><dt className="text-sm text-muted-foreground">可用积分</dt><dd className="mb-0 ml-0 mt-2 break-all text-2xl font-semibold tabular-nums">{ready?.wallet.availableUnits ?? balancePlaceholder}</dd></div>
            <div className="min-w-0"><dt className="text-sm text-muted-foreground">冻结积分</dt><dd className="mb-0 ml-0 mt-2 break-all text-2xl font-semibold tabular-nums">{ready?.wallet.reservedUnits ?? balancePlaceholder}</dd></div>
            <div className="col-span-2 min-w-0 sm:col-span-1"><dt className="text-sm text-muted-foreground">我的画布</dt><dd className="mb-0 ml-0 mt-2"><Link to="/projects" className="text-sm text-primary underline-offset-4 hover:underline">打开画布库</Link><p className="mb-0 mt-1 text-xs text-muted-foreground">本机作品保存在当前浏览器</p></dd></div>
        </dl>
        {current?.status === "unavailable" && <Alert className="mb-5" type="warning" showIcon title="积分和模型价格暂时无法读取" action={<Button size="sm" variant="outline" disabled={account.busy} onClick={() => void account.refresh()}>重新读取</Button>} />}
        <Tabs value={selected} onValueChange={setTab} className={!account.user ? "mx-auto w-full max-w-sm py-10" : undefined}>
            <TabsList variant="line" aria-label="个人中心" hidden={!account.user} className={`${!account.user ? "hidden" : ""} h-11 w-full justify-start border-b border-border pb-1`}>
                <TabsTrigger value="credits" className="flex-none px-3 sm:px-5">积分记录</TabsTrigger>
                <TabsTrigger value="pricing" className="flex-none px-3 sm:px-5">模型价格</TabsTrigger>
                <TabsTrigger value="security" className="flex-none px-3 sm:px-5">账户安全</TabsTrigger>
            </TabsList>
            <TabsContent value="credits" forceMount hidden={selected !== "credits"} className={selected !== "credits" ? "hidden" : "pt-5"}><WalletLedger /></TabsContent>
            <TabsContent value="pricing" forceMount hidden={selected !== "pricing"} className={selected !== "pricing" ? "hidden" : "pt-5"}>
                {ready ? <PlatformModelCatalog models={ready.models} pricing={ready.pricing} references={references} referenceFailed={referenceFailed} />
                    : current?.status !== "unavailable" ? <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在读取模型价格…</p> : null}
            </TabsContent>
            <TabsContent value="security" forceMount hidden={selected !== "security"} className={selected !== "security" ? "hidden" : "pt-6"}>
                <AccountPanel variant={account.user ? "security" : "auth"} onAuthenticated={onAuthenticated} />
                {account.getDraftScope() && <div className="mt-6 border-t border-border pt-4"><Button variant="ghost" onClick={() => setReportOpen(true)}><Flag className="size-4" />投诉与举报</Button><AbuseReportDialog open={reportOpen} onOpenChange={setReportOpen} /></div>}
            </TabsContent>
        </Tabs>
    </>;
}

/** Mail return only; no analytics, Agent auto-connect or provider-config import on this route. */
export default function AccountPage() {
    const [link] = useState(readAccountReturn);
    const navigate = useNavigate();
    const location = useLocation();
    const accountRoute = /^\/account\/?$/.test(location.pathname);
    const from = safeAccountReturn(location.state?.from);
    useEffect(() => () => clearAccountReturn(), []);
    if (!accountRoute) return (
        <CreationUiBoundary active presentationKey={`${location.pathname}${location.search}${location.hash}`}>
            <main className="flex h-dvh flex-col overflow-y-auto bg-background px-6 py-5 text-foreground sm:px-8">
                <Link to="/" className="inline-flex min-h-10 w-fit shrink-0 items-center gap-2 rounded-lg text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
                    <ArrowLeft className="size-4" aria-hidden />返回工作台
                </Link>
                <div className="flex flex-1 items-center justify-center py-10 sm:py-14">
                    <AccountAuth link={link} onAuthenticated={() => navigate(from, { replace: true })} />
                </div>
            </main>
        </CreationUiBoundary>
    );
    return (
        <CreationUiBoundary active presentationKey={`${location.pathname}${location.search}${location.hash}`}><main className="h-dvh overflow-y-auto bg-background px-4 py-5 text-foreground sm:px-8 sm:py-7">
            <div className="mx-auto max-w-5xl">
                <Link to="/" className="mb-7 inline-flex min-h-10 items-center gap-2 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"><ArrowLeft className="size-4" aria-hidden />返回工作台</Link>
                {!link.resetToken && !link.invalidLink ? <AccountDashboard onAuthenticated={() => navigate(from, { replace: true })} /> : <div className="flex justify-center py-10"><AccountAuth link={link} onAuthenticated={() => navigate(from, { replace: true })} /></div>}
            </div>
        </main></CreationUiBoundary>
    );
}
