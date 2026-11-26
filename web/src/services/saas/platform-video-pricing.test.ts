import { expect, test } from "bun:test";
import { createAdminModelPricePublicationClient, fetchPlatformPricing, PlatformServiceError, type AdminGenerationScope,
    type AdminModelPriceDraft, type AdminModelPricePublication, type ModelPricePublicationPreview, type PlatformPricing, type PublishedVideoSpecPrice } from "./platform";

const time = "2026-10-28T00:00:00.000Z";
const scope: AdminGenerationScope = { accountId: "synthetic-video-admin", epoch: 2, role: "admin" };
const amount = (): PublishedVideoSpecPrice => ({ billingUnit: "video_specs", creditsPerUnit: null, protocol: "yunfei-grok-video-v1", usagePolicy: "delivered_video", videoSpecs: [
    { parameters: { mode: "text", resolution: "480p", durationSeconds: 3, generateAudio: true, aspectRatio: "16:9" }, creditsPerVideo: 7 },
    { parameters: { mode: "first_frame", resolution: "720p", durationSeconds: 5, generateAudio: false }, creditsPerVideo: 11 },
] });
const publicPrice = (): PlatformPricing => ({ modelId: "synthetic-video", displayName: "合成视频规格", capability: "video", version: 4,
    ...amount(), priceNote: "合成售价，不代表真实费率", effectiveFrom: time, effectiveTo: null });
const saved = (): AdminModelPriceDraft => ({ id: "11111111-1111-4111-8111-111111111111", modelId: "synthetic-video", version: 2,
    binding: { providerId: "synthetic-provider", providerModel: "synthetic-upstream", endpoint: "https://video.example.invalid/v1", adapter: "openai-compatible", capability: "video" },
    bindingMatchesCurrent: true, rules: { schemaVersion: 1, video: { schemaVersion: 1, protocol: "yunfei-grok-video-v1", usagePolicy: "delivered_video" },
        cost: { template: "video_second", currency: "USD", bands: [{ parameters: {}, rates: { second: "0.123" } }] },
        sale: { template: "video_count", currency: "credit", bands: [
            { parameters: { mode: "text", resolution: "480p", durationSeconds: "3", generateAudio: "true", aspectRatio: "16:9" }, rates: { video: "7" } },
            { parameters: { mode: "first_frame", resolution: "720p", durationSeconds: "5", generateAudio: "false" }, rates: { video: "11" } },
        ] } }, priceNote: "private-cost-note", createdAt: time });
const publication = (): Extract<AdminModelPricePublication, { billingUnit: "video_specs" }> => ({ id: "22222222-2222-4222-8222-222222222222",
    modelId: saved().modelId, draftId: saved().id, draftVersion: 2, priceVersion: 4, ...amount(), publicPriceNote: "按原规格成功交付一条视频",
    binding: saved().binding, rules: saved().rules, bindingMatchesCurrent: true, createdAt: time });
const preview = (published: AdminModelPricePublication | null = publication()): ModelPricePublicationPreview => ({ modelId: saved().modelId,
    draft: saved(), publication: published, currentPrice: { version: published ? 4 : 3, ...amount(), enabled: true }, latestPriceVersion: published ? 4 : 3, unavailableReason: null });
function client(run: (path: string, init?: RequestInit) => Response | Promise<Response>) {
    let current: AdminGenerationScope | null = scope;
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ path: String(input), init }); return run(String(input), init); }) as typeof fetch;
    return { calls, value: createAdminModelPricePublicationClient({ scope, getScope: () => current, fetcher }), change: (next: AdminGenerationScope | null) => { current = next; } };
}
async function publicReply(items: unknown[]) {
    return fetchPlatformPricing({ accountId: scope.accountId, signal: new AbortController().signal,
        fetcher: (async () => Response.json({ items, requestId: "synthetic" })) as unknown as typeof fetch });
}

test("video public catalog retains all exact specifications and strips private source, cost, endpoint and keys", async () => {
    const row = publicPrice();
    const rows = await publicReply([{ ...row, rules: saved().rules, binding: saved().binding, cost: "private-cost", endpoint: "private-endpoint", apiKey: "private-key" }]);
    expect(rows).toEqual([row]); expect(rows[0]!.creditsPerUnit).toBeNull();
    expect(JSON.stringify(rows)).not.toContain("private-"); expect(JSON.stringify(rows)).not.toContain("video.example.invalid");
    expect(rows[0]).not.toHaveProperty("rules"); expect(rows[0]).not.toHaveProperty("binding");
    expect(rows[0]).not.toHaveProperty("cost"); expect(rows[0]).not.toHaveProperty("endpoint"); expect(rows[0]).not.toHaveProperty("apiKey");
    if (rows[0]!.billingUnit !== "video_specs") throw new Error("invalid synthetic video price");
    expect(rows[0]!.videoSpecs.map(spec => spec.creditsPerVideo)).toEqual([7, 11]);
    expect(rows[0]!.videoSpecs[0]!.parameters.generateAudio).toBe(true);
    expect(rows[0]!.videoSpecs[1]!.parameters).not.toHaveProperty("aspectRatio");
});

