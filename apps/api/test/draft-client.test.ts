import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import type { JsonObject } from "@infinite-canvas/shared";
import { createDraftClient } from "../../../web/src/services/saas/drafts";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createTestDatabase } from "./database";

// In-process HTTP handler contract tests, not browser cookies, SMTP/CAPTCHA or cloud media acceptance.
const origin = "https://canvas.example.test";
const password = "synthetic-draft-client-password";
const mails: { to: string; url: string }[] = [];
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;
let aliceCookie: string;
let bobCookie: string;
let aliceId: string;
let bobId: string;

function input(path: string, body: object, cookie = "") {
    return new Request(origin + path, {
        method: "POST",
        headers: { origin, cookie, "content-type": "application/json", "x-captcha-response": "synthetic-pass" },
        body: JSON.stringify(body),
    });
}

function transport(cookie: string): typeof fetch {
    return (async (path: string | URL | Request, options?: RequestInit) => {
        expect(typeof path).toBe("string");
        expect(String(path)).toMatch(/^\/api\/v1\/canvases(?:[/?]|$)/);
        expect(options?.credentials).toBe("same-origin");
        const headers = new Headers(options?.headers);
        headers.set("origin", origin);
        headers.set("cookie", cookie);
        return app(new Request(new URL(String(path), origin), { ...options, headers }), "198.51.100.33");
    }) as typeof fetch;
}

const scope = (cookie: string) => ({ accountId: cookie === aliceCookie ? aliceId : cookie === bobCookie ? bobId : "synthetic-anonymous", epoch: 1 });
const client = (cookie: string) => createDraftClient(() => scope(cookie), transport(cookie));
const draft = (title: string, document: JsonObject = {}) => ({ title, documentVersion: 1 as const, document });

