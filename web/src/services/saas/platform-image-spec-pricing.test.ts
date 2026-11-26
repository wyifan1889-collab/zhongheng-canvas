import { expect, test } from "bun:test";
import { createAdminModelPricePublicationClient, fetchAdminPricing, fetchPlatformPricing, PlatformServiceError,
    type AdminGenerationScope, type AdminModelPriceDraft, type AdminModelPricePublication, type ModelPricePublicationPreview,
    type PlatformPricing, type PublishedImageSpecPrice } from "./platform";

const time = "2026-10-25T00:00:00.000Z";
const scope: AdminGenerationScope = { accountId: "synthetic-spec-admin", epoch: 3, role: "admin" };
const amount = (): PublishedImageSpecPrice => ({ billingUnit: "image_specs", creditsPerUnit: null, protocol: "openai-image-v1", imageSpecs: [
    { parameters: { size: "1024x1024", quality: "low" }, creditsPerRequest: 2 },
    { parameters: { size: "2048x2048", quality: "high" }, creditsPerRequest: 7 },
] });
const publicPrice = (): PlatformPricing => ({ modelId: "synthetic-image-spec", displayName: "模拟图片规格", capability: "image", version: 4,
    ...amount(), effectiveFrom: time, effectiveTo: null, priceNote: "合成价目，不代表真实费率" });
const scalarPrice = (): PlatformPricing => ({ modelId: "synthetic-scalar", displayName: "原按次价", capability: "image", version: 1,
    billingUnit: "request", creditsPerUnit: 5, effectiveFrom: time, effectiveTo: null });
const textPrice = (): PlatformPricing => ({ modelId: "synthetic-text", displayName: "原文本价", capability: "text", version: 2,
    billingUnit: "text_tokens", creditsPerUnit: null, inputCreditsPerMillion: "0.000004", outputCreditsPerMillion: "9007199254740993.000002",
    cachedInputCreditsPerMillion: "0.000001", effectiveFrom: time, effectiveTo: null });
const adminPrice = (price: PlatformPricing) => ({ ...price, id: `price-${price.modelId}`, modelCatalogId: `catalog-${price.modelId}`,
    providerId: "synthetic-provider", providerDisplayName: "模拟渠道", providerEnabled: true, modelEnabled: true, enabled: true, createdAt: time, updatedAt: time });
async function publicReply(items: unknown[]) {
    const fetcher: typeof fetch = Object.assign(async () => Response.json({ items }), { preconnect: fetch.preconnect });
    return fetchPlatformPricing({ accountId: scope.accountId, signal: new AbortController().signal, fetcher });
}
async function adminReply(items: unknown[]) {
    const previous = globalThis.fetch;
    globalThis.fetch = Object.assign(async () => Response.json({ items }), { preconnect: previous.preconnect });
    try { return await fetchAdminPricing(); } finally { globalThis.fetch = previous; }
}

test("image specification public and admin prices retain every explicit combination and preserve scalar/text variants", async () => {
    const rows = [scalarPrice(), textPrice(), publicPrice()];
    const result = await publicReply(rows.map(price => ({ ...price, rules: { cost: "private-cost" }, binding: { endpoint: "private-endpoint" }, credential: "private-key" })));
    expect(result).toEqual(rows); expect(JSON.stringify(result)).not.toContain("private-");
    const adminRows = rows.map(adminPrice);
    expect(await adminReply(adminRows.map(price => ({ ...price, privateNote: "private-cost" })))).toEqual(adminRows);
    const image = result[2]; expect(image.creditsPerUnit).toBeNull();
    if (image.billingUnit === "image_specs" && image.protocol === "openai-image-v1") {
        expect(image.imageSpecs).toHaveLength(2); expect(image.imageSpecs.map(item => item.creditsPerRequest)).toEqual([2, 7]);
        expect(image.imageSpecs.map(item => item.parameters)).toEqual([{ size: "1024x1024", quality: "low" }, { size: "2048x2048", quality: "high" }]);
    }
    const singleDimension = { ...publicPrice(), imageSpecs: [{ parameters: { size: "1024x1024" }, creditsPerRequest: 3 }] };
    expect(await publicReply([singleDimension])).toEqual([singleDimension]);
});

