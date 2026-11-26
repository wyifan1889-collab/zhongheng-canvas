import { expect, test } from "bun:test";
import { createGenerationClient, type GenerationImagePricing, type GenerationIntent, type GenerationModel, type GenerationQuote, type GenerationScope } from "./generation";

const scope: GenerationScope = { accountId: "spec-account", epoch: 2, projectId: "spec-project" };
const taskId = "11111111-1111-4111-8111-111111111111", fingerprint = "a".repeat(64);
const parameters = { size: "1536x1024", quality: "high" as const };
const pricing = (): GenerationImagePricing => ({ protocol: "openai-image-v1", priceVersion: 3, billingUnit: "image_specs", creditsPerUnit: null, imageSpecs: [
    { parameters: { size: "1024x1024", quality: "low" }, creditsPerRequest: 7 }, { parameters: { ...parameters }, creditsPerRequest: 13 },
], priceNote: "合成规格价" });
const model = (): GenerationModel => ({ id: "spec-image", displayName: "规格图片", capability: "image", group: null, imagePricing: pricing() });
const intent = (): GenerationIntent => ({ modelId: "spec-image", input: { prompt: "  保留原始要求与空白  " }, parameters: { ...parameters }, projectId: scope.projectId, nodeId: "source-A" });
const quote = (): GenerationQuote => ({ modelId: "spec-image", priceVersion: 3, quotedUnits: 13, billingUnit: "request", creditsPerUnit: 13,
    imageSpec: { protocol: "openai-image-v1", parameters: { ...parameters } }, quoteFingerprint: fingerprint });
const view = () => ({ task: { id: taskId, projectId: scope.projectId, nodeId: "source-A", modelId: "spec-image", priceVersion: 3, quotedUnits: 13,
    imageSpecSnapshot: { status: "recorded", protocol: "openai-image-v1", parameters: { ...parameters } }, executionStatus: "queued", deliveryStatus: "pending", billingStatus: "reserved" }, result: null });
function fixture(run?: (path: string, init?: RequestInit) => Promise<Response>) {
    const calls: { path: string; init?: RequestInit }[] = [];
    const fetcher: typeof fetch = Object.assign(async (value: RequestInfo | URL, init?: RequestInit) => {
        const path = String(value); calls.push({ path, init });
        return run ? run(path, init) : Response.json(path.endsWith("/models") ? { items: [model()] } : path.endsWith("/quote") ? { quote: quote() } : view());
    }, { preconnect: fetch.preconnect });
    return { calls, client: createGenerationClient({ scope, getScope: () => scope, fetcher }) };
}

test("unsupported or missing protocols cannot be presented as compatible image prices, confirmations or history", async () => {
    for (const protocol of [undefined, null, "gemini", "grok", 1]) {
        const catalog = fixture(async () => Response.json({ items: [{ ...model(), imagePricing: { ...pricing(), protocol } }] }));
        await expect(catalog.client.models()).rejects.toMatchObject({ outcome: "not-sent" });
        const confirmation = fixture(async path => Response.json(path.endsWith("/models") ? { items: [model()] }
            : { quote: { ...quote(), imageSpec: { ...quote().imageSpec, protocol } } }));
        await confirmation.client.models();
        await expect(confirmation.client.quote(intent())).rejects.toMatchObject({ outcome: "not-sent" });
        expect(confirmation.calls.some(call => call.path.endsWith("/tasks"))).toBe(false);
        const history = fixture(async () => Response.json({ ...view(), task: { ...view().task,
            imageSpecSnapshot: { ...view().task.imageSpecSnapshot, protocol } } }));
        await expect(history.client.get(taskId)).rejects.toMatchObject({ outcome: "not-sent" });
    }
});

