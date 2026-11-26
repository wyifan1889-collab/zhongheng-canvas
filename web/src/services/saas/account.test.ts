import { describe, expect, test } from "bun:test";
import { AccountError, createAccountClient, type AccountCommand, type AccountSite } from "./account";
import { createAccountStore } from "../../stores/use-account-store";
import { useConfigStore } from "../../stores/use-config-store";
import { isAccountReturnPath, parseAccountReturn } from "./account-return";
import { createDraftClient } from "./drafts";
import type { AccountSessionSync } from "./account-session-sync";
import { getAccountLocalScope, subscribeAccountLocalScope } from "./account-local-scope";
import { createCanvasVersionSession } from "./canvas-version-save";
import type { SessionPrincipal } from "../../../../packages/shared/src/index";

const json = (data: unknown, status = 200, headers = {}) => Response.json(data, { status, headers });
const user = { id: "synthetic-user", name: "测试账户", email: "person@example.test", role: "user" as const };
const site: AccountSite = { registration: true, cloudCanvas: false, cloudMedia: false, captcha: { siteKey: "public-test-key", action: "account" } };
const login: AccountCommand = { action: "sign-in/email", email: "person@example.test", password: "synthetic-password", captcha: "synthetic-captcha" };
function clientFixture(overrides: Partial<ReturnType<typeof createAccountClient>> = {}) {
    return { site: async () => site, session: async () => user, submit: async (_command: AccountCommand) => {}, ...overrides };
}
function sessionSyncFixture() {
    const invalidated = new Set<() => void>();
    const visible = new Set<() => void>();
    let published = 0;
    const sync: AccountSessionSync = {
        publishInvalidated: () => { published++; },
        subscribeInvalidated: (listener) => { invalidated.add(listener); return () => invalidated.delete(listener); },
        subscribeVisible: (listener) => { visible.add(listener); return () => visible.delete(listener); },
        close: () => {},
    };
    return {
        sync,
        get published() { return published; },
        invalidate: () => { for (const listener of invalidated) listener(); },
        reveal: () => { for (const listener of visible) listener(); },
    };
}
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("account HTTP adapter: synthetic fetch only, not live authentication", () => {
    test("uses exact same-origin paths, cookies, no redirects/cache and allowlisted payloads", async () => {
        const calls: { path: unknown; options: RequestInit }[] = [];
        const client = createAccountClient((async (path, options) => {
            calls.push({ path, options: options! });
            return json({ ok: true, token: "must-not-reach-client-state" });
        }) as typeof fetch);
        const commands: AccountCommand[] = [
            { ...login, role: "admin", callbackURL: "https://outside.example" } as AccountCommand,
            { action: "sign-up/email", name: " Name ", email: " person@example.test ", password: " password with spaces ", captcha: "challenge" },
            { action: "send-verification-email", email: " person@example.test ", captcha: "challenge" },
            { action: "request-password-reset", email: "person@example.test", captcha: "challenge" },
            { action: "reset-password", token: "synthetic-reset", newPassword: "synthetic-new" },
            { action: "sign-out" },
            { action: "revoke-sessions" },
        ];
        for (const command of commands) expect(await client.submit(command)).toBeUndefined();
        expect(calls.map((call) => call.path)).toEqual(commands.map((command) => `/api/auth/${command.action}`));
        for (const { options } of calls) {
            expect(options.credentials).toBe("same-origin");
            expect(options.redirect).toBe("error");
            expect(options.cache).toBe("no-store");
            expect(options.referrerPolicy).toBe("no-referrer");
            expect(options.method).toBe("POST");
            expect(String(options.body)).not.toContain("role");
            expect(String(options.body)).not.toContain("callbackURL");
            expect(new Headers(options.headers).has("authorization")).toBe(false);
        }
        expect(JSON.parse(String(calls[1].options.body))).toEqual({ name: "Name", email: "person@example.test", password: " password with spaces " });
        expect(new Headers(calls[0].options.headers).get("x-captcha-response")).toBe("synthetic-captcha");
        expect(new Headers(calls[4].options.headers).has("x-captcha-response")).toBe(false);
        expect(calls[5].options.body).toBe("{}");
        expect(calls[6].options.body).toBe("{}");
    });
    test("missing CAPTCHA fails before I/O", async () => {
        let calls = 0;
        const client = createAccountClient((async () => { calls++; return json({ ok: true }); }) as typeof fetch);
        await expect(client.submit({ ...login, captcha: "" })).rejects.toMatchObject({ code: "captcha_failed" });
        expect(calls).toBe(0);
    });
    test("validates site contract and only retains public account fields", async () => {
        let response: unknown = { schemaVersion: 1, features: { registration: false } };
        const client = createAccountClient((async () => json(response)) as typeof fetch);
        expect(await client.site()).toEqual({ registration: false, cloudCanvas: false, cloudMedia: false, captcha: null });
        response = { schemaVersion: 1, features: { registration: true }, authentication: { method: "email-password", captcha: { provider: "turnstile", action: "account", siteKey: "public-key" } }, secret: "discard" };
        expect(await client.site()).toEqual({ registration: true, cloudCanvas: false, cloudMedia: false, captcha: { siteKey: "public-key", action: "account" } });
        for (const invalid of [null, { schemaVersion: 2, features: { registration: false } }, { schemaVersion: 1, features: { registration: true } }, { schemaVersion: 1, features: { registration: false }, authentication: { method: "other" } }]) {
            response = invalid;
            await expect(client.site()).rejects.toMatchObject({ code: "unavailable" });
        }
    });
    test("only trusts a validated session; projects away tokens and rejects unexpected 401", async () => {
        let response = json({ user: { ...user, token: "discard" }, session: { token: "discard" } });
        const client = createAccountClient((async () => response) as typeof fetch);
        expect(await client.session()).toEqual(user);
        response = json({ error: { code: "unauthorized" } }, 401);
        expect(await client.session()).toBeNull();
        response = json({ error: { code: "proxy_failure" } }, 401);
        await expect(client.session()).rejects.toMatchObject({ code: "unavailable" });
        for (const invalid of [{ ok: true }, { user: { ...user, role: "root" } }, { user: { ...user, id: null } }]) {
            response = json(invalid);
            await expect(client.session()).rejects.toMatchObject({ code: "unavailable" });
        }
    });
    test("cloud canvas requires explicit boolean readiness and a valid authentication contract", async () => {
        const authentication = { method: "email-password", captcha: { provider: "turnstile", action: "account", siteKey: "public-key" } };
        let response: unknown;
        const client = createAccountClient((async () => json(response)) as typeof fetch);
        for (const cloudCanvas of [undefined, false, true]) {
            response = { schemaVersion: 1, features: { registration: false, cloudCanvas }, authentication };
            expect((await client.site()).cloudCanvas).toBe(cloudCanvas === true);
        }
        for (const cloudCanvas of ["true", 1, null, {}, []]) {
            response = { schemaVersion: 1, features: { registration: false, cloudCanvas }, authentication };
            await expect(client.site()).rejects.toMatchObject({ code: "unavailable" });
        }
        response = { schemaVersion: 1, features: { registration: false, cloudCanvas: true } };
        expect((await client.site()).cloudCanvas).toBe(false);
    });
    test("HTML fallback, malformed JSON, network failures and false success never authenticate", async () => {
        for (const makeResponse of [
            () => new Response("<html>Vite fallback</html>", { headers: { "content-type": "text/html" } }),
            () => new Response("invalid", { headers: { "content-type": "application/json" } }),
            () => json({ ok: false }),
            () => { throw new Error("secret-network-value"); },
        ]) {
            let calls = 0;
            const client = createAccountClient((async () => { calls++; return makeResponse(); }) as typeof fetch);
            await expect(client.submit(login)).rejects.toMatchObject({ code: "unavailable" });
            expect(calls).toBe(1); // no retry on an ambiguous submitted operation
        }
    });
    test("safe errors cover rate limits and unconfirmed mail without displaying raw messages", async () => {
        for (const [status, code] of [[503, "mail_unavailable"], [403, "captcha_failed"], [403, "invalid_origin"], [400, "auth_rejected"], [503, "secret-code"], [503, "constructor"], [503, "__proto__"]] as const) {
            const client = createAccountClient((async () => json({ error: { code, message: "secret-body" } }, status)) as typeof fetch);
            try { await client.submit(login); throw new Error("expected rejection"); }
            catch (error) {
                expect(error).toBeInstanceOf(AccountError);
                expect(String(error)).not.toContain("secret");
                expect((error as AccountError).status).toBe(status);
                if (["secret-code", "constructor", "__proto__"].includes(code)) expect((error as AccountError).message).toBe("账户服务未接通或暂时不可用，请检查连接后重试。");
            }
        }
        const resetMailFailure = createAccountClient((async () => json({ error: { code: "mail_unavailable" } }, 503)) as typeof fetch);
        await expect(resetMailFailure.submit({ action: "request-password-reset", email: "person@example.test", captcha: "challenge" })).rejects.toMatchObject({
            message: "重置邮件发送尚未确认，请稍后重新申请或检查邮箱服务配置。",
        });
        const verificationMailFailure = createAccountClient((async () => json({ error: { code: "mail_unavailable" } }, 503)) as typeof fetch);
        await expect(verificationMailFailure.submit({ action: "send-email-otp", email: "person@example.test", captcha: "challenge" })).rejects.toMatchObject({
            message: "验证邮件发送尚未确认；账户可能已建立但仍未验证，请查收邮件或重新发送验证码。",
        });
        const rate = createAccountClient((async () => json({ error: { code: "rate_limited" } }, 429, { "retry-after": "23" })) as typeof fetch);
        await expect(rate.submit(login)).rejects.toMatchObject({ code: "rate_limited", retryAfter: 23 });
        const badRate = createAccountClient((async () => json({}, 429, { "retry-after": "secret" })) as typeof fetch);
        await expect(badRate.submit(login)).rejects.toMatchObject({ retryAfter: undefined });
        const invalidReset = createAccountClient((async () => json({ error: { code: "invalid_token" } }, 400)) as typeof fetch);
        await expect(invalidReset.submit({ action: "reset-password", token: "expired", newPassword: "synthetic-new" })).rejects.toMatchObject({
            code: "invalid_token", message: "重置链接无效或已过期，请重新申请密码重置邮件。",
        });
    });
});

