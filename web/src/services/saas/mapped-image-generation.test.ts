import { expect, test } from "bun:test";
import { chooseImageMapping, createMappedImageGenerationClient, imageMappingAspectRatio, imageMappingChoiceKey, selectedImageMapping } from "./mapped-image-generation";
import { parsePublishedMappingCatalog, type PublishedMappingCatalog } from "./model-mapping-catalog";
import { createCanvasImageGenerationController } from "./canvas-image-generation";
import type { GenerationIntent, GenerationModel, GenerationScope, GenerationQuote } from "./generation";

const scope: GenerationScope = { accountId: "account", epoch: 1, projectId: "canvas" };
const parameters = { size: "1024x1024", quality: "high" } as const;
const combination = { specification: "1K", execution: { protocol: "openai-image-v1", parameters }, credits: 9, available: true, nodeModelId: "channel-a-image", priceVersion: 2 } as const;
const catalog = (): PublishedMappingCatalog => ({ version: 1, models: [{ id: "image-2.5", displayName: "Image 2.5", capability: "image", group: "GPT 图片", specifications: ["1K", "2K", "4K", "8K"], combinations: [structuredClone(combination)] }] });
const node = (): GenerationModel => ({ id: combination.nodeModelId, displayName: "渠道型号", capability: "image", group: null, imagePricing: {
    billingUnit: "image_specs", creditsPerUnit: null, protocol: "openai-image-v1", priceVersion: 2, imageSpecs: [{ parameters, creditsPerRequest: 9 }],
} });
const intent: GenerationIntent = { modelId: combination.nodeModelId, input: { prompt: "保留原描述" }, parameters, projectId: scope.projectId };
const quote = { modelId: intent.modelId, priceVersion: 2, quotedUnits: 9, creditsPerUnit: 9, billingUnit: "request", imageSpec: { protocol: "openai-image-v1", parameters }, quoteFingerprint: "a".repeat(64) };
function fixture() {
    let current: GenerationScope | null = scope;
    const data = { mapping: catalog() as unknown, nodes: [node()], quote: structuredClone(quote) as GenerationQuote, failMapping: false };
    const calls: { path: string; init?: RequestInit }[] = [];
    let gate: (() => Promise<void>) | undefined;
    const client = createMappedImageGenerationClient({ scope, getScope: () => current, fetcher: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input); calls.push({ path, init }); await gate?.();
        if (path.endsWith("model-mapping-catalog")) {
            if (data.failMapping) throw new Error("offline");
            return Response.json({ catalog: data.mapping });
        }
        if (path.endsWith("models")) return Response.json({ items: data.nodes });
        if (path.endsWith("quote")) return Response.json({ quote: data.quote });
        return Response.json({ task: { id: "11111111-1111-4111-8111-111111111111", projectId: scope.projectId, modelId: intent.modelId,
            priceVersion: 2, quotedUnits: 9, imageSpecSnapshot: { status: "recorded", protocol: "openai-image-v1", parameters }, executionStatus: "queued", deliveryStatus: "pending", billingStatus: "reserved" }, result: null });
    }, { preconnect: fetch.preconnect }) });
    return { client, calls, data, context: (value: GenerationScope | null) => { current = value; }, gate: (value: typeof gate) => { gate = value; } };
}

test("a four-image quote binds the published per-image route and multiplies the total", async () => {
    const f = fixture();
    f.data.nodes[0]!.maxImages = 10;
    const batch = { ...intent, parameters: { ...parameters, n: 4 } };
    f.data.quote = { ...quote, quotedUnits: 36, imageSpec: { protocol: "openai-image-v1", parameters: batch.parameters } };
    const models = await f.client.mappedModels();
    expect(models[0]!.combinations[0]!.maxImages).toBe(10);
    expect(await f.client.quote(batch)).toMatchObject({ quotedUnits: 36, creditsPerUnit: 9, imageSpec: { parameters: batch.parameters } });
    f.data.quote.quotedUnits = 9;
    await expect(f.client.quote(batch)).rejects.toThrow();
    const other = fixture(); await other.client.mappedModels();
    await expect(other.client.quote(batch)).rejects.toMatchObject({ code: "catalog_changed" });
    expect(other.calls.filter(call => call.path.endsWith("quote"))).toHaveLength(0);
});

