import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { GenerationJobPayload } from "@infinite-canvas/jobs";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { wallet } from "@infinite-canvas/database/schema";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { createCanvasImageGenerationController, createGenerationReceiptStore, type GenerationReceipt, type GenerationReceiptBacking } from "../../../web/src/services/saas/canvas-image-generation";
import { createGenerationClient, type GenerationScope } from "../../../web/src/services/saas/generation";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createGenerationProvider } from "../src/generation-provider";
import { createGenerationWalletSettlement, processGenerationJob } from "../src/generation-worker";
import { createProviderGateway } from "../src/provider-gateway";
import { createTestDatabase } from "./database";
import { seedGenerationPricing } from "./generation-fixtures";

const origin = "http://localhost:4000";
const secret = "synthetic-failure-http-" + crypto.randomUUID();
const credential = "synthetic-provider-credential";
const modelId = "image-failure-http";
const mails: Array<{ to: string; url: string }> = [];
const queued: GenerationJobPayload[] = [];
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;

function request(path: string, identity?: { id: string; cookie: string }, body?: object) {
    return app(new Request(new URL(path, origin), {
        method: body === undefined ? "GET" : "POST",
        headers: {
            origin, "content-type": "application/json", "x-captcha-response": "synthetic-pass",
            ...(identity ? { cookie: identity.cookie, "x-canvas-account-id": identity.id } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), "198.51.100.83");
}

async function register(status: number) {
    const email = `failure-${status}-${crypto.randomUUID()}@example.test`, password = "synthetic-failure-http-password";
    expect((await request("/api/auth/sign-up/email", undefined, { name: `Failure ${status}`, email, password })).status).toBe(200);
    const verification = mails.find((mail) => mail.to === email);
    expect(verification).toBeDefined();
    expect((await request(verification!.url)).status).toBe(302);
    const login = await request("/api/auth/sign-in/email", undefined, { email, password });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
    const session = await request("/api/v1/session", { id: "", cookie });
    expect(session.status).toBe(200);
    return { id: (await session.json()).user.id as string, cookie };
}

beforeAll(async () => {
    if (process.env.SAAS_TEST_DATABASE_URL) throw new Error("Failure recovery tests require in-memory PGlite only");
    database = await createTestDatabase();
    await seedGenerationPricing(database.db, [{ modelId, capability: "image", version: 1, billingUnit: "request", creditsPerUnit: 7 }]);
    await saveProviderCredential(database.db, secret, "generation-test-provider", credential);
    app = createApp(createAccountApi({
        database: database.db, origin,
        auth: { secret, sendVerificationEmail: async (mail) => { mails.push(mail); } },
        rates: createRateStore(database.pool, secret),
        verifyHuman: async (input) => input.headers.get("x-captcha-response") === "synthetic-pass",
        generation: { enabled: true, queue: { async send(name, payload, options) {
            expect(name).toBe("generation");
            expect(options?.db).toBeDefined();
            queued.push(structuredClone(payload));
            return crypto.randomUUID();
        } } },
        onFault: () => {},
    }), "synthetic-site-key", false, false, undefined, { image: true });
});

afterAll(async () => { await database?.close(); });

describe("authenticated generation failure and read-only receipt recovery", () => {
    for (const upstreamStatus of [401, 504] as const) {
        test(upstreamStatus === 401
            ? "explicit upstream 401 releases once without capture or repeat execution"
            : "upstream 504 retains the reservation after a lost accepted response and by-key recovery", async () => {
            const identity = await register(upstreamStatus);
            await database.db.insert(wallet).values({ userId: identity.id, availableUnits: "20" });
            const scope: GenerationScope = { accountId: identity.id, epoch: 1, projectId: `failure-canvas-${upstreamStatus}` };
            const idempotencyKey = `failure-http-${upstreamStatus}-${crypto.randomUUID()}`;
            const saved = new Map<string, GenerationReceipt>();
            // Recreated backing adapters share bytes, without pretending to test browser IndexedDB.
            const backing = (): GenerationReceiptBacking => ({
                keys: async () => [...saved.keys()],
                getItem: async (key) => structuredClone(saved.get(key) ?? null),
                setItem: async (key, value) => { saved.set(key, structuredClone(value)); },
            });
            const paths: string[] = [];
            let submitted = 0, upstreamCalls = 0, delivered = 0;
            const fetcher: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = new URL(String(input), origin);
                expect(url.origin).toBe(origin);
                paths.push(`${init?.method ?? "GET"} ${url.pathname}`);
                const headers = new Headers(init?.headers);
                headers.set("origin", origin);
                headers.set("cookie", identity.cookie);
                const response = await app(new Request(url, { ...init, headers }), "198.51.100.83");
                if (url.pathname === "/api/v1/generation/tasks" && init?.method === "POST") {
                    submitted++;
                    expect(response.status).toBe(201);
                    if (upstreamStatus === 504) {
                        // The real handler has committed task/reservation/queue; only client delivery is lost.
                        expect((await response.json()).created).toBe(true);
                        throw new TypeError("synthetic client response loss after acceptance");
                    }
                }
                return response;
            }, { preconnect: fetch.preconnect });
            const makeController = () => createCanvasImageGenerationController({
                client: createGenerationClient({ scope, getScope: () => scope, fetcher }),
                getContext: () => scope,
                receiptStore: createGenerationReceiptStore(backing()),
                createIdempotencyKey: () => idempotencyKey,
            });
            const first = makeController();
            let current = first;
            try {
                await first.prepare({ modelId, prompt: "synthetic failure-only image request" });
                expect(first.getState()).toMatchObject({ phase: "ready", quote: { priceVersion: 1, quotedUnits: 7, creditsPerUnit: 7 } });
                await first.confirm();
                expect(first.getState().phase).toBe(upstreamStatus === 504 ? "uncertain" : "tracking");
                await first.confirm();
                expect(submitted).toBe(1);
                const jobs = queued.filter((item) => item.ownerId === identity.id);
                expect(jobs).toHaveLength(1);
                const payload = jobs[0]!;
                const wallets = createWalletRepository(database.db);
                expect(await wallets.get(identity.id)).toMatchObject({ availableUnits: "13", reservedUnits: "7" });

                if (upstreamStatus === 504) {
                    first.close();
                    current = makeController();
                    const receipts = await current.listReceipts();
                    expect(receipts).toEqual([{ accountId: identity.id, projectId: scope.projectId, idempotencyKey, priceVersion: 1 }]);
                    await current.restoreReceipt(receipts[0]!);
                    expect(paths).toContain(`GET /api/v1/generation/tasks/by-key/${idempotencyKey}`);
                    expect(current.getState()).toMatchObject({ phase: "tracking", view: { task: { id: payload.taskId, executionStatus: "queued", billingStatus: "reserved" } } });
                }

                const gateway = createProviderGateway(async (input, init) => {
                    upstreamCalls++;
                    expect(String(input)).toBe("https://provider.invalid/v1/images/generations");
                    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${credential}`);
                    return new Response("synthetic upstream details must stay private", { status: upstreamStatus });
                }, async () => ["93.184.216.34"]);
                const dependencies = {
                    // Failure responses never decode an image; this synthetic limit is not a runtime default.
                    provider: createGenerationProvider({ database: database.db, authSecret: secret, imageMaxBytes: 1, gateway }),
                    deliver: async () => { delivered++; return { status: "visible" as const }; },
                    settleBilling: createGenerationWalletSettlement(database.db),
                };
                const processed = await processGenerationJob(database.db, payload, dependencies);
                const expectedStatus = upstreamStatus === 504 ? "unknown" : "failed";
                const expectedBilling = upstreamStatus === 504 ? "pending_review" : "released";
                expect(processed.task).toMatchObject({ executionStatus: expectedStatus, deliveryStatus: expectedStatus, billingStatus: expectedBilling });
                expect(processed.result).toMatchObject({ status: expectedStatus, errorCode: upstreamStatus === 504 ? "provider_response_unknown" : "provider_rejected" });
                await current.refresh();
                expect(current.getState()).toMatchObject({ phase: "tracking", view: { task: { id: payload.taskId, executionStatus: expectedStatus, billingStatus: expectedBilling }, result: { status: expectedStatus, resultSnapshot: {} } } });
                const walletResponse = await request("/api/v1/wallet", identity);
                expect(walletResponse.status).toBe(200);
                const walletBeforeReplay = (await walletResponse.json()).wallet;
                expect(walletBeforeReplay).toMatchObject({ availableUnits: upstreamStatus === 504 ? "13" : "20", reservedUnits: upstreamStatus === 504 ? "7" : "0", totalUnits: "20" });
                const ledger = await wallets.listLedger(identity.id);
                expect(ledger.filter((row) => row.kind === "reserve")).toHaveLength(1);
                expect(ledger.filter((row) => row.kind === "release")).toHaveLength(upstreamStatus === 504 ? 0 : 1);
                expect(ledger.filter((row) => row.kind === "capture")).toHaveLength(0);
                expect(ledger.every((row) => row.referenceId === payload.taskId)).toBe(true);
                const viewBeforeReplay = current.getState().view;
                for (const hidden of [credential, "provider.invalid", "synthetic upstream details", "base64"]) expect(JSON.stringify(viewBeforeReplay)).not.toContain(hidden);

                expect((await processGenerationJob(database.db, payload, dependencies)).replay).toBe(true);
                await current.refresh();
                await current.confirm();
                expect(current.getState().view).toEqual(viewBeforeReplay);
                expect(await wallets.get(identity.id)).toEqual(walletBeforeReplay);
                expect(await wallets.listLedger(identity.id)).toEqual(ledger);
                expect(submitted).toBe(1);
                expect(queued.filter((item) => item.ownerId === identity.id)).toHaveLength(1);
                expect(upstreamCalls).toBe(1);
                expect(delivered).toBe(0);
                expect(paths.filter((path) => path === `GET /api/v1/generation/tasks/${payload.taskId}`)).toHaveLength(2);
            } finally {
                current.close();
                first.close();
            }
        });
    }
});
