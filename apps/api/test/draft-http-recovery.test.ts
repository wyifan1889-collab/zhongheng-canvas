import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { canvasDraft } from "@infinite-canvas/database/schema";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { createDraftClient } from "../../../web/src/services/saas/drafts";
import { createCanvasVersionSession } from "../../../web/src/services/saas/canvas-version-save";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createTestDatabase } from "./database";

// Real loopback HTTP, account handler and database; synthetic identity and mail.
// Only the committed PUT response is truncated. No product timeout is changed,
// and this does not claim browser persistence, TCP disconnect or OSS coverage.
test("a committed PUT with truncated HTTP JSON stays read-only after reopening and live reconciliation", async () => {
    const database = await createTestDatabase();
    try {
        let app: ReturnType<typeof createApp>;
        let interruptedId: string | undefined;
        let truncatedResponses = 0;
        const requests: { method: string; path: string; status: number }[] = [];
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, server) {
            const path = new URL(request.url).pathname;
            const response = await app(request, server.requestIP(request)?.address);
            if (path.startsWith("/api/v1/canvases")) requests.push({ method: request.method, path, status: response.status });
            if (request.method === "PUT" && path === `/api/v1/canvases/${interruptedId}` && response.status === 200 && truncatedResponses === 0) {
                const body = await response.text(); // The real transaction has committed before this fault.
                truncatedResponses++;
                const headers = new Headers(response.headers);
                headers.delete("content-length");
                return new Response(body.slice(0, -1), { status: 200, headers });
            }
            return response;
        } });
        let session: ReturnType<typeof createCanvasVersionSession> | undefined;
        try {
            const origin = `http://127.0.0.1:${server.port}`;
            const secret = "synthetic-http-recovery-" + crypto.randomUUID() + crypto.randomUUID();
            const mails: { to: string; url: string }[] = [];
            app = createApp(createAccountApi({
                database: database.db, origin, cloudCanvas: true,
                auth: { secret, sendVerificationEmail: async (mail) => { mails.push(mail); } },
                rates: createRateStore(database.pool, secret),
                verifyHuman: async (request) => request.headers.get("x-captcha-response") === "synthetic-pass",
                onFault: () => {},
            }), "synthetic-public-site-key", true);
            const authRequest = (path: string, body?: object, cookie = "") => fetch(new URL(path, origin), {
                method: body === undefined ? "GET" : "POST", redirect: "manual",
                headers: { origin, cookie, "content-type": "application/json", "x-captcha-response": "synthetic-pass" },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            const email = `http-recovery-${crypto.randomUUID()}@example.test`;
            const password = "synthetic-http-recovery-password";
            const signup = await authRequest("/api/auth/sign-up/email", { name: "HTTP recovery", email, password });
            expect(signup.status).toBe(200);
            await signup.text();
            const verification = await authRequest(mails.find((mail) => mail.to === email)!.url);
            expect(verification.status).toBe(302);
            await verification.text();
            const login = await authRequest("/api/auth/sign-in/email", { email, password });
            expect(login.status).toBe(200);
            const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
            await login.text();
            const identity = await authRequest("/api/v1/session", undefined, cookie);
            expect(identity.status).toBe(200);
            const { user } = await identity.json();
            const scope = { accountId: user.id as string, epoch: 1 };
            // This adapter only resolves relative URLs and supplies the synthetic
            // browser cookie/origin. Signals, bodies and responses use native fetch.
            const transport: typeof fetch = Object.assign((path: Parameters<typeof fetch>[0], options?: Parameters<typeof fetch>[1]) => {
                const headers = new Headers(options?.headers);
                headers.set("origin", origin); headers.set("cookie", cookie);
                return fetch(new URL(String(path), origin), { ...options, headers });
            }, { preconnect: fetch.preconnect });
            const original = {
                id: "synthetic-http-local-project", title: "HTTP 恢复检查", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
                nodes: [{ id: "text", type: "text", title: "文字", position: { x: 10, y: 20 }, width: 300, height: 150, metadata: { content: "版本一", status: "idle" } }],
                connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
            };
            const created = await createDraftClient(() => scope, transport).create({ title: original.title, documentVersion: 1, document: original });
            expect(created.revision).toBe(1);
            interruptedId = created.id;
            session = createCanvasVersionSession(() => ({ ...scope, localProjectId: original.id, cloudCanvas: true }),
                (getScope) => createDraftClient(getScope, transport));
            session.seedCreation(created);
            const window = session.open();
            const local = structuredClone(original);
            local.title = "已提交的版本二";
            local.nodes[0].metadata.content = "已提交的完整正文 🎨";
            const submittedSnapshot = structuredClone(local);
            window.prepare(local);
            // A later editor change must not enter the prepared PUT or be lost
            // when that write's response cannot be confirmed.
            local.title = "提交快照后的本机修改";
            local.nodes[0].metadata.content = "本机仍需保留的后续编辑";
            const retainedLocal = structuredClone(local);
            await expect(window.submit()).rejects.toMatchObject({ code: "unavailable", outcome: "unknown" });
            expect(truncatedResponses).toBe(1);
            expect(requests).toEqual([
                { method: "POST", path: "/api/v1/canvases", status: 201 },
                { method: "PUT", path: `/api/v1/canvases/${created.id}`, status: 200 },
            ]);
            expect(session.getState()).toMatchObject({ status: "unknown", id: created.id, revision: 1 });
            expect(window.getState()).toMatchObject({ phase: "unknown", expectedRevision: 1 });
            window.close();
            const reopened = session.open();
            expect(reopened.getState()).toMatchObject({ phase: "unknown", expectedRevision: 1 });
            expect(await reopened.reconcile()).toMatchObject({ status: "found-current", id: created.id, revision: 2 });
            expect(session.getState()).toMatchObject({ status: "unknown", revision: 1 });
            expect(reopened.getState()).toMatchObject({ phase: "unknown", expectedRevision: 1 });
            expect(() => reopened.prepare(local)).toThrow(expect.objectContaining({ code: "readonly", outcome: "not-sent" }));
            await expect(reopened.submit()).rejects.toMatchObject({ code: "readonly", outcome: "not-sent" });
            expect(requests).toEqual([
                { method: "POST", path: "/api/v1/canvases", status: 201 },
                { method: "PUT", path: `/api/v1/canvases/${created.id}`, status: 200 },
                { method: "GET", path: `/api/v1/canvases/${created.id}`, status: 200 },
            ]);
            const records = await database.db.select().from(canvasDraft).where(eq(canvasDraft.id, created.id));
            expect(records).toHaveLength(1);
            expect(records[0]).toMatchObject({ ownerId: scope.accountId, revision: 2, title: submittedSnapshot.title, document: submittedSnapshot });
            expect(local).toEqual(retainedLocal);
            reopened.close();
        } finally {
            session?.dispose();
            await server.stop(true);
        }
    } finally { await database.close(); }
}, 30_000);
