import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { generationTask, session as sessionTable, user } from "@infinite-canvas/database/schema";
import type { InspirationItem } from "@infinite-canvas/shared";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createInspirationStore } from "../src/inspiration-store";
import { accountPolicy } from "../src/policy";
import { createTestDatabase } from "./database";

if (process.env.SAAS_TEST_DATABASE_URL || process.env.SAAS_DATABASE_URL || process.env.DATABASE_URL) {
    throw new Error("Only in-memory PGlite is permitted");
}
const origin = "http://localhost:4047";
const publicPath = "/api/v1/inspiration/items";
const adminPath = "/api/v1/admin/inspiration/items";
const secret = "inspiration-synthetic-" + crypto.randomUUID();
const password = "inspiration-synthetic-password";
type Identity = { id: string; cookie: string };
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;
let directory: string, file: string;
let store: ReturnType<typeof createInspirationStore>;
let admin: Identity, secondAdmin: Identity, member: Identity;
let rejectBucket: string | undefined;
const consumed: { bucket: string; identity: string }[] = [];
const published: InspirationItem[] = [
    { id: "curated-image", type: "image", title: "光影练习", prompt: "管理员明确发布的图像提示词", imageUrl: "https://images.example.com/inspiration/a.png", tags: ["光影"] },
    { id: "curated-video", type: "video", title: "镜头练习", prompt: "管理员明确发布的视频提示词", imageUrl: "/inspiration-assets/video/poster.png", tags: [] },
    { id: "curated-audio", type: "audio", title: "声音练习", prompt: "管理员明确发布的声音提示词", imageUrl: "/inspiration-assets/audio.png", tags: ["氛围", "音乐"] },
];

function request(path = adminPath, identity: Identity = admin, method = "GET", body?: unknown, extra: HeadersInit = {}, handler = app) {
    const headers = new Headers({ origin, cookie: identity.cookie, "x-canvas-account-id": identity.id, "content-type": "application/json" });
    new Headers(extra).forEach((value, key) => headers.set(key, value));
    return handler(new Request(`${origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), "198.51.100.47");
}

async function catalog() {
    const response = await request();
    expect(response.status).toBe(200);
    const { revision, items } = await response.json() as { revision: number; items: InspirationItem[] };
    return { revision, items };
}

async function register(email: string): Promise<Identity> {
    const signup = await app(new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST", headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email, password, name: "Synthetic inspiration user" }),
    }), "198.51.100.47");
    expect(signup.status).toBe(200);
    const [row] = await database.db.select({ id: user.id }).from(user).where(eq(user.email, email));
    await database.db.update(user).set({ emailVerified: true }).where(eq(user.id, row!.id));
    const signin = await app(new Request(`${origin}/api/auth/sign-in/email`, {
        method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email, password }),
    }), "198.51.100.47");
    expect(signin.status).toBe(200);
    return { id: row!.id, cookie: signin.headers.getSetCookie().map(value => value.split(";")[0]).join("; ") };
}

function accounts(inspiration: ReturnType<typeof createInspirationStore> | null = store) {
    const rates = createRateStore(database.pool, secret);
    return createAccountApi({
        database: database.db, origin, ...(inspiration ? { inspiration } : {}),
        auth: { secret, sendVerificationEmail: async () => undefined, sendResetPassword: async () => undefined },
        rates: { async consume(bucket, identity, rule) {
            consumed.push({ bucket, identity });
            if (bucket === rejectBucket) return { allowed: false, retryAfter: 1 };
            return rates.consume(bucket, identity, rule);
        } },
        verifyHuman: async () => true, onFault: () => undefined,
    });
}

beforeAll(async () => {
    database = await createTestDatabase();
    directory = await mkdtemp(join(tmpdir(), "canvas-inspiration-api-"));
    file = join(directory, "inspiration.json");
    store = createInspirationStore(file);
    app = createApp(accounts(), "synthetic-public-site-key", false, false, undefined, {}, store);
    admin = await register("inspiration-admin@example.test");
    secondAdmin = await register("inspiration-second-admin@example.test");
    member = await register("inspiration-member@example.test");
    for (const identity of [admin, secondAdmin]) await database.db.update(user).set({ role: "admin" }).where(eq(user.id, identity.id));
    await database.db.insert(generationTask).values({
        id: crypto.randomUUID(), ownerId: member.id, modelId: "private-model", inputSnapshot: { prompt: "private-user-history-must-not-be-published" },
        parameterSnapshot: {}, idempotencyKey: "private-inspiration-history", requestId: "private-inspiration-request",
        executionStatus: "unknown", unknownReason: "provider_response_unknown", billingStatus: "pending_review",
    });
});
afterAll(async () => {
    try { await database?.close(); }
    finally {
        if (directory) {
            const target = resolve(directory);
            if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("canvas-inspiration-api-")) {
                throw new Error("Refusing cleanup outside the dedicated inspiration API test directory");
            }
            await rm(target, { recursive: true, force: true });
        }
    }
});

test("anonymous public reads start empty and require neither session nor account infrastructure", async () => {
    const response = await app(new Request(`${origin}${publicPath}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ items: [] });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect((await catalog()).revision).toBe(0);
    const unconfigured = createApp();
    expect(await (await unconfigured(new Request(`${origin}${publicPath}`))).json()).toMatchObject({ items: [] });
    expect((await unconfigured(new Request(`${origin}${publicPath}`, { method: "PUT" }))).status).toBe(405);
});