test("image specification decoding rejects an entire malformed, duplicate or overlapping collection without defaults", async () => {
    const invalid: unknown[] = [
        { ...publicPrice(), creditsPerUnit: 2 }, { ...publicPrice(), creditsPerUnit: undefined },
        ...[null, [], {}].map(imageSpecs => ({ ...publicPrice(), imageSpecs })),
        ...[0, -1, 0.5, "2", 9_007_199_254_740_992].map(creditsPerRequest => ({ ...publicPrice(), imageSpecs: [{ parameters: { size: "1024x1024" }, creditsPerRequest }] })),
        ...[{}, { size: "auto" }, { size: "1K" }, { quality: "auto" }, { size: "1024x1024", quality: "high", n: 1 }]
            .map(parameters => ({ ...publicPrice(), imageSpecs: [{ parameters, creditsPerRequest: 2 }] })),
        { ...publicPrice(), imageSpecs: [{ parameters: { size: "1024x1024" }, creditsPerRequest: 2, privateCost: "1" }] },
        { ...publicPrice(), imageSpecs: [amount().imageSpecs[0], { parameters: { quality: "low", size: "1024x1024" }, creditsPerRequest: 9 }] },
        { ...publicPrice(), imageSpecs: [{ parameters: { size: "1024x1024" }, creditsPerRequest: 2 }, { parameters: { size: "1024x1024", quality: "high" }, creditsPerRequest: 7 }] },
        { ...publicPrice(), imageSpecs: [{ parameters: { size: "1024x1024" }, creditsPerRequest: 2 }, { parameters: { quality: "high" }, creditsPerRequest: 7 }] },
        { ...publicPrice(), inputCreditsPerMillion: null }, { ...publicPrice(), outputCreditsPerMillion: "1" }, { ...publicPrice(), cachedInputCreditsPerMillion: "1" },
    ];
    for (const value of invalid) await expect(publicReply([scalarPrice(), value])).rejects.toBeInstanceOf(PlatformServiceError);
    await expect(adminReply([adminPrice(publicPrice()), { ...adminPrice(publicPrice()), imageSpecs: [] }])).rejects.toBeInstanceOf(PlatformServiceError);
    for (const price of [scalarPrice(), textPrice()]) {
        for (const imageSpecs of [[], amount().imageSpecs]) await expect(publicReply([{ ...price, imageSpecs }])).rejects.toBeInstanceOf(PlatformServiceError);
    }
});

test("image specification prices are rejected on non-image public and admin capabilities", async () => {
    for (const capability of ["text", "video", "audio"]) {
        await expect(publicReply([{ ...publicPrice(), capability }])).rejects.toBeInstanceOf(PlatformServiceError);
        await expect(adminReply([{ ...adminPrice(publicPrice()), capability }])).rejects.toBeInstanceOf(PlatformServiceError);
    }
});

test("Gemini per-delivered-image bands coexist with fixed request prices and reject contradictory meters", async () => {
    const gemini = { modelId: "synthetic-native", displayName: "Gemini", capability: "image", version: 1, effectiveFrom: time, effectiveTo: null,
        billingUnit: "image_specs", creditsPerUnit: null, protocol: "gemini-generate-content-v1", usagePolicy: "delivered_images",
        imageSpecs: [{ parameters: { aspectRatio: "1:1", imageSize: "512" }, creditsPerImage: 7 }] } satisfies PlatformPricing;
    expect(await publicReply([publicPrice(), { ...gemini, credential: "private-key" }])).toEqual([publicPrice(), gemini]);
    expect(await adminReply([adminPrice(gemini)])).toEqual([adminPrice(gemini)]);
    for (const row of [{ ...gemini, usagePolicy: "request" }, { ...gemini, imageSpecs: [...gemini.imageSpecs, ...gemini.imageSpecs] },
        { ...gemini, imageSpecs: [{ ...gemini.imageSpecs[0], creditsPerRequest: 7 }] },
        { ...gemini, imageSpecs: [{ ...gemini.imageSpecs[0], parameters: { aspectRatio: "1:1", imageSize: "auto" } }] }]) {
        await expect(publicReply([row])).rejects.toBeInstanceOf(PlatformServiceError);
    }
});

const saved = (): AdminModelPriceDraft => ({ id: "11111111-1111-4111-8111-111111111111", modelId: publicPrice().modelId, version: 2,
    binding: { providerId: "synthetic-provider", providerModel: "synthetic-upstream", endpoint: "https://spec.example.invalid/v1", adapter: "openai-compatible", capability: "image" },
    bindingMatchesCurrent: true, rules: { schemaVersion: 1, cost: { template: "image_request", currency: "USD", bands: [{ parameters: {}, rates: { request: "0.123" } }] },
        sale: { template: "image_request", currency: "credit", bands: amount().imageSpecs.map(item => ({ parameters: { ...item.parameters }, rates: { request: String(item.creditsPerRequest) } })) } },
    priceNote: "private-cost-note", createdAt: time });
