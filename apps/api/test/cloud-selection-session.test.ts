import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { user as userTable } from "@infinite-canvas/database/schema";
import { createDraftRepository } from "@infinite-canvas/database/drafts";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { createMemoryObjectStorage } from "@infinite-canvas/storage";
import { createAccountClient } from "../../../web/src/services/saas/account";
import type { AccountSessionSync } from "../../../web/src/services/saas/account-session-sync";
import { captureAccountLocalScope, getAccountLocalScope, setAccountLocalAccount, subscribeAccountLocalScope } from "../../../web/src/services/saas/account-local-scope";
import { createAccountStore } from "../../../web/src/stores/use-account-store";
import { createDraftClient } from "../../../web/src/services/saas/drafts";
import { createCanvasVersionSession } from "../../../web/src/services/saas/canvas-version-save";
import { createCanvasCloudSelection } from "../../../web/src/components/canvas/canvas-cloud-selection";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createTestDatabase } from "./database";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

// Real isolated HTTP/auth/database and production selection/account controllers.
// Only the visibility notification and delivery of an authenticated GET are controlled;
// this is not a browser hidden-to-visible, React lifecycle, or real-account test.
for (const change of ["stable", "role", "account"] as const) {
    test(`pending cloud selection survives only a stable real session recheck (${change})`, async () => {
        if (process.env.SAAS_TEST_DATABASE_URL) throw new Error("This selection test requires the in-memory database.");
        const previousLocalOwner = getAccountLocalScope()?.accountId ?? null;
        const database = await createTestDatabase();
        const captured = deferred(), release = deferred();
        let server: ReturnType<typeof Bun.serve> | undefined;
        let confirmation: Promise<unknown> | undefined, recheck: Promise<void> | undefined;
        let controller: ReturnType<typeof createCanvasCloudSelection> | undefined;
        const candidates: ReturnType<typeof createCanvasVersionSession>[] = [];
        let unsubscribe = () => {}, unsubscribeLocal = () => {}, visible = () => {};
        try {
            let app: ReturnType<typeof createApp>, delayedPath = "";
            const requests: { method: string; path: string; status: number }[] = [];
            server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, server) {
                const response = await app(request, server.requestIP(request)?.address);
                const path = new URL(request.url).pathname;
                requests.push({ method: request.method, path, status: response.status });
                if (request.method === "GET" && path === delayedPath && response.status === 200) {
                    delayedPath = "";
                    const body = await response.arrayBuffer();
                    captured.resolve();
                    await release.promise;
                    return new Response(body, { status: response.status, headers: response.headers });
                }
                return response;
            } });
            const origin = `http://127.0.0.1:${server.port}`;
            const secret = "synthetic-selection-session-" + crypto.randomUUID() + crypto.randomUUID();
            const mails: { to: string; url: string }[] = [];
            app = createApp(createAccountApi({
                database: database.db, origin, cloudCanvas: true,
                auth: { secret, sendVerificationEmail: async (mail) => { mails.push(mail); } },
                rates: createRateStore(database.pool, secret),
                verifyHuman: async (request) => request.headers.get("x-captcha-response") === "synthetic-pass",
                media: { storage: createMemoryObjectStorage(), quotaBytes: 10, maxBytes: { image: 8, video: 8, audio: 8 } },
                onFault: () => {},
            }), "synthetic-public-site-key", true, true);
            const authRequest = (path: string, body?: object) => fetch(new URL(path, origin), {
                method: body === undefined ? "GET" : "POST", redirect: "manual",
                headers: { origin, "content-type": "application/json", "x-captcha-response": "synthetic-pass" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            async function loginSyntheticAccount() {
                const email = `selection-${crypto.randomUUID()}@example.test`, password = "synthetic-selection-password";
                const signup = await authRequest("/api/auth/sign-up/email", { name: "Selection session", email, password });
                expect(signup.status).toBe(200); await signup.text();
                const verification = await authRequest(mails.find((mail) => mail.to === email)!.url);
                expect(verification.status).toBe(302); await verification.text();
                const login = await authRequest("/api/auth/sign-in/email", { email, password });
                expect(login.status).toBe(200);
                const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
                await login.text();
                const [owner] = await database.db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, email));
                return { cookie, owner: owner.id };
            }
            const first = await loginSyntheticAccount();
            let cookie = first.cookie;
            // No adminEmail bootstrap: the real downgrade below must remain authoritative.
            await database.db.update(userTable).set({ role: "admin" }).where(eq(userTable.id, first.owner));
            const transport: typeof fetch = Object.assign((path: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
                const headers = new Headers(options?.headers);
                headers.set("origin", origin); headers.set("cookie", cookie);
                return fetch(new URL(String(path), origin), { ...options, headers });
            }, { preconnect: fetch.preconnect });
            const sync: AccountSessionSync = {
                publishInvalidated: () => {}, subscribeInvalidated: () => () => {}, close: () => {},
                subscribeVisible: (listener) => { visible = listener; return () => { visible = () => {}; }; },
            };
            const account = createAccountStore(createAccountClient(transport), sync);
            await account.getState().initialize();
            const scope = account.getState().getDraftScope()!, localScope = getAccountLocalScope();
            const localOperation = captureAccountLocalScope();
            expect(account.getState()).toMatchObject({ status: "ready", user: { id: first.owner, role: "admin" } });
            expect(localScope).toMatchObject({ accountId: first.owner });
            const drafts = createDraftClient(account.getState().getDraftScope, transport);
            const document = (id: string) => ({ id, title: "同名选版草稿", nodes: [], connections: [], chatSessions: [] });
            const decoy = await drafts.create({ title: "同名选版草稿", documentVersion: 1, document: document("unselected-source") });
            const selected = await drafts.create({ title: "同名选版草稿", documentVersion: 1, document: document("selected-source") });
            const directory = await drafts.list();
            const selection = directory.items.find((draft) => draft.id === selected.id)!;
            expect(selection.id).not.toBe(decoy.id);
            const repository = createDraftRepository(database.db);
            const rowsBefore = await Promise.all([repository.get(first.owner, decoy.id), repository.get(first.owner, selected.id)]);
            const adopted: ReturnType<typeof createCanvasVersionSession>[] = [];
            controller = createCanvasCloudSelection(() => true, () => {
                const candidate = createCanvasVersionSession(() => {
                    const current = account.getState().getDraftScope();
                    return current ? { ...current, localProjectId: "independent-local-target", cloudCanvas: account.getState().site?.cloudCanvas === true } : null;
                }, (getScope) => createDraftClient(getScope, transport));
                candidates.push(candidate);
                return candidate;
            }, (candidate) => { adopted.push(candidate); });
            delayedPath = `/api/v1/canvases/${selected.id}`;
            confirmation = controller.confirm({ accountId: first.owner, id: selection.id, revision: selection.revision }).then(() => null, (error: unknown) => error);
            await Promise.race([
                captured.promise,
                confirmation.then(() => { throw new Error("Selection ended before an authenticated GET 200 response was captured."); }),
            ]);
            expect(adopted).toHaveLength(0);
            expect(candidates[0].getState()).toEqual({ status: "empty" });
            const statuses: string[] = [];
            const observations: unknown[] = [], localChanges: unknown[] = [];
            unsubscribe = account.subscribe((state) => {
                statuses.push(state.status);
                observations.push({ status: state.status, scope: state.getDraftScope(), localScope: getAccountLocalScope() });
            });
            unsubscribeLocal = subscribeAccountLocalScope((local) => { localChanges.push(local); });
            localChanges.length = 0;

            let expectedOwner = first.owner;
            if (change === "role") await database.db.update(userTable).set({ role: "user" }).where(eq(userTable.id, first.owner));
            if (change === "account") {
                const second = await loginSyntheticAccount();
                cookie = second.cookie; expectedOwner = second.owner;
            }
            visible();
            expect(account.getState().getDraftScope()).toEqual(scope);
            recheck = account.getState().initialize(); // Join the actual background site/session requests.
            await recheck;
            expect(account.getState()).toMatchObject({ status: "ready", user: { id: expectedOwner, role: change === "stable" ? "admin" : "user" } });
            expect(statuses).toEqual(["ready"]);
            expect(requests.filter((request) => request.path === "/api/v1/site").map((request) => request.status)).toEqual([200, 200]);
            expect(requests.filter((request) => request.path === "/api/v1/session").map((request) => request.status)).toEqual([200, 200]);
            if (change === "stable") {
                expect(account.getState().getDraftScope()).toEqual(scope);
                expect(observations).toEqual([{ status: "ready", scope, localScope }]);
            } else expect(account.getState().getDraftScope()!.epoch).toBeGreaterThan(scope.epoch);
            if (change === "account") {
                expect(getAccountLocalScope()?.accountId).toBe(expectedOwner);
                expect(localOperation.isCurrent()).toBe(false);
            } else {
                expect(getAccountLocalScope()).toEqual(localScope);
                expect(localOperation.isCurrent()).toBe(true);
                expect(localChanges).toEqual([]);
            }
            release.resolve();
            const result = await confirmation;
            if (change === "stable") {
                expect(result).toBeNull();
                expect(adopted.map((candidate) => candidate.getState())).toEqual([{ status: "ready", id: selected.id, revision: selection.revision }]);
                controller.cancel(); // Closing the directory preserves the already adopted baseline.
                const window = adopted[0].open();
                expect(window.getState()).toMatchObject({ phase: "idle", id: selected.id, expectedRevision: selection.revision });
                window.close();
            } else {
                expect(result).toMatchObject({ code: "account_changed" });
                expect(adopted).toHaveLength(0);
                expect(candidates[0].getState()).toEqual({ status: "blocked" });
            }
            expect(requests.filter((request) => request.path.startsWith("/api/v1/canvases/") && request.method === "GET")).toEqual([
                { method: "GET", path: `/api/v1/canvases/${selected.id}`, status: 200 },
            ]);
            expect(requests.filter((request) => request.path.startsWith("/api/v1/canvases") && request.method !== "GET")).toEqual([
                { method: "POST", path: "/api/v1/canvases", status: 201 },
                { method: "POST", path: "/api/v1/canvases", status: 201 },
            ]);
            expect(await Promise.all([repository.get(first.owner, decoy.id), repository.get(first.owner, selected.id)])).toEqual(rowsBefore);
        } finally {
            release.resolve(); controller?.cancel();
            await Promise.allSettled([confirmation, recheck]);
            candidates.forEach((candidate) => candidate.dispose());
            unsubscribe(); unsubscribeLocal(); visible = () => {};
            setAccountLocalAccount(previousLocalOwner);
            await server?.stop(true);
            await database.close();
        }
    });
}
