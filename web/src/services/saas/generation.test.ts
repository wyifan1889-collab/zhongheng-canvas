import { expect, test } from "bun:test";
import { createGenerationClient, GenerationError, type GenerationQuote, type GenerationScope } from "./generation";

const taskId = "11111111-1111-4111-8111-111111111111";
const scope: GenerationScope = { accountId: "synthetic-account", epoch: 2, projectId: "synthetic-canvas" };
const intent = { modelId: "synthetic-image", input: { prompt: "synthetic prompt" }, parameters: {}, projectId: scope.projectId };
const quote: GenerationQuote = { modelId: intent.modelId, priceVersion: 3, quotedUnits: 7, billingUnit: "request", creditsPerUnit: 7 };
const view = () => ({ task: { id: taskId, projectId: scope.projectId, modelId: intent.modelId, priceVersion: 3, quotedUnits: 7, executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured", ownerId: "private-owner" },
    result: { taskId, status: "succeeded", resultSnapshot: { kind: "image", image: { base64: "must-not-escape" }, media: { mediaId: taskId, kind: "image", contentType: "image/png", sizeBytes: 232, etag: "synthetic-etag", url: "https://must-not-escape.invalid" } } } });
const fetcher = (run: (path: string, init?: RequestInit) => Promise<Response>): typeof fetch => Object.assign((input: RequestInfo | URL, init?: RequestInit) => run(String(input), init), { preconnect: fetch.preconnect });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

test("generation client binds all requests to the original account, projects only public fields, and uses GET for recovery", async () => {
    const calls: { path: string; init?: RequestInit }[] = [];
    const client = createGenerationClient({ scope, getScope: () => scope, fetcher: fetcher(async (path, init) => {
        calls.push({ path, init });
        return Response.json(path.endsWith("/models") ? { items: [{ id: intent.modelId, displayName: "Synthetic", capability: "image", group: null }] } : path.endsWith("/quote") ? { quote } : view());
    }) });
    expect(await client.models()).toEqual([{ id: intent.modelId, displayName: "Synthetic", capability: "image", group: null }]);
    expect(await client.quote(intent)).toEqual(quote);
    const submitted = await client.submit(intent, 3, "synthetic-request");
    expect(submitted.result?.resultSnapshot.media?.mediaId).toBe(taskId);
    expect(JSON.stringify(submitted)).not.toContain("must-not-escape");
    expect(JSON.stringify(submitted)).not.toContain("private-owner");
    await client.get(taskId);
    await client.getByKey("synthetic-request");
    expect(calls.map((call) => call.init?.method)).toEqual(["GET", "POST", "POST", "GET", "GET"]);
    for (const call of calls) {
        expect(new Headers(call.init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
        expect(call.init).toMatchObject({ credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
    }
    expect(JSON.parse(calls[2].init!.body as string)).toEqual({ ...intent, confirmedPriceVersion: 3 });
    expect(new Headers(calls[2].init?.headers).get("Idempotency-Key")).toBe("synthetic-request");
    expect(calls[4].path).toBe("/api/v1/generation/tasks/by-key/synthetic-request");
});

test("generation model groups expose only public display metadata and reject invalid group contracts", async () => {
    const group = { id: taskId, name: "图片分组", order: 2 };
    let items: unknown[] = [{ id: intent.modelId, displayName: "Synthetic", capability: "image", group: { ...group, providerKey: "private-key" }, cost: 0.1 }];
    const calls: string[] = [];
    const client = createGenerationClient({ scope, getScope: () => scope, fetcher: fetcher(async path => { calls.push(path); return Response.json({ items }); }) });
    expect(await client.models()).toEqual([{ id: intent.modelId, displayName: "Synthetic", capability: "image", group }]);
    for (const invalidGroup of [undefined, { ...group, id: "invalid" }, { ...group, name: " " }, { ...group, order: -1 }, { ...group, order: 1.5 }]) {
        items = [{ id: intent.modelId, displayName: "Synthetic", capability: "image", group: invalidGroup }];
        await expect(client.models()).rejects.toMatchObject({ code: "unconfirmed", outcome: "not-sent" });
    }
    expect(calls.every(path => path === "/api/v1/generation/models")).toBe(true);
});

for (const change of ["account", "epoch", "project"] as const) test(`late response JSON is rejected after ${change} changes, including same-account permissions`, async () => {
    let current: GenerationScope = { ...scope };
    const body = deferred<unknown>(), started = deferred<void>();
    let calls = 0;
    const client = createGenerationClient({ scope, getScope: () => current, fetcher: fetcher(async () => {
        calls++;
        const response = Response.json({});
        response.json = () => { started.resolve(); return body.promise; };
        return response;
    }) });
    const outcome = client.submit(intent, 3, "synthetic-request").catch((error: unknown) => error);
    await started.promise;
    current = { ...scope, ...(change === "account" ? { accountId: "other-account" } : change === "epoch" ? { epoch: scope.epoch + 1 } : { projectId: "other-canvas" }) };
    body.resolve(view());
    expect(await outcome).toMatchObject({ code: "context_changed", outcome: "unknown" });
    current = { ...scope };
    await expect(client.get(taskId)).rejects.toMatchObject({ code: "context_changed", outcome: "not-sent" });
    expect(calls).toBe(1);
});

test("only explicit server rejections are definite; network, malformed 2xx, proxy errors, and key conflicts remain unknown without retries", async () => {
    const cases: [() => Promise<Response>, string, string][] = [
        [async () => Response.json({ error: { code: "price_changed", message: "private" } }, { status: 409 }), "price_changed", "rejected"],
        [async () => Response.json({ error: { code: "generation_unavailable" } }, { status: 503 }), "generation_unavailable", "rejected"],
        [async () => Response.json({ error: { code: "idempotency_conflict" } }, { status: 409 }), "idempotency_conflict", "unknown"],
        [async () => { throw new Error("private network data"); }, "unconfirmed", "unknown"],
        [async () => new Response("upstream private", { status: 502 }), "unconfirmed", "unknown"],
        [async () => Response.json({}), "unconfirmed", "unknown"],
        [async () => Response.json({ ...view(), task: { ...view().task, projectId: "wrong-project" } }), "unconfirmed", "unknown"],
    ];
    for (const [respond, code, outcome] of cases) {
        let calls = 0;
        const client = createGenerationClient({ scope, getScope: () => scope, fetcher: fetcher(async () => { calls++; return respond(); }) });
        const error = await client.submit(intent, 3, "synthetic-request").catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(GenerationError);
        expect(error).toMatchObject({ code, outcome });
        expect(String(error)).not.toContain("private");
        expect(calls).toBe(1);
    }
});

test("invalid intent never leaves the browser and stable same-owner scope remains usable", async () => {
    let calls = 0;
    const client = createGenerationClient({ scope, getScope: () => ({ ...scope }), fetcher: fetcher(async () => { calls++; return Response.json({ quote }); }) });
    await expect(client.quote({ ...intent, projectId: "other" })).rejects.toMatchObject({ outcome: "not-sent" });
    await expect(client.submit(intent, 0, "synthetic-request")).rejects.toMatchObject({ outcome: "not-sent" });
    expect(calls).toBe(0);
    expect(await client.quote(intent)).toEqual(quote);
    expect(calls).toBe(1);
});

test("single-image quote exposes only the explicit public price note and rejects inconsistent totals", async () => {
    const publicNote = "按次收费，每次生成 1 张图片。\n此处为管理员配置的公开说明。";
    const clientFor = (value: unknown) => createGenerationClient({ scope, getScope: () => scope, fetcher: fetcher(async () => Response.json({ quote: value })) });
    expect(await clientFor({ ...quote, priceNote: publicNote, cost: "private-cost", binding: { endpoint: "private-endpoint" }, rules: { cost: "private-rules" }, draftNote: "private-note" }).quote(intent))
        .toEqual({ ...quote, priceNote: publicNote });
    for (const invalidQuote of [{ ...quote, quotedUnits: 14 }, { ...quote, priceNote: { cost: "private" } }, { ...quote, priceNote: null }]) {
        await expect(clientFor(invalidQuote).quote(intent)).rejects.toMatchObject({ code: "unconfirmed", outcome: "not-sent" });
    }
});