test("admin publishes the ordered JSON list; public projection and a fresh store preserve only the agreed fields", async () => {
    const response = await request(adminPath, admin, "PUT", { expectedRevision: 0, items: published });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ revision: 1, items: published });
    const publicResponse = await app(new Request(`${origin}${publicPath}`));
    const body = await publicResponse.json();
    expect(Object.keys(body).sort()).toEqual(["items", "requestId"]);
    expect(body.items).toEqual(published);
    for (const item of body.items) expect(Object.keys(item).sort()).toEqual(["id", "imageUrl", "prompt", "tags", "title", "type"]);
    expect(JSON.stringify(body)).not.toContain("private-");
    expect(JSON.stringify(body)).not.toContain(admin.id);
    expect(publicResponse.headers.get("x-request-id")).toBe(body.requestId);
    expect(await createInspirationStore(file).read()).toEqual({ revision: 1, items: published });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ schemaVersion: 1, revision: 1, items: published });
});

test("admin reads and writes retain principal, Origin and account-context guards", async () => {
    const before = await catalog();
    for (const [identity, extra, status, code] of [
        [{ id: "", cookie: "" }, {}, 401, "unauthorized"],
        [member, {}, 403, "forbidden"],
        [admin, { "x-canvas-account-id": "" }, 400, "account_context_required"],
        [admin, { "x-canvas-account-id": member.id }, 409, "account_changed"],
        [admin, { origin: "https://untrusted.invalid" }, 403, "invalid_origin"],
        [admin, { "sec-fetch-site": "cross-site" }, 403, "invalid_origin"],
    ] as const) {
        for (const method of ["GET", "PUT"]) {
            const response = await request(adminPath, identity, method, method === "PUT" ? { expectedRevision: before.revision, items: [] } : undefined, extra);
            expect(response.status).toBe(status);
            expect((await response.json()).error.code).toBe(code);
        }
    }
    expect(await catalog()).toEqual(before);
    expect((await request(adminPath, admin, "DELETE")).status).toBe(405);
});

test("strict item validation and public-only image URLs reject the whole write without altering JSON", async () => {
    const before = await catalog();
    const item = published[0]!;
    for (const items of [
        [item, item], [{ ...item, type: "text" }], [{ ...item, id: " " }],
        [{ ...item, title: " " }], [{ ...item, prompt: "\n" }], [{ ...item, tags: [""] }],
        [{ ...item, ownerId: member.id }], [{ ...item, imageUrl: "javascript:alert(1)" }],
        [{ ...item, imageUrl: "http://images.example.com/a.png" }],
        [{ ...item, imageUrl: "https://127.0.0.1/private.png" }],
        [{ ...item, imageUrl: "/api/v1/media/private" }],
        [{ ...item, imageUrl: "/inspiration-assets/../private.png" }],
    ]) {
        const response = await request(adminPath, admin, "PUT", { expectedRevision: before.revision, items });
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe("invalid_input");
    }
    const unknown = await request(adminPath, admin, "PUT", { expectedRevision: before.revision, items: [], publishPrivateHistory: true });
    expect(unknown.status).toBe(400);
    expect(await catalog()).toEqual(before);
});