test("I3b executable image catalog preserves its complete same-version specifications and strips private fields", async () => {
    const f = fixture(async () => Response.json({ items: [{ ...model(), credential: "private-key", imagePricing: { ...pricing(), binding: "private-source" } },
        { id: "legacy-image", displayName: "旧按次", capability: "image", group: null }] }));
    expect(await f.client.models()).toEqual([model(), { id: "legacy-image", displayName: "旧按次", capability: "image", group: null }]);
    expect(f.calls).toHaveLength(1);
});

test("the catalog and quote must agree on the original per-request count limit", async () => {
    const parameters = { ...intent().parameters, n: 10 }, selected = { ...intent(), parameters };
    const batchQuote = { ...quote(), quotedUnits: 130, imageSpec: { protocol: "openai-image-v1", parameters, maxImagesPerRequest: 4 } };
    const f = fixture(async path => Response.json(path.endsWith("/models") ? { items: [{ ...model(), maxImages: 10, maxImagesPerRequest: 4 }] } : { quote: batchQuote }));
    expect((await f.client.models())[0]).toMatchObject({ maxImages: 10, maxImagesPerRequest: 4 });
    expect(await f.client.quote(selected)).toEqual(batchQuote);
    for (const limit of [undefined, 5, 0, 11, "4", null]) {
        const bad = fixture(async path => Response.json(path.endsWith("/models") ? { items: [{ ...model(), maxImages: 10, maxImagesPerRequest: 4 }] }
            : { quote: { ...batchQuote, imageSpec: { protocol: "openai-image-v1", parameters, maxImagesPerRequest: limit } } }));
        await bad.client.models(); await expect(bad.client.quote(selected)).rejects.toMatchObject({ outcome: "not-sent" });
    }
    for (const limit of [0, 11, 1.5, "4", null]) {
        const bad = fixture(async () => Response.json({ items: [{ ...model(), maxImages: 10, maxImagesPerRequest: limit }] }));
        await expect(bad.client.models()).rejects.toMatchObject({ outcome: "not-sent" });
    }
});

test("I3b catalog rejects any malformed, overlapping or duplicate specification instead of selecting a subset", async () => {
    for (const imagePricing of [null, { ...pricing(), priceVersion: 0 }, { ...pricing(), creditsPerUnit: 7 }, { ...pricing(), imageSpecs: [] },
        { ...pricing(), imageSpecs: [{ parameters: {}, creditsPerRequest: 7 }] },
        { ...pricing(), imageSpecs: [{ parameters: { size: "auto" }, creditsPerRequest: 7 }] },
        { ...pricing(), imageSpecs: [{ parameters, creditsPerRequest: 0 }] },
        { ...pricing(), imageSpecs: [{ parameters, creditsPerRequest: 13, private: true }] },
        { ...pricing(), imageSpecs: [{ parameters, creditsPerRequest: 13 }, { parameters: { quality: "high", size: "1536x1024" }, creditsPerRequest: 14 }] },
        { ...pricing(), imageSpecs: [{ parameters: { size: "1536x1024" }, creditsPerRequest: 7 }, { parameters, creditsPerRequest: 13 }] },
    ]) {
        const f = fixture(async () => Response.json({ items: [model(), { ...model(), id: "bad-image", imagePricing }] }));
        await expect(f.client.models()).rejects.toMatchObject({ outcome: "not-sent" });
        await expect(f.client.quote(intent())).rejects.toMatchObject({ code: "catalog_changed", outcome: "not-sent" });
        expect(f.calls).toHaveLength(1);
    }
});