beforeAll(async () => {
    database = await createTestDatabase();
    const secret = "synthetic-" + crypto.randomUUID() + crypto.randomUUID();
    app = createApp(createAccountApi({
        database: database.db, origin,
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
    for (const [name, peer] of [["draft-alice", "198.51.100.31"], ["draft-bob", "198.51.100.32"]]) {
        const email = `${name}@example.test`;
        expect((await app(input("/api/auth/sign-up/email", { name, email, password }), peer)).status).toBe(200);
        const mail = mails.find((item) => item.to === email)!;
        expect((await app(new Request(mail.url), peer)).status).toBe(302);
        const login = await app(input("/api/auth/sign-in/email", { email, password }), peer);
        expect(login.status).toBe(200);
        const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
        const session = await app(new Request(`${origin}/api/v1/session`, { headers: { origin, cookie } }), peer);
        const { user } = await session.json();
        if (name === "draft-alice") { aliceCookie = cookie; aliceId = user.id; }
        else { bobCookie = cookie; bobId = user.id; }
    }
}, 30_000);

afterAll(async () => { if (database) await database.close(); });

describe("frontend JSON draft client against the real account handler", () => {
    test("create, list and get preserve nested JSON and expose safe summaries", async () => {
        const alice = client(aliceCookie);
        const document = {
            nodes: [{ id: "synthetic-text", content: "中文与 emoji 🎨", extra: { nullable: null, enabled: false, scale: 1.25 } }],
            edges: [{ from: "synthetic-text", to: "future-node" }],
            futurePlugin: { values: [0, "", true, [1, 2], { custom: "preserved" }] },
        };
        const created = await alice.create(draft("  完整 JSON 传输测试  ", document));
        expect(created.title).toBe("完整 JSON 传输测试");
        expect(created.revision).toBe(1);
        expect(created.document).toEqual(document);
        expect(Object.keys(created).sort()).toEqual(["createdAt", "document", "documentVersion", "id", "revision", "title", "updatedAt"]);
        expect(await alice.get(created.id)).toEqual(created);
        const page = await alice.list();
        expect(page.items.find((item) => item.id === created.id)).toEqual({
            id: created.id, title: created.title, revision: 1, createdAt: created.createdAt, updatedAt: created.updatedAt,
        });
        expect(page.items.every((item) => !("document" in item) && !("ownerId" in item))).toBe(true);
    });

    test("cursor pagination from the handler is accepted without losing or repeating rows", async () => {
        const alice = client(aliceCookie);
        await alice.create(draft("分页测试 A"));
        await alice.create(draft("分页测试 B"));
        const first = await alice.list({ limit: 1 });
        expect(first.items).toHaveLength(1);
        expect(typeof first.nextCursor).toBe("string");
        const second = await alice.list({ limit: 1, cursor: first.nextCursor! });
        expect(second.items).toHaveLength(1);
        expect(second.items[0].id).not.toBe(first.items[0].id);
    });

    test("save advances revision and a stale write returns 409 without changing either draft", async () => {
        const alice = client(aliceCookie);
        const created = await alice.create(draft("冲突测试", { value: "original" }));
        const saved = await alice.save(created.id, { ...draft("已保存版本", { value: "saved" }), expectedRevision: 1 });
        expect(saved.revision).toBe(2);
        const local = { ...draft("未保存版本", { value: "retain-local" }), expectedRevision: 1 };
        await expect(alice.save(created.id, local)).rejects.toMatchObject({
            code: "revision_conflict", status: 409, outcome: "rejected", currentRevision: 2,
        });
        expect(local.document).toEqual({ value: "retain-local" });
        expect(await alice.get(created.id)).toEqual(saved);
    });

    test("two independent clients retain both local edits while only one complete document wins", async () => {
        const first = client(aliceCookie);
        const created = await first.create(draft("独立客户端竞争", { nodes: [] }));
        let writes = 0;
        const fetcher = transport(aliceCookie);
        const clients = [0, 1].map(() => createDraftClient(() => scope(aliceCookie), (async (path, options) => {
            if (options?.method === "PUT") writes++;
            return fetcher(path, options);
        }) as typeof fetch));
        const edits = ["A", "B"].map((label) => ({
            ...draft(`窗口 ${label}`, { nodes: [{ id: `node-${label}`, content: `独立修改 ${label}` }], connections: [] }),
            expectedRevision: 1,
        }));
        const originals = structuredClone(edits);
        const results = await Promise.allSettled(clients.map((page, index) => page.save(created.id, edits[index])));
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const winner = results.findIndex((result) => result.status === "fulfilled");
        const loser = results[1 - winner];
        expect(loser.status).toBe("rejected");
        if (loser.status === "rejected") expect(loser.reason).toMatchObject({
            code: "revision_conflict", status: 409, currentRevision: 2, outcome: "rejected",
        });
        const current = await first.get(created.id);
        expect(current.revision).toBe(2);
        expect(current.title).toBe(edits[winner].title);
        expect(current.document).toEqual(edits[winner].document);
        expect(edits).toEqual(originals);
        expect(writes).toBe(2);
    });

    test("anonymous reads and writes are definitive 401 rejections", async () => {
        const anonymous = client("");
        await expect(anonymous.list()).rejects.toMatchObject({ code: "unauthorized", status: 401, outcome: "rejected" });
        await expect(anonymous.create(draft("匿名拒绝"))).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
        await expect(client("").create(draft("匿名拒绝"))).rejects.toMatchObject({ code: "unauthorized", status: 401, outcome: "rejected" });
    });

    test("a second account cannot list, read or overwrite the first account's draft", async () => {
        const alice = client(aliceCookie);
        const bob = client(bobCookie);
        const created = await alice.create(draft("私有测试", { value: "alice" }));
        expect((await bob.list()).items).toEqual([]);
        await expect(bob.get(created.id)).rejects.toMatchObject({ code: "not_found", status: 404, outcome: "rejected" });
        await expect(bob.save(created.id, { ...draft("越权修改", { value: "bob" }), expectedRevision: 1 })).rejects.toMatchObject({
            code: "not_found", status: 404, outcome: "rejected", currentRevision: undefined,
        });
        expect(await alice.get(created.id)).toEqual(created);
    });

    test("a lost response after commit remains unknown and does not automatically create twice", async () => {
        const send = transport(aliceCookie);
        let calls = 0;
        const interrupted = createDraftClient(() => scope(aliceCookie), (async (...args: Parameters<typeof fetch>) => {
            calls++;
            await send(...args);
            throw new Error("synthetic response loss after server commit");
        }) as typeof fetch);
        await expect(interrupted.create(draft("响应丢失测试", { preserved: true }))).rejects.toMatchObject({
            code: "unavailable", outcome: "unknown",
        });
        expect(calls).toBe(1);
        const page = await client(aliceCookie).list();
        expect(page.items.filter((item) => item.title === "响应丢失测试")).toHaveLength(1);
    });

    test("uppercase UUID input accepts the database's canonical lowercase response", async () => {
        const alice = client(aliceCookie);
        const created = await alice.create(draft("UUID 大小写测试"));
        expect(await alice.get(created.id.toUpperCase())).toEqual(created);
        const saved = await alice.save(created.id.toUpperCase(), { ...draft("规范 ID 保存"), expectedRevision: 1 });
        expect(saved.id).toBe(created.id);
        expect(saved.revision).toBe(2);
    });

    test("an old A page with a B cookie cannot create a copy of A's content under B", async () => {
        let cookie = aliceCookie, calls = 0;
        const stale = createDraftClient(() => scope(aliceCookie), (async (...args: Parameters<typeof fetch>) => {
            calls++;
            return transport(cookie)(...args);
        }) as typeof fetch);
        const bobBefore = await client(bobCookie).list();
        cookie = bobCookie; // Another tab changes the shared cookie; this tab still displays A.
        await expect(stale.create(draft("不得转存到 B", { private: "A's synthetic content" }))).rejects.toMatchObject({
            code: "account_changed", outcome: "rejected", status: 409,
        });
        expect(await client(bobCookie).list()).toEqual(bobBefore);
        await expect(stale.list()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
        expect(calls).toBe(1);
    });

    test("a committed A write whose response arrives after switching stays unknown without a B write", async () => {
        let current = scope(aliceCookie), calls = 0;
        const alice = client(aliceCookie), bob = client(bobCookie);
        const before = await bob.list();
        const stale = createDraftClient(() => current, (async (...args: Parameters<typeof fetch>) => {
            calls++;
            const response = await transport(aliceCookie)(...args);
            current = scope(bobCookie);
            return response;
        }) as typeof fetch);
        await expect(stale.create(draft("已提交但身份变化"))).rejects.toMatchObject({ code: "account_changed", outcome: "unknown" });
        expect(calls).toBe(1);
        expect((await alice.list()).items.filter((item) => item.title === "已提交但身份变化")).toHaveLength(1);
        expect(await bob.list()).toEqual(before);
    });
});