test("video pricing rejects malformed protocol, product usage, cash, fractional or scalar prices and incomplete specifications", async () => {
    const first = amount().videoSpecs[0]!, second = amount().videoSpecs[1]!;
    const invalid: unknown[] = [
        ...[undefined, "grok-video", ["yunfei-grok-video-v1"]].map(protocol => ({ ...publicPrice(), protocol })),
        ...[undefined, "second", ["delivered_video"]].map(usagePolicy => ({ ...publicPrice(), usagePolicy })),
        { ...publicPrice(), creditsPerUnit: 7 }, { ...publicPrice(), currency: "CNY" }, { ...publicPrice(), imageSpecs: [] },
        ...[[], null, {}, undefined].map(videoSpecs => ({ ...publicPrice(), videoSpecs })),
        ...[0, -1, 0.1, "7", "0.1", null, [], 9_007_199_254_740_992].map(creditsPerVideo => ({ ...publicPrice(), videoSpecs: [{ ...first, creditsPerVideo }] })),
        ...[{ mode: ["text"] }, { resolution: ["480p"] }, { aspectRatio: ["16:9"] }, { durationSeconds: "3" }, { durationSeconds: [3] },
            { durationSeconds: 3.1 }, { durationSeconds: 0 }, { durationSeconds: 16 }, { generateAudio: "true" }, { generateAudio: [true] }, { generateAudio: 1 },
            { resolution: "4k" }, { aspectRatio: "auto" }, { extra: true }].map(patch => ({ ...publicPrice(), videoSpecs: [{ ...first, parameters: { ...first.parameters, ...patch } }] })),
        ...Object.keys(first.parameters).map(key => ({ ...publicPrice(), videoSpecs: [{ ...first, parameters: Object.fromEntries(Object.entries(first.parameters).filter(([name]) => name !== key)) }] })),
        { ...publicPrice(), videoSpecs: [{ ...second, parameters: { ...second.parameters, aspectRatio: "16:9" } }] },
        { ...publicPrice(), videoSpecs: [{ ...first, currency: "CNY" }] },
        { ...publicPrice(), videoSpecs: [{ ...first, cost: "private" }] },
        { ...publicPrice(), videoSpecs: [first, { ...first, parameters: { aspectRatio: "16:9", generateAudio: true, durationSeconds: 3, resolution: "480p", mode: "text" }, creditsPerVideo: 9 }] },
        ...["text", "image", "audio", ["video"]].map(capability => ({ ...publicPrice(), capability })),
    ];
    for (const row of invalid) await expect(publicReply([row])).rejects.toBeInstanceOf(PlatformServiceError);
});