test("I3b spec quote requires the active catalog's exact combination, version and single-request amount", async () => {
    const f = fixture();
    await expect(f.client.quote(intent())).rejects.toMatchObject({ code: "catalog_changed" }); expect(f.calls).toHaveLength(0);
    const models = await f.client.models(); models[0].imagePricing!.imageSpecs[1].creditsPerRequest = 99;
    expect(await f.client.quote(intent())).toEqual(quote());
    expect(await f.client.quote({ ...intent(), parameters: { ...parameters, n: 1 } })).toEqual(quote());
    for (const selection of [{}, { size: "1536x1024" }, { size: "1024x1024", quality: "high" }, { ...parameters, n: 11 }, { ...parameters, n: 2 }]) {
        await expect(f.client.quote({ ...intent(), parameters: selection as GenerationIntent["parameters"] })).rejects.toMatchObject({ outcome: "not-sent" });
    }
    for (const patch of [{ priceVersion: 4 }, { quotedUnits: 14, creditsPerUnit: 14 }, { imageSpec: { parameters: { ...parameters, quality: "low" } } },
        { imageSpec: { parameters: { size: "1536x1024" } } }, { imageSpec: { parameters, private: true } }, { imageSpec: undefined },
        { quoteFingerprint: undefined }, { quoteFingerprint: "A".repeat(64) }, { quoteFingerprint: "a".repeat(63) }]) {
        const bad = fixture(async path => Response.json(path.endsWith("/models") ? { items: [model()] } : { quote: { ...quote(), ...patch } }));
        await bad.client.models(); await expect(bad.client.quote(intent())).rejects.toMatchObject({ outcome: "not-sent" });
        expect(bad.calls.filter(call => call.path.endsWith("/tasks"))).toHaveLength(0);
    }
});

test("I3b submit forwards the exact confirmed parameters, original node and lowercase fingerprint and checks owner node/spec", async () => {
    const f = fixture(); await f.client.models(); await f.client.quote(intent());
    expect((await f.client.submit(intent(), 3, "spec-key", fingerprint)).task.nodeId).toBe("source-A");
    const post = f.calls.find(call => call.path.endsWith("/tasks"))!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ ...intent(), confirmedPriceVersion: 3, confirmedQuoteFingerprint: fingerprint });
    for (const value of [undefined, "A".repeat(64), "short"]) await expect(f.client.submit(intent(), 3, "other-key", value)).rejects.toMatchObject({ outcome: "not-sent" });
    expect(f.calls.filter(call => call.path.endsWith("/tasks"))).toHaveLength(1);
    for (const patch of [{ nodeId: "other-node" }, { nodeId: null }, { nodeId: undefined }, { imageSpecSnapshot: { status: "invalid" } },
        { imageSpecSnapshot: { status: "recorded", parameters: { size: "1024x1024", quality: "low" } } }]) {
        const bad = fixture(async () => Response.json({ ...view(), task: { ...view().task, ...patch } }));
        await expect(bad.client.submit(intent(), 3, "spec-key", fingerprint)).rejects.toMatchObject({ outcome: "unknown" });
    }
});

test("I3b legacy empty parameters need no catalog or fingerprint while owner recovery never consults current prices", async () => {
    const legacy = { modelId: "legacy-image", input: { prompt: "旧单张要求" }, parameters: {}, projectId: scope.projectId };
    const legacyQuote: GenerationQuote = { modelId: legacy.modelId, priceVersion: 1, quotedUnits: 7, billingUnit: "request", creditsPerUnit: 7 };
    const f = fixture(async path => Response.json(path.endsWith("/quote") ? { quote: legacyQuote } : { ...view(), task: {
        ...view().task, modelId: legacy.modelId, priceVersion: 1, quotedUnits: 7, nodeId: null, imageSpecSnapshot: undefined } }));
    expect(await f.client.quote(legacy)).toEqual(legacyQuote); await f.client.submit(legacy, 1, "legacy-key");
    expect(JSON.parse(String(f.calls[1].init?.body))).toEqual({ ...legacy, confirmedPriceVersion: 1 });
    await expect(f.client.submit(legacy, 1, "legacy-key", fingerprint)).rejects.toMatchObject({ outcome: "not-sent" });
    const history = fixture(async () => Response.json(view())); await history.client.get(taskId); await history.client.getByKey("old-spec-key");
    expect(history.calls.map(call => call.init?.method)).toEqual(["GET", "GET"]);
});