test("split routes require the same published count limit in the executable catalog and quote", async () => {
    const f = fixture(), mapping = catalog();
    mapping.models[0]!.combinations[0]!.execution = { ...combination.execution, maxImagesPerRequest: 4 };
    f.data.mapping = mapping; f.data.nodes[0]!.maxImages = 10; f.data.nodes[0]!.maxImagesPerRequest = 4;
    const batch = { ...intent, parameters: { ...parameters, n: 10 } };
    f.data.quote = { ...quote, billingUnit: "request", quotedUnits: 90, imageSpec: { protocol: "openai-image-v1", parameters: batch.parameters, maxImagesPerRequest: 4 } };
    expect((await f.client.mappedModels())[0]!.combinations[0]).toMatchObject({ available: true, execution: { maxImagesPerRequest: 4 } });
    expect((await f.client.quote(batch)).quotedUnits).toBe(90);
    const controller = createCanvasImageGenerationController({ client: f.client, getContext: () => scope });
    await controller.prepare({ modelId: intent.modelId, prompt: intent.input.prompt, parameters: batch.parameters });
    expect(controller.getState()).toMatchObject({ phase: "ready", quote: { quotedUnits: 90, imageSpec: { maxImagesPerRequest: 4 } } });
    expect(Object.isFrozen(controller.getState().quote!.imageSpec)).toBe(true);
    controller.close();
    f.data.nodes[0]!.maxImagesPerRequest = 5;
    expect((await f.client.mappedModels())[0]!.combinations[0]!.available).toBe(false);
    await expect(f.client.quote(batch)).rejects.toMatchObject({ code: "catalog_changed" });
});

test("public parsing preserves extensible disabled labels and canonical complete parameters", () => {
    const value = catalog(), result = parsePublishedMappingCatalog(value)!;
    expect(result.models[0].specifications).toEqual(["1K", "2K", "4K", "8K"]);
    expect(result.models[0].combinations).toEqual([combination]);
    value.models[0].combinations[0].execution.parameters.size = "2048x2048";
    expect(result.models[0].combinations[0].execution.parameters.size).toBe("1024x1024");
    expect(parsePublishedMappingCatalog({ version: 0, models: [] })).toEqual({ version: 0, models: [] });
});

test("malformed, duplicated, hidden, private or ambiguous mapping data rejects the whole catalog", () => {
    const mutations = [
        (v: any) => { v.version = 0; },
        (v: any) => { v.models.push(v.models[0]); },
        (v: any) => { v.models[0].specifications.push("2K"); },
        (v: any) => { v.models[0].specifications = ["2K"]; },
        (v: any) => { v.models[0].combinations.push(combination); },
        (v: any) => { v.models[0].combinations[0].credits = "9"; },
        (v: any) => { v.models[0].combinations[0].execution.parameters = { quality: "high" }; },
        (v: any) => { v.models[0].combinations[0].available = false; },
        (v: any) => { v.models[0].combinations[0].providerModel = "private-model"; },
        (v: any) => { v.models.push({ ...v.models[0], id: "other-family" }); },
    ];
    for (const mutate of mutations) { const value = catalog(); mutate(value); expect(parsePublishedMappingCatalog(value)).toBeNull(); }
});

test("canvas shows a single family, keeps reserved 2K, and quotes only the explicit executable route", async () => {
    const f = fixture(), models = await f.client.mappedModels();
    expect(models.map(item => item.displayName)).toEqual(["Image 2.5"]);
    expect(models[0].specifications).toContain("2K");
    expect(models[0].combinations.some(item => item.specification === "2K" && item.available)).toBe(false);
    const key = imageMappingChoiceKey(models[0].combinations[0]);
    expect(key).not.toContain("channel");
    models[0].combinations[0].credits = 99;
    expect(await f.client.quote(intent)).toEqual(quote);
    expect(JSON.parse(String(f.calls.at(-1)!.init!.body))).toEqual(intent);
    expect(f.calls.every(call => new Headers(call.init?.headers).get("x-canvas-account-id") === "account")).toBe(true);
    await expect(f.client.quote({ ...intent, modelId: "image-2.5" })).rejects.toMatchObject({ code: "catalog_changed" });
    await expect(f.client.quote({ ...intent, parameters: { size: "2048x2048", quality: "high" } })).rejects.toMatchObject({ code: "catalog_changed" });
    expect(f.calls.filter(call => call.path.endsWith("quote"))).toHaveLength(1);
});

