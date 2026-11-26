import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import type { CanvasDraft, JsonObject } from "@infinite-canvas/shared";
import { createCanvasFirstSave, type CanvasFirstSaveContext } from "../../../web/src/services/saas/canvas-first-save";
import { createCanvasVersionSession } from "../../../web/src/services/saas/canvas-version-save";
import { createReceiptedDraftClient } from "../../../web/src/services/saas/creation-receipts";
import type { CreationReceipt } from "../../../web/src/services/saas/creation-receipt-store";
import { createDraftClient } from "../../../web/src/services/saas/drafts";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createTestDatabase } from "./database";

// Gray-only seam test: this explicitly supplies cloudCanvas=true in a synthetic context.
// The public API still advertises cloudCanvas=false; this test never changes that config.
const origin = "https://canvas-json-gray.example.test";
const email = "json-gray@example.test";
const password = "synthetic-json-gray-password";
const projectId = "json-gray-project";
const mails: { to: string; url: string }[] = [];
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;
let cookie = "";
let accountId = "";

function request(path: string, body: object, session = "") {
    return new Request(origin + path, {
        method: "POST",
        headers: { origin, cookie: session, "content-type": "application/json", "x-captcha-response": "synthetic-pass" },
        body: JSON.stringify(body),
    });
}

function transport(session: string): typeof fetch {
    return (async (path: string | URL | Request, options?: RequestInit) => {
        const headers = new Headers(options?.headers);
        headers.set("origin", origin);
        headers.set("cookie", session);
        return app(new Request(new URL(String(path), origin), { ...options, headers }), "198.51.100.41");
    }) as typeof fetch;
}

function document(title: string, content: string): JsonObject {
    return {
        id: projectId,
        title,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        nodes: [{ id: "text-node", type: "text", metadata: {
            content, prompt: "https://example.invalid/prompt-is-text",
        } }],
        connections: [],
        chatSessions: [],
        activeChatId: null,
        backgroundMode: "lines",
        showImageInfo: true,
        viewport: { x: 0, y: 0, k: 1 },
    };
}

beforeAll(async () => {
    database = await createTestDatabase();
    const secret = "synthetic-" + crypto.randomUUID() + crypto.randomUUID();
    app = createApp(createAccountApi({
        database: database.db,
        origin,
        cloudCanvas: true,
        auth: {
            secret,
            sendVerificationEmail: async (mail) => { mails.push(mail); },
            sendResetPassword: async (mail) => { mails.push(mail); },
        },
        rates: createRateStore(database.pool, secret),
        verifyHuman: async (request) => request.headers.get("x-captcha-response") === "synthetic-pass",
        onFault: () => {},
    }), "synthetic-public-site-key");

    expect((await app(request("/api/auth/sign-up/email", { name: "JSON Gray", email, password }), "198.51.100.41")).status).toBe(200);
    const verification = mails.find((mail) => mail.to === email)!;
    expect((await app(new Request(verification.url), "198.51.100.41")).status).toBe(302);
    const login = await app(request("/api/auth/sign-in/email", { email, password }), "198.51.100.41");
    expect(login.status).toBe(200);
    cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const session = await app(new Request(`${origin}/api/v1/session`, { headers: { origin, cookie } }), "198.51.100.41");
    accountId = (await session.json()).user.id;
});

afterAll(async () => { if (database) await database.close(); });

test("pure JSON gray flow saves, preserves ordinary prompt URLs and pauses on a revision conflict", async () => {
    const publicSite = await app(new Request(`${origin}/api/v1/site`));
    expect(publicSite.status).toBe(200);
    expect((await publicSite.json()).features.cloudCanvas).toBe(false);
    const scope = () => ({ accountId, epoch: 1 });
    const receipts = new Map<string, CreationReceipt>();
    const receiptStore = {
        async list(ownerId: string, localProjectId: string) {
            return [...receipts.values()].filter((row) => row.accountId === ownerId && row.localProjectId === localProjectId);
        },
        async put(row: CreationReceipt) { receipts.set(row.creationId, structuredClone(row)); },
    };
    const context: CanvasFirstSaveContext = { accountId, epoch: 1, localProjectId: projectId, cloudCanvas: true };
    const firstClient = createReceiptedDraftClient(scope, receiptStore, transport(cookie));
    const first = createCanvasFirstSave(() => context, () => firstClient);
    const prepared = await first.prepare(document("纯 JSON 灰度初始版本", "初始文本"));
    expect(prepared.counts).toMatchObject({ nodes: 1, connections: 0, chats: 0, localMediaReferences: 0 });
    const created = await first.submit();
    expect(created.revision).toBe(1);

    const client = createDraftClient(scope, transport(cookie));
    const version = createCanvasVersionSession(() => context, (getScope) => createDraftClient(getScope, transport(cookie)));
    version.seedCreation(created);
    const window = version.open();
    const next = document("本地待保存版本", "本地内容应保留");
    const nextPrepared = window.prepare(next);
    expect(nextPrepared.counts.localMediaReferences).toBe(0);

    const external = await client.save(created.id, {
        title: "另一窗口已保存",
        documentVersion: 1,
        document: document("另一窗口已保存", "已保存内容"),
        expectedRevision: 1,
    });
    expect(external.revision).toBe(2);

    const conflict = await window.submit().catch((error) => error);
    expect(conflict).toMatchObject({ code: "revision_conflict", outcome: "rejected", currentRevision: 2 });
    expect(window.getState()).toMatchObject({ phase: "conflict", observedRevision: 2 });
    expect(version.getState()).toMatchObject({ status: "conflict", observedRevision: 2 });

    const current = await client.get(created.id);
    expect(current).toMatchObject({ revision: 2, title: "另一窗口已保存" });
    expect(current.document).toEqual(document("另一窗口已保存", "已保存内容"));
    expect(JSON.stringify(current.document)).toContain("https://example.invalid/prompt-is-text");
    expect(next).toEqual(document("本地待保存版本", "本地内容应保留"));
});
