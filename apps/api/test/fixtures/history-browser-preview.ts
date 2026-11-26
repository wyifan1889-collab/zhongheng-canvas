import { eq } from "drizzle-orm";
import sharp from "sharp";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { encryptProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { readModelMappingDraft, saveModelMappingDraft } from "@infinite-canvas/database/model-mapping-drafts";
import { previewMappingPublication, publishMappingConfiguration } from "@infinite-canvas/database/model-mapping-publications";
import * as schema from "@infinite-canvas/database/schema";
import { emptyMappingDraft, mappingCombinationKey, mappingSourceKey } from "@infinite-canvas/shared";
import { createMemoryObjectStorage, objectKey } from "@infinite-canvas/storage";
import { imageSizePresets } from "../../../../web/src/lib/media-size";
import { createAccountApi } from "../../src/accounts";
import { createApp } from "../../src/app";
import { createGenerationDelivery, createGenerationImageSpecMediaVerifier } from "../../src/generation-delivery";
import { generationImageMediaId } from "../../src/generation-image";
import { createGenerationProvider } from "../../src/generation-provider";
import { createGenerationWalletSettlement, processGenerationJob } from "../../src/generation-worker";
import type { GenerationJobPayload } from "@infinite-canvas/jobs";
import { createTestDatabase } from "../database";

const origin = process.argv[2];
const creative = process.argv[3] === "--image-conversations";
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin ?? "") || process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Isolated loopback preview required");
const { db, pool } = await createTestDatabase();
const secret = crypto.randomUUID() + crypto.randomUUID(), email = "history-preview@example.test", password = crypto.randomUUID() + crypto.randomUUID();
const storage = createMemoryObjectStorage(), mails: { url: string }[] = [];
const jobs = new Map<string, GenerationJobPayload>();
const quotaBytes = creative ? 100_000_000 : 100_000;
const maxBytes = { image: creative ? 16_000_000 : 100_000, audio: 100_000, video: 100_000 };
const providerId = "history-preview-provider", providerModel = "gpt-image-2.5-flare-1k", modelId = "gpt-image-2.5-flare";
const app = createApp(createAccountApi({ database: db, origin: origin!, auth: { secret, sendVerificationEmail: async mail => { mails.push(mail); } },
    rates: createRateStore(pool, secret), verifyHuman: async () => true, onFault: () => {},
    providerResolver: async hostname => {
        if (hostname !== "history-preview.example.test") throw new Error("Fixture provider only");
        return ["93.184.216.34"];
    },
    generation: { enabled: true, imageEnabled: true, queue: { async send(_name, job, options) {
        if (!creative || !options?.db) throw new Error("Preview generation is disabled");
        jobs.set(job.taskId, job);
        return crypto.randomUUID();
    } } },
    media: { storage, quotaBytes, maxBytes },
}), "1x00000000000000000000AA", false, true, undefined, { image: true });
globalThis.fetch = (async () => { throw new Error("Preview external requests blocked"); }) as typeof fetch;
async function post(path: string, body: unknown) {
    return app(new Request(origin + path, { method: "POST", headers: { origin: origin!, "content-type": "application/json" }, body: JSON.stringify(body) }), "127.0.0.1");
}
if (!(await post("/api/auth/sign-up/email", { email, password, name: "创作历史隔离账户" })).ok || !mails[0]) throw new Error("Preview account creation failed");
await app(new Request(mails[0].url), "127.0.0.1");
const signIn = await post("/api/auth/sign-in/email", { email, password });
if (!signIn.ok) throw new Error("Preview sign-in failed");
const cookies = signIn.headers.getSetCookie();
const [owner] = await db.update(schema.user).set({ role: "admin" }).where(eq(schema.user.email, email)).returning();
const [session] = await db.select().from(schema.session).where(eq(schema.session.userId, owner!.id));
const actor = { actorId: owner!.id, sessionId: session!.id, sessionExpiresAt: session!.expiresAt, requestId: "history-browser-preview" };
await db.insert(schema.wallet).values({ userId: owner!.id, availableUnits: "1000" });
await db.insert(schema.modelProvider).values({ id: providerId, displayName: "仅用于本机验收", adapter: "openai-compatible", endpoint: "https://history-preview.example.test/v1", secretRef: `db:model-provider-credential:${providerId}`, enabled: true });
await db.insert(schema.modelProviderCredential).values({ providerId, ...encryptProviderCredential(secret, providerId, "synthetic-key") });
await db.insert(schema.providerDiscoveredModel).values({ providerId, providerModel });
const draft = emptyMappingDraft();
draft.models = [{ id: modelId, displayName: "GPT Image 2.5 Flare", capability: "image", group: "OpenAI" }];
draft.modelSpecifications = { [modelId]: ["1K", "2K", "4K"] };
draft.bindings = Object.entries(imageSizePresets).flatMap(([scale, sizes]) => Object.values(sizes).map(size => ({ providerId, providerModel,
    modelId, specification: scale.toUpperCase(), execution: { protocol: "openai-image-v1" as const, parameters: { size, quality: "medium" as const }, maxImagesPerRequest: 4 } })));
for (const binding of draft.bindings) {
    const key = mappingCombinationKey(binding);
    draft.preferred[key] = mappingSourceKey(binding);
    draft.prices[key] = "7";
}
const before = await readModelMappingDraft(db, actor);
await saveModelMappingDraft(db, { expectedVersion: before.version, draft, providers: [{ providerId, revision: 1 }] }, actor);
const preview = await previewMappingPublication(db, actor);
await publishMappingConfiguration(db, { expectedDraftVersion: preview.draftVersion, expectedPublicationVersion: preview.publicationVersion, fingerprint: preview.fingerprint }, actor);
const [executable] = await db.select({ id: schema.modelCatalog.publicId }).from(schema.modelCatalog).where(eq(schema.modelCatalog.providerId, providerId));