test("a second admin cannot overwrite an update made since its last read", async () => {
    const before = await catalog();
    const replacement = [{ ...published[0]!, title: "第一位管理员的新标题" }];
    const first = await request(adminPath, admin, "PUT", { expectedRevision: before.revision, items: replacement });
    expect(first.status).toBe(200);
    const stale = await request(adminPath, secondAdmin, "PUT", { expectedRevision: before.revision, items: [] });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { code: "inspiration_revision_conflict" }, currentRevision: before.revision + 1 });
    expect(await catalog()).toEqual({ revision: before.revision + 1, items: replacement });
});

test("existing rate budgets and streamed JSON limits also guard administrator publishing", async () => {
    const before = await catalog();
    for (const [bucket, method] of [["account-read", "GET"], ["canvas-save", "PUT"]] as const) {
        rejectBucket = bucket;
        try {
            const response = await request(adminPath, admin, method, method === "PUT" ? { expectedRevision: before.revision, items: [] } : undefined);
            expect(response.status).toBe(429);
            expect(response.headers.get("retry-after")).toBe("1");
            expect(consumed.at(-1)).toEqual({ bucket, identity: admin.id });
        } finally { rejectBucket = undefined; }
    }
    const oversized = await request(adminPath, admin, "PUT", { expectedRevision: before.revision, items: [] }, { "content-length": String(accountPolicy.documentBytes + 1) });
    expect(oversized.status).toBe(413);
    const unsupported = await request(adminPath, admin, "PUT", { expectedRevision: before.revision, items: [] }, { "content-type": "text/plain" });
    expect(unsupported.status).toBe(415);
    const streamed = await request(adminPath, admin, "PUT", { expectedRevision: before.revision, items: [{ ...published[0]!, prompt: "x".repeat(accountPolicy.documentBytes) }] });
    expect(streamed.status).toBe(413);
    expect(await catalog()).toEqual(before);
});

test("revoked sessions and demoted administrators cannot publish a previously read version", async () => {
    const before = await catalog();
    await database.db.delete(sessionTable).where(eq(sessionTable.userId, secondAdmin.id));
    expect((await request(adminPath, secondAdmin, "PUT", { expectedRevision: before.revision, items: [] })).status).toBe(401);
    await database.db.update(user).set({ role: "user" }).where(eq(user.id, admin.id));
    try {
        expect((await request(adminPath, admin, "PUT", { expectedRevision: before.revision, items: [] })).status).toBe(403);
    } finally { await database.db.update(user).set({ role: "admin" }).where(eq(user.id, admin.id)); }
    expect(await catalog()).toEqual(before);
});

test("empty publication withdraws all items and malformed stored JSON fails closed", async () => {
    const before = await catalog();
    const response = await request(adminPath, admin, "PUT", { expectedRevision: before.revision, items: [] });
    expect(response.status).toBe(200);
    expect(await (await app(new Request(`${origin}${publicPath}`))).json()).toMatchObject({ items: [] });
    const stored = await readFile(file, "utf8");
    try {
        await writeFile(file, JSON.stringify({ schemaVersion: 1, revision: before.revision + 1, items: [{ ...published[0]!, privateHistory: "not-public" }] }));
        const failed = await app(new Request(`${origin}${publicPath}`));
        expect(failed.status).toBe(503);
        expect(JSON.stringify(await failed.json())).not.toContain("not-public");
    } finally { await writeFile(file, stored); }
});

test("unconfigured administrator storage reports unavailable rather than creating an ephemeral catalog", async () => {
    const unconfigured = createApp(accounts(null), "synthetic-public-site-key");
    for (const method of ["GET", "PUT"]) {
        const response = await request(adminPath, admin, method, method === "PUT" ? { expectedRevision: 0, items: [] } : undefined, {}, unconfigured);
        expect(response.status).toBe(503);
        expect((await response.json()).error.code).toBe("inspiration_unavailable");
    }
    expect(await (await unconfigured(new Request(`${origin}${publicPath}`))).json()).toMatchObject({ items: [] });
});