test("node selection requires the same published model, clarity and complete combination", async () => {
    const f = fixture(), models = await f.client.mappedModels();
    const selection = { modelId: models[0].id, specification: "1K", combination: imageMappingChoiceKey(models[0].combinations[0]) };
    expect(selectedImageMapping(models, selection)).toMatchObject({ nodeModelId: intent.modelId, priceVersion: 2, credits: 9 });
    for (const value of [undefined, {}, { ...selection, modelId: "removed" }, { ...selection, specification: "2K" }, { ...selection, combination: "stale" }]) {
        expect(selectedImageMapping(models, value)).toBeUndefined();
    }
    models[0].combinations[0] = { specification: "1K", execution: combination.execution, credits: 9, available: false };
    expect(selectedImageMapping(models, selection)).toBeUndefined();
    expect(f.calls.filter(call => call.path.endsWith("quote") || call.path.endsWith("tasks"))).toHaveLength(0);
});

test("source missing, price/version/parameters mismatch all gray the combination without choosing a backup", async () => {
    for (const mutate of [
        (f: ReturnType<typeof fixture>) => { f.data.nodes = []; },
        (f: ReturnType<typeof fixture>) => { f.data.nodes[0].id = "channel-b-image"; },
        (f: ReturnType<typeof fixture>) => { f.data.nodes[0].imagePricing!.priceVersion = 3; },
        (f: ReturnType<typeof fixture>) => { f.data.nodes[0].imagePricing!.imageSpecs[0].creditsPerRequest = 10; },
        (f: ReturnType<typeof fixture>) => { f.data.nodes[0].imagePricing!.imageSpecs = [{ parameters: { size: "1024x1024" }, creditsPerRequest: 9 }]; },
    ]) {
        const f = fixture(); mutate(f);
        const models = await f.client.mappedModels(), choice = models[0].combinations[0];
        expect(choice.available).toBe(false); expect(choice).not.toHaveProperty("nodeModelId"); expect(choice).not.toHaveProperty("priceVersion");
        await expect(f.client.quote(intent)).rejects.toMatchObject({ outcome: "not-sent" });
        expect(f.calls).toHaveLength(2);
    }
});

test("failed directory refresh removes old authority and never retries requests", async () => {
    const f = fixture(); await f.client.mappedModels(); f.data.failMapping = true;
    await expect(f.client.mappedModels()).rejects.toMatchObject({ outcome: "not-sent" });
    await expect(f.client.quote(intent)).rejects.toMatchObject({ code: "catalog_changed" });
    expect(f.calls).toHaveLength(4);
});

test("late mapping results after an account change cannot authorize generation", async () => {
    const f = fixture(); let release!: () => void;
    f.gate(() => new Promise<void>(resolve => { release = resolve; }));
    const request = f.client.mappingCatalog(); f.context({ ...scope, epoch: 2 }); release();
    await expect(request).rejects.toMatchObject({ code: "context_changed" });
    f.context(scope); f.gate(undefined);
    await expect(f.client.mappedModels()).rejects.toMatchObject({ code: "context_changed" });
    expect(f.calls).toHaveLength(1);
});

test("late quotes after a directory refresh cannot restore the old confirmation", async () => {
    const f = fixture(); await f.client.mappedModels(); let release!: () => void;
    f.gate(() => new Promise<void>(resolve => { release = resolve; }));
    const request = f.client.quote(intent); f.gate(undefined); await f.client.mappedModels(); release();
    await expect(request).rejects.toMatchObject({ code: "catalog_changed" });
    expect(f.calls.filter(call => call.path.endsWith("tasks"))).toHaveLength(0);
});