test("video publication preview uses complete immutable policy and compares all specification prices independent of order", async () => {
    const row = preview();
    if (row.currentPrice?.billingUnit !== "video_specs") throw new Error("invalid fixture");
    row.currentPrice.videoSpecs.reverse();
    const f = client(() => Response.json({ preview: row, requestId: "synthetic" }));
    try {
        expect(await f.value.load(saved().modelId)).toEqual(row);
        expect(f.calls[0]!.path).toBe("/api/v1/admin/model-price-publications?modelId=synthetic-video");
        expect(new Headers(f.calls[0]!.init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
    } finally { f.value.close(); }
    for (const target of ["publication", "currentPrice"] as const) {
        for (const change of ["price", "parameters", "missing", "usage"] as const) {
            const bad = preview(), value = bad[target];
            if (value?.billingUnit !== "video_specs") throw new Error("invalid fixture");
            if (change === "price") value.videoSpecs[1]!.creditsPerVideo = 12;
            else if (change === "parameters") value.videoSpecs[1]!.parameters.durationSeconds = 6;
            else if (change === "missing") value.videoSpecs.pop();
            else (value as unknown as Record<string, unknown>).usagePolicy = "provider_seconds";
            const g = client(() => Response.json({ preview: bad }));
            try { await expect(g.value.load(saved().modelId)).rejects.toBeInstanceOf(PlatformServiceError); } finally { g.value.close(); }
        }
    }
});

test("video draft binding and policy reject missing, extra or coerced fields and unsupported protocol", async () => {
    const base = saved();
    const invalidDrafts: unknown[] = [
        { ...base, binding: { ...base.binding, capability: ["video"] } }, { ...base, binding: { ...base.binding, adapter: "video" } },
        { ...base, binding: { ...base.binding, secret: "private" } },
        ...[undefined, { ...base.rules.video, protocol: "guessed" }, { ...base.rules.video, usagePolicy: "second" },
            { ...base.rules.video, extra: true }, { ...base.rules.video, schemaVersion: "1" }].map(video => ({ ...base, rules: { ...base.rules, video } })),
        { ...base, rules: { ...base.rules, sale: { ...base.rules.sale, currency: "CNY" } } },
    ];
    for (const draft of invalidDrafts) {
        const f = client(() => Response.json({ preview: { ...preview(), draft } }));
        try { await expect(f.value.load(saved().modelId)).rejects.toBeInstanceOf(PlatformServiceError); } finally { f.value.close(); }
    }
});

test("video publication confirms one saved identity without posted bands and keeps changed or unknown receipts GET-only", async () => {
    for (const changed of [false, true]) {
        const published = publication(); if (changed) published.videoSpecs[1]!.creditsPerVideo = 12;
        const f = client((_, init) => Response.json(init?.method === "POST" ? { publication: published } : { preview: preview(null) }));
        try {
            const source = (await f.value.load(saved().modelId))!;
            if (changed) {
                await expect(f.value.publish(source, publication().publicPriceNote)).rejects.toBeInstanceOf(PlatformServiceError);
                expect(f.value.hasUnconfirmed(saved().modelId)).toBe(true);
                await expect(f.value.publish((await f.value.load(saved().modelId))!, publication().publicPriceNote)).rejects.toBeInstanceOf(PlatformServiceError);
            } else expect(await f.value.publish(source, publication().publicPriceNote)).toEqual(publication());
            const writes = f.calls.filter(call => call.init?.method === "POST"); expect(writes).toHaveLength(1);
            const body = JSON.parse(String(writes[0]!.init?.body));
            expect(Object.keys(body).sort()).toEqual(["binding", "draftId", "expectedDraftVersion", "expectedPriceVersion", "modelId", "publicPriceNote"]);
            expect(body.rules).toBeUndefined(); expect(body.videoSpecs).toBeUndefined(); expect(body.creditsPerUnit).toBeUndefined();
            expect(JSON.stringify(body)).not.toContain("private-cost");
        } finally { f.value.close(); }
    }
});

test("video publication late response after epoch change cannot restore an old confirmation", async () => {
    let resolve!: (body: unknown) => void, started!: () => void;
    const body = new Promise<unknown>(done => { resolve = done; }), waiting = new Promise<void>(done => { started = done; });
    const f = client((_, init) => {
        if (init?.method !== "POST") return Response.json({ preview: preview(null) });
        const response = Response.json({}); response.json = () => { started(); return body; }; return response;
    });
    const publishing = f.value.publish((await f.value.load(saved().modelId))!, publication().publicPriceNote); await waiting;
    f.change({ ...scope, epoch: 3 }); resolve({ publication: publication() }); expect(await publishing).toBeNull();
    expect(f.calls[1]!.init?.signal?.aborted).toBe(true); expect(f.calls.filter(call => call.init?.method === "POST")).toHaveLength(1); f.value.close();
});

test("existing audio request pricing and publication keep their scalar contract without video policy", async () => {
    const modelId = "synthetic-audio", row: PlatformPricing = { modelId, displayName: "合成语音", capability: "audio", version: 4,
        billingUnit: "request", creditsPerUnit: 3, effectiveFrom: time, effectiveTo: null };
    expect(await publicReply([row])).toEqual([row]);
    const draft: AdminModelPriceDraft = { ...saved(), modelId, binding: { ...saved().binding, capability: "audio" },
        rules: { schemaVersion: 1, cost: null, sale: { template: "audio_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "3" } }] } } };
    const published: AdminModelPricePublication = { id: publication().id, modelId, draftId: draft.id, draftVersion: 2, priceVersion: 4,
        billingUnit: "request", creditsPerUnit: 3, publicPriceNote: "合成语音按次", binding: draft.binding, rules: draft.rules, bindingMatchesCurrent: true, createdAt: time };
    const before: ModelPricePublicationPreview = { modelId, draft, publication: null, currentPrice: null, latestPriceVersion: 0, unavailableReason: null };
    const f = client((_, init) => Response.json(init?.method === "POST" ? { publication: published } : { preview: before }));
    try { expect(await f.value.publish((await f.value.load(modelId))!, published.publicPriceNote)).toEqual(published); } finally { f.value.close(); }
});
