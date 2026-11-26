import { create } from "zustand";
import type { SessionPrincipal } from "../../../packages/shared/src/index";
import { AccountError, accountClient, type AccountCommand, type AccountSite } from "../services/saas/account";
import type { DraftAccountScope } from "../services/saas/drafts";
import { setAccountLocalAccount } from "../services/saas/account-local-scope";
import { createAccountSessionSync, type AccountSessionSync } from "../services/saas/account-session-sync";
import { clearLocalApiCredentials } from "./use-config-store";

type AccountState = {
    status: "idle" | "loading" | "ready" | "unavailable";
    site: AccountSite | null;
    user: SessionPrincipal | null;
    error: string | null;
    busy: boolean;
    getDraftScope: () => DraftAccountScope | null;
    initialize: () => Promise<void>;
    refresh: () => Promise<void>;
    submit: (command: AccountCommand) => Promise<void>;
};

/** Tab-memory only. Do not put passwords, CAPTCHA values, cookies or canvas data in this store. */
export function createAccountStore(client = accountClient, sessionSync: AccountSessionSync = createAccountSessionSync()) {
    let epoch = 0;
    let requestVersion = 0;
    let pending: Promise<void> | null = null;
    let pendingBackground = false;
    let refreshQueued: "background" | "foreground" | null = null;
    return create<AccountState>((set, get) => {
        function publishInvalidation() {
            try { sessionSync.publishInvalidated(); } catch { /* Session sync is advisory; account state remains authoritative. */ }
        }
        function load(background = false, supersede = false): Promise<void> {
            const previous = get();
            const rechecking = background && previous.status === "ready" && Boolean(previous.user);
            // External invalidation also supersedes initialization/explicit checks:
            // their response may have been authenticated before another tab signed out.
            if (pending && !supersede && (!pendingBackground || rechecking)) return pending;
            const version = ++requestVersion;
            const hadAuthenticatedSession = Boolean(previous.user);
            // Initial/explicit checks clear ownership immediately. A visibility
            // check keeps the last confirmed identity until its result, avoiding
            // an editor unmount when the same account is still authenticated.
            if (!rechecking) {
                ++epoch;
                setAccountLocalAccount(null);
                set({ status: "loading", user: null, error: null });
            }
            pendingBackground = rechecking;
            const operation = (async () => {
                try {
                    const site = await client.site();
                    const user = site.captcha ? await client.session() : null;
                    if (version === requestVersion) {
                        const sessionLost = hadAuthenticatedSession && !user;
                        if (rechecking && (user?.id !== previous.user?.id || user?.role !== previous.user?.role ||
                            site.cloudCanvas !== previous.site?.cloudCanvas || site.cloudMedia !== previous.site?.cloudMedia)) {
                            ++epoch;
                            // Invalidate cloud work without revoking local media belonging
                            // to the same account. The confirmed owner is set below.
                        }
                        // A confirmed platform session owns model selection and
                        // provider access. Remove any credentials left in the
                        // anonymous browser profile before exposing the account.
                        if (user || hadAuthenticatedSession) clearLocalApiCredentials();
                        setAccountLocalAccount(user?.id ?? null);
                        set({ status: "ready", site, user, error: null });
                        if (sessionLost) publishInvalidation();
                    }
                } catch (error) {
                    if (version === requestVersion) {
                        if (rechecking) ++epoch;
                        // A refresh can lose the platform session before the
                        // server returns a usable replacement. Do not leave a
                        // stale local provider key attached to that account.
                        if (hadAuthenticatedSession) clearLocalApiCredentials();
                        setAccountLocalAccount(null);
                        set({ status: "unavailable", site: null, user: null, error: error instanceof AccountError ? error.message : "账户服务暂时不可用，请重新检查。" });
                    }
                } finally { if (version === requestVersion) { pending = null; pendingBackground = false; } }
            })();
            pending = operation;
            return operation;
        }
        const refreshIfAuthenticated = (background = false) => {
            const state = get();
            if (state.busy) {
                // Sign-in can be loading its session while busy. Keep external
                // invalidations queued even though that check has cleared user.
                if (background && (state.status !== "ready" || !state.user)) return;
                if (!background || refreshQueued === null) refreshQueued = background ? "background" : "foreground";
                return;
            }
            if ((state.status !== "ready" || !state.user) && (background || !pending)) return;
            void load(background, !background);
        };
        sessionSync.subscribeInvalidated(() => refreshIfAuthenticated());
        sessionSync.subscribeVisible(() => refreshIfAuthenticated(true));
        return {
            status: "idle", site: null, user: null, error: null, busy: false,
            getDraftScope: () => {
                const state = get();
                return state.status === "ready" && !state.busy && state.user
                    ? { accountId: state.user.id, epoch } : null;
            },
            initialize: () => get().status === "idle" ? load() : pending ?? Promise.resolve(),
            refresh: () => get().busy ? Promise.resolve() : load(),
            async submit(command) {
                const state = get();
                if (state.busy) throw new AccountError("busy", "账户操作正在进行，请勿重复提交。");
                if (state.status !== "ready" || !state.site?.captcha) throw new AccountError("unavailable", "账户服务未接通，当前不能提交。");
                if (command.action === "sign-up/email" && !state.site.registration) throw new AccountError("closed", "当前尚未开放注册。");
                ++epoch;
                ++requestVersion;
                pending = null;
                pendingBackground = false;
                set({ busy: true });
                try {
                    await client.submit(command);
                    if (command.action === "sign-in/email") {
                        await load();
                        if (!get().user) throw new AccountError("session_unconfirmed", "登录提交已返回，但当前会话尚未确认。请重新检查账户连接。");
                    } else if (command.action === "sign-out" || command.action === "revoke-sessions" || command.action === "reset-password") {
                        // Keep the boundary safe even if an older build left a
                        // credential in storage before the account was closed.
                        clearLocalApiCredentials();
                        setAccountLocalAccount(null);
                        set({ user: null });
                        publishInvalidation();
                    }
                } finally {
                    if (refreshQueued) {
                        const background = refreshQueued === "background";
                        refreshQueued = null;
                        // A queued invalidation must clear the old identity before
                        // releasing busy, including for synchronous scope readers.
                        const current = get();
                        if (current.status === "ready" && current.user) void load(background, !background);
                    }
                    set({ busy: false });
                }
            },
        };
    });
}

export const useAccountStore = createAccountStore();