test("controller invalidation prevents confirming the previous selection and keeps exact-route single submission", async () => {
    const f = fixture(); await f.client.mappedModels();
    const controller = createCanvasImageGenerationController({ client: f.client, getContext: () => scope,
        receiptStore: { put: async () => {}, list: async () => [] }, createIdempotencyKey: () => "mapping-confirmation" });
    await controller.prepare({ modelId: intent.modelId, prompt: intent.input.prompt, parameters });
    expect(controller.getState().phase).toBe("ready"); controller.invalidateQuote(); await controller.confirm();
    expect(f.calls.filter(call => call.path.endsWith("tasks"))).toHaveLength(0);
    await controller.prepare({ modelId: intent.modelId, prompt: intent.input.prompt, parameters }); await controller.confirm(); await controller.confirm();
    const writes = f.calls.filter(call => call.path.endsWith("tasks"));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(String(writes[0].init!.body))).toEqual({ ...intent, confirmedPriceVersion: 2, confirmedQuoteFingerprint: quote.quoteFingerprint });
});

test("original task recovery does not depend on the current mapping or price directory", async () => {
    const f = fixture(); f.data.failMapping = true;
    const original = await f.client.get("11111111-1111-4111-8111-111111111111");
    expect(original.task.imageSpecSnapshot).toEqual({ status: "recorded", protocol: "openai-image-v1", parameters });
    expect(f.calls.map(call => call.init?.method)).toEqual(["GET"]);
});

test("canvas resolution and ratio controls select exact published pixels and retain their own price", async () => {
    const f = fixture(), [model] = await f.client.mappedModels();
    model.combinations.push({ ...combination, execution: { protocol: "openai-image-v1", parameters: { size: "1024x1536", quality: "high" } }, credits: 13 });
    model.combinations.push({ ...combination, specification: "4K", execution: { protocol: "openai-image-v1", parameters: { size: "4096x4096", quality: "medium" } }, credits: 21 });
    expect(imageMappingAspectRatio(model.combinations[0])).toBe("1:1");
    expect(imageMappingAspectRatio(model.combinations[1])).toBe("2:3");
    expect(imageMappingAspectRatio({ ...combination, execution: { protocol: "openai-image-v1", parameters: { size: "1360x2048", quality: "high" } } })).toBe("2:3");
    expect(selectedImageMapping([model], chooseImageMapping({ ...model, combinations: [...model.combinations].reverse() }))).toMatchObject({ specification: "1K", execution: { parameters: { size: "1024x1024" } } });
    const selection = chooseImageMapping(model, { specification: "1K", aspectRatio: "2:3" });
    expect(selectedImageMapping([model], selection)).toMatchObject({ credits: 13, execution: { parameters: { size: "1024x1536", quality: "high" } } });
    expect(selectedImageMapping([model], chooseImageMapping(model, { specification: "2K" }))).toBeUndefined();
    expect(selectedImageMapping([model], chooseImageMapping(model, { specification: "1K", aspectRatio: "16:9" }))).toBeUndefined();
    model.combinations[1] = { specification: "1K", execution: model.combinations[1].execution, credits: 13, available: false };
    expect(selectedImageMapping([model], chooseImageMapping(model, { specification: "1K", aspectRatio: "2:3" }))).toBeUndefined();
    expect(selectedImageMapping([model], chooseImageMapping(model, { specification: "4K" }))).toMatchObject({ credits: 21, execution: { parameters: { size: "4096x4096", quality: "medium" } } });
});

test("standalone image receives a copied executable snapshot only for mapped sources and refresh clears it", async () => {
    const f = fixture(); f.data.nodes.push({ ...node(), id: "unmapped-source" }); await f.client.mappedModels();
    const nodes = f.client.executableModels(); expect(nodes.map(item => item.id)).toEqual([intent.modelId]);
    nodes[0].imagePricing!.imageSpecs[0].creditsPerRequest = 99;
    expect(f.client.executableModels()[0].imagePricing!.imageSpecs[0].creditsPerRequest).toBe(9);
    f.data.failMapping = true; await expect(f.client.mappedModels()).rejects.toThrow();
    expect(f.client.executableModels()).toEqual([]);
});