describe("account memory store: does not read or write original canvas stores", () => {
    test("visibility rechecks the same account without a loading gate, epoch change or loss of the save baseline", async () => {
        const channel = sessionSyncFixture();
        let calls = 0, finish!: (value: SessionPrincipal) => void;
        const store = createAccountStore(clientFixture({ site: async () => ({ ...site, cloudCanvas: true }),
            session: async () => ++calls === 1 ? user : new Promise<SessionPrincipal>((resolve) => { finish = resolve; }) }), channel.sync);
        await store.getState().initialize();
        const before = store.getState().getDraftScope(), localBefore = getAccountLocalScope();
        const statuses: string[] = [];
        store.subscribe((state) => statuses.push(state.status));
        const version = createCanvasVersionSession(() => {
            const scope = store.getState().getDraftScope();
            return scope ? { ...scope, localProjectId: "test-project", cloudCanvas: true } : null;
        });
        version.seedCreation({ id: "a1b2c3d4-e5f6-47a8-b9c0-123456abcdef", revision: 1, updatedAt: "2026-01-01T00:00:00Z" });
        channel.reveal(); channel.reveal();
        expect(store.getState().status).toBe("ready");
        expect(store.getState().getDraftScope()).toEqual(before);
        expect(getAccountLocalScope()).toEqual(localBefore);
        await tick();
        expect(calls).toBe(2);
        expect(version.getState().status).toBe("ready");
        finish({ ...user }); await tick();
        expect(store.getState().getDraftScope()).toEqual(before);
        expect(getAccountLocalScope()).toEqual(localBefore);
        expect(version.open().getState()).toMatchObject({ phase: "idle", expectedRevision: 1 });
        expect(statuses.every((status) => status === "ready")).toBe(true);
    });

    test("visibility account, role, gate changes and failures invalidate old draft clients", async () => {
        for (const change of ["account", "role", "gate", "logout", "failure"] as const) {
            const channel = sessionSyncFixture(); let recheck = false;
            const store = createAccountStore(clientFixture({
                site: async () => ({ ...site, cloudCanvas: !(recheck && change === "gate") }),
                session: async (): Promise<SessionPrincipal | null> => {
                    if (!recheck) return user;
                    if (change === "failure") throw new Error("private-detail");
                    if (change === "logout") return null;
                    return change === "account" ? { ...user, id: "other-account" } : change === "role" ? { ...user, role: "admin" } : user;
                },
            }), channel.sync);
            await store.getState().initialize();
            const before = store.getState().getDraftScope()!;
            let sends = 0;
            const old = createDraftClient(store.getState().getDraftScope, (async () => { sends++; return json({ items: [], nextCursor: null }); }) as unknown as typeof fetch);
            recheck = true; channel.reveal(); await tick();
            await expect(old.list()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
            expect(sends).toBe(0);
            if (["failure", "logout"].includes(change)) {
                expect(store.getState().user).toBeNull(); expect(getAccountLocalScope()).toBeNull();
            } else expect(store.getState().getDraftScope()!.epoch).toBeGreaterThan(before.epoch);
            if (change === "failure") expect(store.getState().error).not.toContain("private-detail");
        }
    });

    for (const change of ["role", "cloudCanvas", "cloudMedia"] as const) {
        test(`same-account ${change} recheck invalidates cloud work without resetting local media ownership`, async () => {
            const channel = sessionSyncFixture();
            let recheck = false;
            const store = createAccountStore(clientFixture({
                site: async () => ({ ...site, cloudCanvas: !(recheck && change === "cloudCanvas"), cloudMedia: !(recheck && change === "cloudMedia") }),
                session: async () => recheck && change === "role" ? { ...user, role: "admin" } : user,
            }), channel.sync);
            await store.getState().initialize();
            const cloudBefore = store.getState().getDraftScope()!, localBefore = getAccountLocalScope();
            let ownershipChanges = 0;
            const unsubscribe = subscribeAccountLocalScope(() => { ownershipChanges++; });
            ownershipChanges = 0;
            let sends = 0;
            const old = createDraftClient(store.getState().getDraftScope, (async () => {
                sends++; return json({ items: [], nextCursor: null });
            }) as unknown as typeof fetch);
            try {
                recheck = true;
                channel.reveal();
                await store.getState().initialize();
                expect(store.getState().status).toBe("ready");
                expect(store.getState().getDraftScope()!.epoch).toBeGreaterThan(cloudBefore.epoch);
                await expect(old.list()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
                expect(sends).toBe(0);
                expect(getAccountLocalScope()).toEqual(localBefore);
                expect(ownershipChanges).toBe(0);
            } finally { unsubscribe(); }
        });
    }

    test("external invalidation supersedes an in-flight visibility check and rejects its late success", async () => {
        const channel = sessionSyncFixture(); let calls = 0, finish!: (value: SessionPrincipal) => void;
        const store = createAccountStore(clientFixture({ session: async () => {
            calls++;
            if (calls === 1) return user;
            if (calls === 2) return new Promise<SessionPrincipal>((resolve) => { finish = resolve; });
            return null;
        } }), channel.sync);
        await store.getState().initialize();
        channel.reveal(); await tick();
        channel.invalidate();
        expect(store.getState().status).toBe("loading");
        expect(store.getState().getDraftScope()).toBeNull();
        expect(getAccountLocalScope()).toBeNull();
        await tick(); expect(calls).toBe(3); expect(store.getState().user).toBeNull();
        finish(user); await tick();
        expect(store.getState().user).toBeNull(); expect(store.getState().getDraftScope()).toBeNull();
    });

    for (const phase of ["initialize", "refresh"] as const) test(`external invalidation supersedes a pending ${phase} session instead of accepting its stale identity`, async () => {
        const channel = sessionSyncFixture();
        let calls = 0, finish!: (value: SessionPrincipal) => void;
        const stale = new Promise<SessionPrincipal>((resolve) => { finish = resolve; });
        const staleCall = phase === "initialize" ? 1 : 2;
        const store = createAccountStore(clientFixture({ session: async () => {
            calls++;
            if (calls < staleCall) return user;
            return calls === staleCall ? stale : null;
        } }), channel.sync);
        if (phase === "refresh") await store.getState().initialize();
        const operation = phase === "initialize" ? store.getState().initialize() : store.getState().refresh();
        const identities: (string | null)[] = [];
        const unsubscribe = store.subscribe((state) => { identities.push(state.user?.id ?? null); });
        try {
            await tick();
            expect(calls).toBe(staleCall);
            expect(store.getState().status).toBe("loading");
            channel.invalidate();
            await tick();
            // The old response was authenticated before another tab signed out.
            finish(user);
            await operation;
            await store.getState().initialize();
            expect(store.getState().user).toBeNull();
            expect(store.getState().getDraftScope()).toBeNull();
            expect(getAccountLocalScope()).toBeNull();
            expect(identities.every((identity) => identity === null)).toBe(true);
            expect(calls).toBe(staleCall + 1);
            expect(store.getState().status).toBe("ready");
        } finally {
            finish(user);
            await operation;
            unsubscribe();
        }
    });

    test("external invalidation during sign-in session loading is replayed after the busy command", async () => {
        const channel = sessionSyncFixture();
        let calls = 0, finish!: (value: SessionPrincipal) => void;
        const stale = new Promise<SessionPrincipal>((resolve) => { finish = resolve; });
        const store = createAccountStore(clientFixture({ session: async () => ++calls === 2 ? stale : null }), channel.sync);
        await store.getState().initialize();
        const command = store.getState().submit(login);
        const settled = command.then(() => null, (error: unknown) => error);
        const writableIdentities: string[] = [];
        const unsubscribe = store.subscribe((state) => {
            const scope = state.getDraftScope();
            if (scope) writableIdentities.push(scope.accountId);
        });
        try {
            await tick();
            expect(store.getState().status).toBe("loading");
            expect(store.getState().busy).toBe(true);
            expect(calls).toBe(2);
            channel.invalidate();
            channel.reveal();
            expect(calls).toBe(2);
            finish(user);
            expect(await settled).toBeNull();
            await store.getState().initialize();
            expect(calls).toBe(3);
            expect(store.getState().busy).toBe(false);
            expect(store.getState().status).toBe("ready");
            expect(store.getState().user).toBeNull();
            expect(store.getState().getDraftScope()).toBeNull();
            expect(getAccountLocalScope()).toBeNull();
            expect(writableIdentities).toEqual([]);
        } finally { finish(user); await settled; unsubscribe(); }
    });

    test("manual refresh still invalidates immediately while a visibility response is pending", async () => {
        const channel = sessionSyncFixture(); let calls = 0, finish!: (value: SessionPrincipal) => void;
        const store = createAccountStore(clientFixture({ session: async () => {
            calls++;
            return calls === 2 ? new Promise<SessionPrincipal>((resolve) => { finish = resolve; }) : user;
        } }), channel.sync);
        await store.getState().initialize();
        const before = store.getState().getDraftScope()!;
        channel.reveal(); await tick();
        const refresh = store.getState().refresh();
        expect(store.getState().getDraftScope()).toBeNull();
        await refresh;
        const after = store.getState().getDraftScope()!;
        expect(after.epoch).toBeGreaterThan(before.epoch);
        finish({ ...user, id: "late-wrong-account" }); await tick();
        expect(store.getState().getDraftScope()).toEqual(after);
        expect(store.getState().user?.id).toBe(user.id);
    });

    test("a visibility response cannot restore identity after a sign-out command", async () => {
        const channel = sessionSyncFixture(); let calls = 0, finish!: (value: SessionPrincipal) => void;
        const store = createAccountStore(clientFixture({ session: async () => ++calls === 1 ? user : new Promise<SessionPrincipal>((resolve) => { finish = resolve; }) }), channel.sync);
        await store.getState().initialize();
        channel.reveal(); await tick();
        await store.getState().submit({ action: "sign-out" });
        finish(user); await tick();
        expect(store.getState().user).toBeNull();
        expect(store.getState().getDraftScope()).toBeNull();
        expect(getAccountLocalScope()).toBeNull();
        expect(channel.published).toBe(1);
    });

    test("external invalidation clears the account boundary and visibility rechecks the session", async () => {
        let authenticated = true;
        let sessions = 0;
        const channel = sessionSyncFixture();
        const store = createAccountStore(clientFixture({ session: async () => { sessions++; return authenticated ? user : null; } }), channel.sync);
        await store.getState().initialize();
        expect(store.getState().user).toEqual(user);
        channel.reveal();
        await tick();
        expect(store.getState().user).toEqual(user);
        expect(sessions).toBe(2);
        authenticated = false;
        channel.invalidate();
        await tick();
        expect(store.getState().status).toBe("ready");
        expect(store.getState().user).toBeNull();
        expect(store.getState().getDraftScope()).toBeNull();
        expect(sessions).toBe(3);
        expect(channel.published).toBe(1);
    });

    test("successful session-closing commands publish an invalidation signal", async () => {
        const channel = sessionSyncFixture();
        const store = createAccountStore(clientFixture(), channel.sync);
        await store.getState().initialize();
        await store.getState().submit({ action: "sign-out" });
        expect(channel.published).toBe(1);
    });

    for (const order of ["visible-first", "invalidation-first"] as const) test(`busy account command failure replays the stronger queued invalidation (${order})`, async () => {
        const channel = sessionSyncFixture();
        let rejectSubmit!: (reason: unknown) => void, finishSession!: (value: SessionPrincipal | null) => void;
        const submission = new Promise<void>((_resolve, reject) => { rejectSubmit = reject; });
        const session = new Promise<SessionPrincipal | null>((resolve) => { finishSession = resolve; });
        let sites = 0, sessions = 0, sends = 0;
        const store = createAccountStore(clientFixture({
            site: async () => { sites++; return site; },
            session: async () => ++sessions === 1 ? user : session,
            submit: () => submission,
        }), channel.sync);
        await store.getState().initialize();
        const old = createDraftClient(store.getState().getDraftScope, (async () => {
            sends++; return json({ items: [], nextCursor: null });
        }) as unknown as typeof fetch);
        const command = store.getState().submit({ action: "sign-out" });
        const rejected = command.then(() => null, (error: unknown) => error);
        try {
            if (order === "visible-first") { channel.reveal(); channel.invalidate(); }
            else { channel.invalidate(); channel.reveal(); }
            expect(store.getState().busy).toBe(true);
            expect(store.getState().status).toBe("ready");
            expect(store.getState().user?.id).toBe(user.id);
            expect(store.getState().getDraftScope()).toBeNull();
            expect([sites, sessions]).toEqual([1, 1]);
            rejectSubmit(new AccountError("unavailable", "synthetic submit failure"));
            expect(await rejected).toMatchObject({ code: "unavailable" });
            // Queued external invalidation must run as foreground even if visibility
            // also arrived: clear ownership before the replacement session resolves.
            expect(store.getState().busy).toBe(false);
            expect(store.getState().status).toBe("loading");
            expect(store.getState().user).toBeNull();
            expect(getAccountLocalScope()).toBeNull();
            await tick();
            expect([sites, sessions]).toEqual([2, 2]);
            finishSession(null);
            await store.getState().initialize();
            expect(store.getState().status).toBe("ready");
            expect(store.getState().user).toBeNull();
            expect(store.getState().getDraftScope()).toBeNull();
            await expect(old.list()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
            expect(sends).toBe(0);
            expect(channel.published).toBe(1);
        } finally {
            rejectSubmit(new AccountError("unavailable", "synthetic cleanup"));
            finishSession(null);
            await command.catch(() => {});
            await store.getState().initialize();
        }
    });

    test("confirmed platform sessions clear local provider keys while anonymous mode preserves them", async () => {
        const previous = useConfigStore.getState().config;
        useConfigStore.setState({
            config: {
                ...previous,
                apiKey: "legacy-global-key",
                channels: previous.channels.map((channel) => ({ ...channel, apiKey: "legacy-channel-key" })),
            },
        });
        try {
            const account = createAccountStore(clientFixture());
            await account.getState().initialize();
            expect(useConfigStore.getState().config.apiKey).toBe("");
            expect(useConfigStore.getState().config.channels.every((channel) => channel.apiKey === "")).toBe(true);

            useConfigStore.setState({
                config: {
                    ...useConfigStore.getState().config,
                    apiKey: "anonymous-local-key",
                    channels: useConfigStore.getState().config.channels.map((channel) => ({ ...channel, apiKey: "anonymous-channel-key" })),
                },
            });
            const anonymous = createAccountStore(clientFixture({ site: async () => ({ registration: false, cloudCanvas: false, cloudMedia: false, captcha: null }) }));
            await anonymous.getState().initialize();
            expect(useConfigStore.getState().config.apiKey).toBe("anonymous-local-key");
            expect(useConfigStore.getState().config.channels[0]?.apiKey).toBe("anonymous-channel-key");
        } finally {
            useConfigStore.setState({ config: previous });
        }
    });

    test("initialization is deduplicated and no session request is made when accounts are disabled", async () => {
        let sites = 0, sessions = 0;
        const store = createAccountStore(clientFixture({ site: async () => { sites++; return { registration: false, cloudCanvas: false, cloudMedia: false, captcha: null }; }, session: async () => { sessions++; return user; } }));
        await Promise.all([store.getState().initialize(), store.getState().initialize()]);
        expect(sites).toBe(1);
        expect(sessions).toBe(0);
        expect(store.getState().user).toBeNull();
        expect(store.getState().status).toBe("ready");
        await expect(store.getState().submit(login)).rejects.toMatchObject({ code: "unavailable" });
    });
    test("failed recheck removes stale identity and readiness", async () => {
        let fail = false;
        const store = createAccountStore(clientFixture({ session: async () => { if (fail) throw new Error("private"); return user; } }));
        await store.getState().initialize();
        expect(store.getState().user).toEqual(user);
        fail = true;
        await store.getState().refresh();
        expect(store.getState().status).toBe("unavailable");
        expect(store.getState().user).toBeNull();
        expect(store.getState().site).toBeNull();
        expect(store.getState().error).not.toContain("private");
    });
    test("failed refresh from a confirmed account clears stale local provider keys", async () => {
        let fail = false;
        const previous = useConfigStore.getState().config;
        useConfigStore.setState({
            config: {
                ...previous,
                apiKey: "stale-global-key",
                channels: previous.channels.map((channel) => ({ ...channel, apiKey: "stale-channel-key" })),
            },
        });
        try {
            const store = createAccountStore(clientFixture({ session: async () => { if (fail) throw new Error("private"); return user; } }));
            await store.getState().initialize();
            // Simulate a credential left by an older build after login.
            useConfigStore.setState({
                config: {
                    ...useConfigStore.getState().config,
                    apiKey: "stale-global-key",
                    channels: useConfigStore.getState().config.channels.map((channel) => ({ ...channel, apiKey: "stale-channel-key" })),
                },
            });
            fail = true;
            await store.getState().refresh();
            expect(useConfigStore.getState().config.apiKey).toBe("");
            expect(useConfigStore.getState().config.channels.every((channel) => channel.apiKey === "")).toBe(true);
        } finally {
            useConfigStore.setState({ config: previous });
        }
    });
    test("successful recheck clears the previous unavailable notice", async () => {
        let fail = true;
        const store = createAccountStore(clientFixture({ session: async () => { if (fail) throw new AccountError("unavailable", "暂时不可用"); return user; } }));
        await store.getState().initialize();
        expect(store.getState().status).toBe("unavailable");
        fail = false;
        await store.getState().refresh();
        expect(store.getState().status).toBe("ready");
        expect(store.getState().error).toBeNull();
    });
    test("a successful login response alone is not a confirmed session", async () => {
        let authenticated = false;
        const store = createAccountStore(clientFixture({ session: async () => authenticated ? user : null }));
        await store.getState().initialize();
        await expect(store.getState().submit(login)).rejects.toMatchObject({ code: "session_unconfirmed" });
        expect(store.getState().busy).toBe(false);
        expect(store.getState().user).toBeNull();
        authenticated = true;
        await store.getState().submit(login);
        expect(store.getState().user).toEqual(user);
        expect(JSON.stringify(store.getState())).not.toContain("synthetic-password");
        expect(JSON.stringify(store.getState())).not.toContain("synthetic-captcha");
    });
    test("mail errors keep unverified account flow logged out and release submit lock", async () => {
        const store = createAccountStore(clientFixture({ session: async () => null, submit: async () => { throw new AccountError("mail_unavailable", "未确认"); } }));
        await store.getState().initialize();
        await expect(store.getState().submit({ action: "sign-up/email", name: "Test", email: "new@example.test", password: "synthetic", captcha: "synthetic" })).rejects.toMatchObject({ code: "mail_unavailable" });
        expect(store.getState().user).toBeNull();
        expect(store.getState().busy).toBe(false);
    });
    test("registration flag only disables signup, not existing account login", async () => {
        const store = createAccountStore(clientFixture({ site: async () => ({ ...site, registration: false }) }));
        await store.getState().initialize();
        await expect(store.getState().submit({ action: "sign-up/email", name: "Test", email: "new@example.test", password: "synthetic", captcha: "synthetic" })).rejects.toMatchObject({ code: "closed" });
        await store.getState().submit(login);
        expect(store.getState().user).toEqual(user);
    });
    test("concurrent submissions are not repeated; confirmed logout clears identity", async () => {
        let finish!: () => void;
        let calls = 0;
        const store = createAccountStore(clientFixture({ submit: async () => { calls++; await new Promise<void>((resolve) => { finish = resolve; }); } }));
        await store.getState().initialize();
        const operation = store.getState().submit({ action: "sign-out" });
        await expect(store.getState().submit({ action: "sign-out" })).rejects.toMatchObject({ code: "busy" });
        await store.getState().refresh();
        expect(calls).toBe(1);
        finish();
        await operation;
        expect(store.getState().user).toBeNull();
        expect(store.getState().busy).toBe(false);
    });
    test("logout failure is not a fake logout; successful reset clears displayed identity", async () => {
        let fail = true;
        const store = createAccountStore(clientFixture({ submit: async () => { if (fail) throw new AccountError("unavailable", "未确认"); } }));
        await store.getState().initialize();
        await expect(store.getState().submit({ action: "sign-out" })).rejects.toThrow();
        expect(store.getState().user).toEqual(user);
        fail = false;
        await store.getState().submit({ action: "reset-password", token: "synthetic", newPassword: "synthetic" });
        expect(store.getState().user).toBeNull();
    });

    test("draft scope exists only for a ready, confirmed account, not during refresh or commands", async () => {
        let finish!: () => void;
        const store = createAccountStore(clientFixture({ submit: () => new Promise<void>((resolve) => { finish = resolve; }) }));
        expect(store.getState().getDraftScope()).toBeNull();
        await store.getState().initialize();
        const first = store.getState().getDraftScope()!;
        expect(first.accountId).toBe(user.id);
        const refresh = store.getState().refresh();
        expect(store.getState().getDraftScope()).toBeNull();
        await refresh;
        expect(store.getState().getDraftScope()!.epoch).toBeGreaterThan(first.epoch);
        const logout = store.getState().submit({ action: "sign-out" });
        expect(store.getState().getDraftScope()).toBeNull();
        finish();
        await logout;
        expect(store.getState().getDraftScope()).toBeNull();
    });

    test("A → B → A and same-account refresh cannot revive an old draft client", async () => {
        let current = user;
        const store = createAccountStore(clientFixture({ session: async () => current }));
        await store.getState().initialize();
        let calls = 0;
        const old = createDraftClient(store.getState().getDraftScope, (async () => { calls++; return json({ items: [], nextCursor: null }); }) as typeof fetch);
        current = { ...user, id: "synthetic-user-B" };
        await store.getState().refresh();
        current = user;
        await store.getState().refresh();
        await expect(old.list()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
        const fresh = createDraftClient(store.getState().getDraftScope, (async () => json({ items: [], nextCursor: null })) as typeof fetch);
        expect(await fresh.list()).toEqual({ items: [], nextCursor: null });
        expect(calls).toBe(0);
    });

    test("failed logout or account refresh discards in-flight draft results without faking logout or retrying", async () => {
        for (const action of ["logout", "refresh"] as const) {
            let failSession = false, calls = 0;
            const store = createAccountStore(clientFixture({
                session: async () => { if (failSession) throw new Error("synthetic failure"); return user; },
                submit: async () => { throw new AccountError("unavailable", "未确认"); },
            }));
            await store.getState().initialize();
            let finish!: (response: Response) => void;
            const drafts = createDraftClient(store.getState().getDraftScope, (async () => {
                calls++;
                return new Promise<Response>((resolve) => { finish = resolve; });
            }) as typeof fetch);
            const pending = drafts.list();
            const settled = pending.then(() => null, (error: unknown) => error);
            if (action === "logout") {
                await expect(store.getState().submit({ action: "sign-out" })).rejects.toMatchObject({ code: "unavailable" });
                expect(store.getState().user).toEqual(user);
            } else {
                failSession = true;
                await store.getState().refresh();
                expect(store.getState().user).toBeNull();
            }
            finish(json({ items: [], nextCursor: null }));
            expect(await settled).toMatchObject({ code: "account_changed", outcome: "unknown" });
            expect(calls).toBe(1);
        }
    });
});

describe("mail return parsing", () => {
    test("only the reset path accepts exactly one token; errors never become a success claim", () => {
        expect(parseAccountReturn(new URL("https://canvas.example/reset-password?token=synthetic"))).toEqual({ resetToken: "synthetic", invalidLink: false });
        expect(parseAccountReturn(new URL("https://canvas.example/login?token=synthetic"))).toEqual({ resetToken: null, invalidLink: false });
        for (const query of ["", "?token=", "?token=one&token=two", "?error=unknown"]) {
            expect(parseAccountReturn(new URL(`https://canvas.example/reset-password${query}`)).invalidLink).toBe(true);
        }
        expect(parseAccountReturn(new URL("https://canvas.example/login?error=secret-error")).invalidLink).toBe(true);
        expect(isAccountReturnPath("/login")).toBe(true);
        expect(isAccountReturnPath("/reset-password")).toBe(true);
        expect(isAccountReturnPath("/canvas/a")).toBe(false);
    });
});
