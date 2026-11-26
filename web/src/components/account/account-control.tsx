import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { App, Modal, Popover, Tag } from "@/components/creation/ui";
import { ChevronRight, Crown, HardDrive, LogOut, Settings2, ShieldCheck, UserRound, WalletCards } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

import { AccountPanel } from "./account-panel";
import { useAccountStore } from "@/stores/use-account-store";
import { fetchPlatformWallet, type PlatformWallet } from "@/services/saas/platform";
import { createPlatformWalletReader } from "@/services/saas/platform-wallet-refresh";
import { createMediaClient, type CloudMediaQuota } from "@/services/api/media";
import { useCreationUi } from "@/components/creation/ui/context";

const cloudMediaClient = createMediaClient(() => useAccountStore.getState().user?.id ?? null);

function formatBytes(bytes: number) {
    if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function AccountMenuItem({ icon, label, detail, onClick, danger = false }: { icon: ReactNode; label: string; detail?: string; onClick: () => void; danger?: boolean }) {
    const owned = useCreationUi();
    return (
        <button
            type="button"
            className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition ${owned ? danger ? "text-destructive hover:bg-accent" : "text-foreground hover:bg-accent" : danger ? "text-red-600 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/30" : "text-stone-800 hover:bg-stone-100 dark:text-stone-100 dark:hover:bg-white/10"}`}
            onClick={onClick}
        >
            <span className={owned ? "shrink-0 text-muted-foreground" : "flex size-8 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-600 dark:bg-white/10 dark:text-stone-300"}>{icon}</span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{label}</span>
                {detail ? <span className="block truncate text-xs text-stone-500 dark:text-stone-400">{detail}</span> : null}
            </span>
            <ChevronRight className="size-4 shrink-0 text-stone-400" />
        </button>
    );
}

function AccountMenu({
    user,
    wallet,
    walletState,
    quota,
    quotaState,
    cloudMediaEnabled,
    showSubscriptionNotice = false,
    onNavigate,
    onSignOut,
}: {
    user: NonNullable<ReturnType<typeof useAccountStore.getState>["user"]>;
    wallet: PlatformWallet | null;
    walletState: "idle" | "loading" | "ready" | "unavailable";
    quota: CloudMediaQuota | null;
    quotaState: "idle" | "loading" | "ready" | "unavailable";
    cloudMediaEnabled: boolean;
    showSubscriptionNotice?: boolean;
    onNavigate: (path: string) => void;
    onSignOut: () => void;
}) {
    const owned = useCreationUi();
    const initial = user.name.trim().slice(0, 1).toUpperCase() || "U";
    const used = !cloudMediaEnabled ? "未开启" : quotaState === "loading" ? "读取中…" : quotaState === "ready" && quota ? formatBytes(quota.usedBytes) : quotaState === "unavailable" ? "容量暂不可用" : "容量未知";
    const limit = cloudMediaEnabled && quotaState === "ready" && quota ? formatBytes(quota.quotaBytes) : "";
    if (owned) return <div className="w-[260px] max-w-[calc(100vw-32px)] rounded-xl border border-border bg-popover p-2 text-popover-foreground shadow-lg" data-canvas-shortcuts-ignore>
        <div className="space-y-1 border-b border-border px-3 py-2.5">
            <p className="truncate text-sm font-medium">{user.name}</p>
            <p className="truncate text-xs text-muted-foreground">{user.email ?? "账号邮箱未返回"}</p>
            <p className="break-all text-xs text-muted-foreground">{walletState === "loading" ? "积分读取中…" : walletState === "ready" && wallet ? `可用 ${wallet.availableUnits} · 冻结 ${wallet.reservedUnits} 积分` : "积分暂不可用"}</p>
            <p className="break-words text-xs text-muted-foreground">云存储：{used}{limit ? ` / ${limit}` : ""}</p>
        </div>
        <div className="pt-1">
            <AccountMenuItem icon={<UserRound className="size-4" />} label="账户" onClick={() => onNavigate("/account")} />
            <AccountMenuItem icon={<Settings2 className="size-4" />} label="设置" onClick={() => onNavigate("/config")} />
            {user.role === "admin" ? <AccountMenuItem icon={<ShieldCheck className="size-4" />} label="平台管理后台" onClick={() => onNavigate("/admin")} /> : null}
            <AccountMenuItem icon={<LogOut className="size-4" />} label="退出登录" onClick={onSignOut} danger />
        </div>
    </div>;
    return (
        <div className="w-[328px] max-w-[calc(100vw-24px)] rounded-2xl border border-border bg-popover p-3 text-popover-foreground shadow-[0_20px_60px_oklch(0_0_0_/_24%)]" data-canvas-shortcuts-ignore>
            <div className="flex items-center gap-3 rounded-xl bg-stone-100 px-3 py-3 dark:bg-white/10">
                <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary text-base font-semibold text-primary-foreground">{initial}</span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{user.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-stone-500 dark:text-stone-400">{user.email ?? "账号邮箱未返回"}</span>
                    <span className="mt-1 flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400">
                        <Tag color={user.role === "admin" ? "gold" : "default"} className="!m-0">
                            {user.role === "admin" ? "超级管理员" : "普通用户"}
                        </Tag>
                        <span>已验证账户</span>
                    </span>
                </span>
                <ShieldCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-label="账户已验证" />
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-xl border border-stone-200 px-3 py-2.5 dark:border-stone-700">
                    <div className="flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400"><WalletCards className="size-3.5" />可用余额</div>
                    <div className="mt-1 break-all text-base font-semibold tabular-nums">{walletState === "loading" ? "…" : walletState === "ready" ? `${wallet?.availableUnits ?? "—"}` : "—"}<span className="ml-1 text-xs font-normal text-stone-500">积分</span></div>
                    <div className="mt-1 break-all text-xs tabular-nums text-stone-500">冻结 {walletState === "ready" ? wallet?.reservedUnits ?? "—" : "—"} 积分</div>
                </div>
                <div className="rounded-xl border border-stone-200 px-3 py-2.5 dark:border-stone-700">
                    <div className="flex items-center gap-1.5 text-xs text-stone-500 dark:text-stone-400"><HardDrive className="size-3.5" />云存储</div>
                    <div className="mt-1 text-base font-semibold tabular-nums">{used}{limit ? <span className="ml-1 text-xs font-normal text-stone-500">/ {limit}</span> : null}</div>
                </div>
            </div>

            {showSubscriptionNotice ? <p className="mt-2 px-1 text-xs text-muted-foreground">订阅功能尚未开放；积分以平台实际余额为准。</p> : null}

            <div className="mt-3 space-y-0.5 border-t border-stone-200 pt-2 dark:border-stone-700">
                <AccountMenuItem icon={<UserRound className="size-4" />} label="账户中心" detail="账户资料、验证和安全设置" onClick={() => onNavigate("/account")} />
                <AccountMenuItem icon={<HardDrive className="size-4" />} label="我的资产" detail="管理本机和云端素材" onClick={() => onNavigate("/assets")} />
                <AccountMenuItem icon={<Settings2 className="size-4" />} label="个人设置" detail="界面偏好、同步与本机存储" onClick={() => onNavigate("/config")} />
                {user.role === "admin" ? <AccountMenuItem icon={<ShieldCheck className="size-4" />} label="平台管理后台" detail="统一配置渠道、模型、价格和余额" onClick={() => onNavigate("/admin")} /> : null}
                <AccountMenuItem icon={<LogOut className="size-4" />} label="退出登录" onClick={onSignOut} danger />
            </div>
        </div>
    );
}

export function AccountControl({ className, style, variant = "default", compact = false, showCredits = false }: { className: string; style?: CSSProperties; variant?: "default" | "canvas" | "top-nav"; compact?: boolean; showCredits?: boolean }) {
    const creationUi = useCreationUi();
    const [open, setOpen] = useState(false);
    const [wallet, setWallet] = useState<PlatformWallet | null>(null);
    const [walletState, setWalletState] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
    const walletReader = useRef<ReturnType<typeof createPlatformWalletReader> | null>(null);
    const [quota, setQuota] = useState<CloudMediaQuota | null>(null);
    const [quotaState, setQuotaState] = useState<"idle" | "loading" | "ready" | "unavailable">("idle");
    const navigate = useNavigate();
    const location = useLocation();
    const { message } = App.useApp();
    const { user, status, busy, site, initialize, refresh, submit } = useAccountStore();
    const walletScope = useAccountStore.getState().getDraftScope();

    useEffect(() => { void initialize(); }, [initialize]);
    useEffect(() => { setOpen(false); }, [location.pathname, location.search, location.hash, creationUi]);
    useEffect(() => {
        if (!walletScope) {
            setWallet(null);
            setWalletState("idle");
            return;
        }
        const reader = createPlatformWalletReader({
            scope: walletScope,
            getScope: () => useAccountStore.getState().getDraftScope(),
            read: fetchPlatformWallet,
            onState: (next) => { setWallet(next.wallet); setWalletState(next.status); },
        });
        walletReader.current = reader;
        void reader.refresh();
        return () => { reader.close(); if (walletReader.current === reader) walletReader.current = null; };
    }, [walletScope?.accountId, walletScope?.epoch]);

    useEffect(() => {
        if (!open || !user || !site?.cloudMedia) {
            setQuota(null);
            setQuotaState("idle");
            return;
        }
        let active = true;
        setQuotaState("loading");
        void cloudMediaClient.list().then(({ quota: nextQuota }) => {
            if (active) { setQuota(nextQuota); setQuotaState("ready"); }
        }).catch(() => {
            if (active) { setQuota(null); setQuotaState("unavailable"); }
        });
        return () => { active = false; };
    }, [open, site?.cloudMedia, user?.id]);

    const returnPath = `${location.pathname}${location.search}${location.hash}`;
    const roleLabel = user?.role === "admin" ? "超级管理员" : "普通用户";
    const accountLabel = user?.email ?? user?.name;
    const topNav = variant === "top-nav";
    const canvas = variant === "canvas";
    const creditsLabel = !walletScope ? "积分未开放" : walletState === "loading" ? "积分加载中…" : walletState === "ready" ? `${wallet?.availableUnits ?? "—"} 积分` : "积分暂不可用";
    const label = user
        ? `${roleLabel}：${accountLabel}${walletState === "ready" ? `，余额 ${wallet?.availableUnits ?? "—"} credit` : ""}`
        : status === "unavailable" ? "账户（服务未接通）" : "登录 / 注册";

    const accountButton = (
        <button
            type="button"
            className={`${className} ${creationUi && compact ? "!h-9 !w-9 !rounded-full !bg-primary !text-primary-foreground" : `!h-8 ${compact ? "!w-8 !rounded-full !border !border-border" : "!w-auto !min-w-7 !gap-1.5 !px-1.5"}`}`}
            style={style}
            aria-label={compact && user ? `用户菜单：${user.name}` : `${label}，${user ? "打开账户菜单" : "打开登录窗口"}`}
            title={`${label}，${user ? "打开账户菜单" : "打开登录窗口"}`}
            onClick={() => {
                if (!user) {
                    if (creationUi) { navigate("/login", { state: { from: returnPath } }); return; }
                    setOpen(true);
                    void refresh();
                }
            }}
        >
            {compact && user ? <span className="text-xs font-semibold">{user.name.trim().slice(0, 1).toUpperCase() || "U"}</span> : user?.role === "admin" ? <ShieldCheck className="size-4" /> : <UserRound className="size-4" />}
            <span className={compact ? "hidden" : topNav ? "app-top-nav-account-summary" : canvas ? "hidden min-w-0 max-w-28 flex-col items-start leading-tight sm:inline-flex lg:max-w-44" : "hidden max-w-28 truncate text-xs font-medium 2xl:inline"}>
                <span className="max-w-full truncate text-xs font-medium">{accountLabel ?? (status === "unavailable" ? "账户不可用" : "登录")}</span>
                {user ? (
                    <span className={`${topNav ? "app-top-nav-account-meta" : canvas ? "inline-flex" : "hidden"} max-w-full items-center gap-1.5 text-[11px] opacity-75`}>
                        <span className="truncate">{roleLabel}</span>
                        {topNav ? <span className="app-top-nav-account-balance shrink-0 tabular-nums">{walletState === "loading" ? "余额…" : walletState === "ready" ? `${wallet?.availableUnits ?? "—"} credit` : "余额暂不可用"}</span> : null}
                    </span>
                ) : null}
            </span>
            {user && !topNav && !canvas ? <span className="hidden text-[11px] opacity-75 2xl:inline">{roleLabel}</span> : null}
            {user && !topNav && !canvas ? <span className="hidden max-w-24 truncate text-[11px] tabular-nums opacity-75 2xl:inline">{walletState === "loading" ? "余额…" : walletState === "ready" ? `${wallet?.availableUnits ?? "—"} credit` : "余额暂不可用"}</span> : null}
        </button>
    );

    return (
        <>
            {showCredits && !topNav && walletScope && site?.cloudCanvas ? <button type="button"
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs tabular-nums transition hover:bg-black/5 dark:hover:bg-white/10"
                style={style} aria-label="积分与订阅" title="查看当前账户积分；订阅功能尚未开放"
                onClick={() => { setOpen(true); void walletReader.current?.refresh(); }}>
                <WalletCards className="size-4" /><span>{walletState === "loading" ? "积分…" : walletState === "ready" ? `${wallet?.availableUnits ?? "—"} 积分` : "积分暂不可用"}</span>
            </button> : null}
            {showCredits && topNav ? <button type="button"
                className={`${creationUi ? "hidden sm:inline-flex" : "inline-flex"} h-8 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-xs tabular-nums transition hover:bg-accent disabled:cursor-default disabled:opacity-60 sm:px-2`}
                style={style} aria-label={`积分余额：${creditsLabel}`} title={creditsLabel} disabled={!walletScope}
                onClick={() => { setOpen(true); void walletReader.current?.refresh(); }}>
                <WalletCards className="size-4" /><span className="hidden max-w-28 truncate lg:inline">{creditsLabel}</span>
            </button> : null}
            {showCredits && topNav ? <Popover trigger="click" placement="bottomRight" content={<p className="max-w-56 text-xs text-muted-foreground">订阅功能尚未开放，开放后可在此查看方案。</p>}>
                <button type="button" className={`${creationUi ? "hidden sm:inline-flex" : "inline-flex"} h-8 shrink-0 items-center gap-1.5 rounded-lg px-1.5 text-xs text-primary hover:bg-accent sm:px-2`} aria-label="开通订阅（未开放）" title="开通订阅（未开放）">
                    <Crown className="size-4" /><span className="hidden lg:inline">开通订阅<span className="ml-1 text-muted-foreground">未开放</span></span>
                </button>
            </Popover> : null}
            {user ? <Popover
                open={open}
                onOpenChange={(nextOpen) => { setOpen(nextOpen); if (nextOpen) void walletReader.current?.refresh(); }}
                trigger="click"
                placement="bottomRight"
                className={creationUi ? "border-0 bg-transparent p-0 shadow-none" : undefined}
                arrow={false}
                destroyOnHidden
                content={<AccountMenu
                    user={user}
                    wallet={wallet}
                    walletState={walletState}
                    quota={quota}
                    quotaState={quotaState}
                    cloudMediaEnabled={site?.cloudMedia === true}
                    showSubscriptionNotice={showCredits}
                    onNavigate={(path) => {
                        setOpen(false);
                        navigate(path, { state: path === "/account" ? { from: returnPath } : undefined });
                    }}
                    onSignOut={() => {
                        setOpen(false);
                        void submit({ action: "sign-out" }).catch(() => message.error("退出登录未完成，请重试。"));
                    }}
                />}
            >{accountButton}</Popover> : accountButton}
            {!user && !creationUi ? <Modal
                title="平台账户"
                open={open}
                onCancel={() => setOpen(false)}
                footer={null}
                destroyOnHidden
                width={480}
                style={{ top: 24 }}
                mask={{ closable: !busy }}
                modalRender={(node) => <div data-canvas-shortcuts-ignore>{node}</div>}
            >
                <AccountPanel onAuthenticated={() => setOpen(false)} />
            </Modal> : null}
        </>
    );
}