const publication = (): AdminModelPricePublication => ({ id: "22222222-2222-4222-8222-222222222222", modelId: saved().modelId,
    draftId: saved().id, draftVersion: 2, priceVersion: 4, ...amount(), publicPriceNote: "完整规格价", rules: saved().rules, binding: saved().binding,
    bindingMatchesCurrent: true, createdAt: time });
const preview = (published: AdminModelPricePublication | null = publication()): ModelPricePublicationPreview => ({ modelId: saved().modelId,
    draft: saved(), latestPriceVersion: 4, currentPrice: { version: 4, ...amount(), enabled: true }, publication: published, unavailableReason: null });
function client(run: (path: string, init?: RequestInit) => Promise<Response>) {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ path: String(input), init }); return run(String(input), init); }, { preconnect: fetch.preconnect });
    return { calls, value: createAdminModelPricePublicationClient({ scope, getScope: () => scope, fetcher }) };
}

test("image publication validates all combinations and prices against saved rules and same-version current price", async () => {
    const good = client(async () => Response.json({ preview: preview() }));
    try { expect(await good.value.load(saved().modelId)).toEqual(preview()); } finally { good.value.close(); }
    const reordered = preview();
    if (reordered.currentPrice?.billingUnit === "image_specs") reordered.currentPrice.imageSpecs.reverse();
    const order = client(async () => Response.json({ preview: reordered }));
    try { expect((await order.value.load(saved().modelId))?.publication).toEqual(publication()); } finally { order.value.close(); }
    for (const target of ["publication", "currentPrice"] as const) {
        for (const change of ["price", "combination", "missing"] as const) {
            const value = preview(), price = value[target];
            if (price?.billingUnit !== "image_specs") throw new Error("synthetic image specification fixture invalid");
            if (change === "price") price.imageSpecs[1].creditsPerRequest = 8;
            else if (change === "combination") price.imageSpecs[1].parameters.size = "4096x4096";
            else price.imageSpecs.pop();
            const f = client(async () => Response.json({ preview: value }));
            try { await expect(f.value.load(saved().modelId)).rejects.toBeInstanceOf(PlatformServiceError); } finally { f.value.close(); }
        }
    }
    const wrongBinding = publication(); wrongBinding.binding.capability = "text";
    const invalid = client(async () => Response.json({ preview: { ...preview(), publication: wrongBinding } }));
    try { await expect(invalid.value.load(saved().modelId)).rejects.toBeInstanceOf(PlatformServiceError); } finally { invalid.value.close(); }
});

test("image publication submits saved identity only and a changed item price keeps unknown publication GET-only", async () => {
    for (const changed of [false, true]) {
        const response = publication(); if (changed && response.billingUnit === "image_specs") response.imageSpecs[1].creditsPerRequest = 9;
        const before: ModelPricePublicationPreview = { ...preview(null), latestPriceVersion: 3,
            currentPrice: { version: 3, billingUnit: "request", creditsPerUnit: 5, enabled: true } };
        const f = client(async (_path, init) => Response.json(init?.method === "POST" ? { publication: response } : { preview: before }));
        try {
            const source = (await f.value.load(saved().modelId))!;
            if (changed) {
                await expect(f.value.publish(source, response.publicPriceNote)).rejects.toBeInstanceOf(PlatformServiceError);
                expect(f.value.hasUnconfirmed(saved().modelId)).toBe(true);
                await expect(f.value.publish((await f.value.load(saved().modelId))!, response.publicPriceNote)).rejects.toBeInstanceOf(PlatformServiceError);
            } else expect(await f.value.publish(source, response.publicPriceNote)).toEqual(publication());
            const writes = f.calls.filter(call => call.init?.method === "POST"); expect(writes).toHaveLength(1);
            const body = JSON.parse(String(writes[0].init?.body));
            expect(Object.keys(body).sort()).toEqual(["binding", "draftId", "expectedDraftVersion", "expectedPriceVersion", "modelId", "publicPriceNote"]);
            expect(JSON.stringify(body)).not.toContain("private-cost"); expect(body.imageSpecs).toBeUndefined(); expect(body.creditsPerUnit).toBeUndefined();
        } finally { f.value.close(); }
    }
});