const taskId = crypto.randomUUID(), olderTaskId = crypto.randomUUID();
const images = await Promise.all(["#376e5d", "#516ba0"].map(async (background, index) => {
    const id = generationImageMediaId(taskId, index), width = 1536, height = 864;
    const svg = Buffer.from(`<svg width="${width}" height="${height}"><text x="50%" y="52%" text-anchor="middle" fill="white" font-size="30">SAMPLE ${index + 1}</text></svg>`);
    const body = await sharp({ create: { width, height, channels: 3, background } }).composite([{ input: svg }]).png().toBuffer();
    const original = await storage.put({ key: objectKey(`history-preview/${id}.png`), body, contentType: "image/png" });
    await db.insert(schema.mediaObject).values({ id, ownerId: owner!.id, objectKey: original.key, kind: "image", contentType: original.contentType, sizeBytes: original.sizeBytes, etag: original.etag });
    return { mediaId: id, kind: "image", contentType: original.contentType, sizeBytes: original.sizeBytes, etag: original.etag };
}));
const taskSeed = { ownerId: owner!.id, modelId: executable!.id, inputSnapshot: {}, parameterSnapshot: {}, requestId: "history-preview" };
await db.insert(schema.generationTask).values([{ ...taskSeed, id: taskId, idempotencyKey: taskId, executionStatus: "succeeded", deliveryStatus: "saved",
    inputSnapshot: { prompt: "Isolated saved sample" }, parameterSnapshot: { protocol: "openai-image-v1", size: "1536x864", quality: "medium", n: 2, output_format: "png" },
    priceVersion: 1, quotedUnits: 14, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7 },
    { ...taskSeed, id: olderTaskId, idempotencyKey: olderTaskId, modelId: "archived-preview-model", createdAt: new Date(0) },
    ...Array.from({ length: 50 }, (_, index) => ({ ...taskSeed, id: crypto.randomUUID(), idempotencyKey: `seed-${index}`, createdAt: new Date(1_000 + index) }))]);
await db.insert(schema.generationResult).values({ id: crypto.randomUUID(), ownerId: owner!.id, taskId, status: "succeeded", consumedUnits: images.length,
    resultSnapshot: { kind: "image", media: images[0]!, imageMedia: images } });

const deliver = createGenerationDelivery({ database: db, storage, quotaBytes, maxBytes });
const settleBilling = createGenerationWalletSettlement(db, { verifyImageSpecDelivery: createGenerationImageSpecMediaVerifier({ database: db, storage, maxBytes }) });
const completions: string[] = [], failures: string[] = [];
let generationPosts = 0, quotePosts = 0;
const provider = createGenerationProvider({ database: db, authSecret: secret, imageMaxBytes: maxBytes.image, gateway: {
    async request(request) {
        if (!creative || request.target.providerId !== providerId || request.path !== "images/generations") throw new Error("Fixture provider only");
        const { size, quality, n, prompt } = request.body as { size: string; quality: string; n: number; prompt: string };
        const [width, height] = size.split("x").map(Number);
        if (prompt.startsWith("慢轮")) await Bun.sleep(2600);
        const data = await Promise.all(Array.from({ length: n }, async (_, index) => {
            const color = prompt.startsWith("慢轮") ? "#568a70" : "#426c9c";
            const label = Buffer.from(`<svg width="${width}" height="${height}"><text x="50%" y="50%" text-anchor="middle" fill="white" font-size="50">PREVIEW ${index + 1}</text></svg>`);
            const image = await sharp({ create: { width, height, channels: 3, background: color } }).composite([{ input: label }]).png().toBuffer();
            return { b64_json: image.toString("base64") };
        }));
        return { status: "succeeded", upstreamStatus: 200, payload: { data, size, quality, output_format: "png" } };
    },
} });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname;
    if (request.method === "GET" && path === "/__preview/start") {
        const headers = new Headers({ location: url.searchParams.get("view") === "canvas" ? "/canvas" : creative ? "/create?mode=image" : "/generation/history", "cache-control": "no-store" });
        for (const value of cookies) headers.append("set-cookie", value);
        return new Response(null, { status: 302, headers });
    }
    if (request.method === "GET" && path === "/__preview/evidence") return Response.json({ taskId, olderTaskId, images, generationPosts, quotePosts, completions, failures });
    if (request.method === "POST" && path === "/api/v1/generation/tasks") generationPosts++;
    if (request.method === "POST" && path === "/api/v1/generation/quote") quotePosts++;
    const submission = creative && request.method === "POST" && path === "/api/v1/generation/tasks";
    const allowed = request.method === "GET" && path.startsWith("/api/") || request.method === "POST" &&
        ["/api/v1/media/resolve", "/api/v1/generation/quote", "/api/v1/generation/tasks/batch"].includes(path) ||
        submission || request.method === "PUT" && /^\/api\/v1\/generation\/logs\/[^/]+\/title$/.test(path);
    if (!allowed) return Response.json({ error: { code: "preview_write_disabled" } }, { status: 405 });
    const response = await app(new Request(origin + path + url.search, { method: request.method, headers: request.headers,
        ...(request.method === "GET" ? {} : { body: await request.arrayBuffer() }) }), "127.0.0.1");
    if (submission && response.status === 201) {
        const { task } = await response.clone().json();
        const job = jobs.get(task.id);
        if (job) {
            jobs.delete(task.id);
            void processGenerationJob(db, job, { deliver, settleBilling, provider }).then(result => {
                (result.task.executionStatus === "succeeded" ? completions : failures).push(task.id);
            }, () => failures.push(task.id));
        }
    }
    return response;
} });
console.log(JSON.stringify({ port: server.port }));
