import { expect, test } from "bun:test";
import { createMappedVideoGenerationClient } from "./mapped-video-generation";
import type { VideoGenerationIntent } from "./video-generation";
import type { VideoGenerationModel } from "../../../../packages/shared/src/generation-video";
import type { PublishedMappingCatalog } from "./model-mapping-catalog";

const scope = { accountId: "mapped-owner", epoch: 1 };
const parameters = { mode: "text", resolution: "720p", durationSeconds: 5, generateAudio: false, aspectRatio: "16:9" } as const;
const intent: VideoGenerationIntent = { modelId: "source-video", input: { prompt: "合成镜头" }, parameters };
const quote = { modelId: intent.modelId, priceVersion: 2, parameters, quotedVideoUnits: 1, maxVideoUnits: 1, reservedCredits: 12, usagePolicy: "delivered_video", quoteFingerprint: "b".repeat(64) };
const id = "11111111-1111-4111-8111-111111111111", key = `video:${id}`;
function fixture() {
    let current: typeof scope | null = scope, gate: ((path: string) => Promise<void>) | undefined;
    const mapping: PublishedMappingCatalog = { version: 1, models: [{ id: "grok-family", displayName: "Grok Video", capability: "video", group: "视频", specifications: ["720P", "1080P", "4K"],
        combinations: [{ specification: "720P", available: true, nodeModelId: intent.modelId, priceVersion: 2, credits: 12, execution: { protocol: "yunfei-grok-video-v1", parameters } }] }] };
    const nodes: VideoGenerationModel[] = [{ id: intent.modelId, displayName: "渠道原型号", capability: "video", group: null, videoPricing: { priceVersion: 2, billingUnit: "video_specs", creditsPerUnit: null,
        protocol: "yunfei-grok-video-v1", usagePolicy: "delivered_video", videoSpecs: [{ parameters, creditsPerVideo: 12 }] } }];
    const data = { mapping: structuredClone(mapping), nodes: structuredClone(nodes), failMapping: false, loseAck: false };
    const calls: { path: string; init?: RequestInit }[] = [];
    const client = createMappedVideoGenerationClient({ scope, getScope: () => current, fetcher: (async (input, init) => {
        const path = String(input); calls.push({ path, init }); await gate?.(path);
        if (path.endsWith("model-mapping-catalog")) { if (data.failMapping) throw new Error("offline"); return Response.json({ catalog: data.mapping }); }
        if (path.endsWith("/models")) return Response.json({ items: data.nodes });
        if (path.endsWith("/quote")) return Response.json({ quote });
        if (path.endsWith("/tasks") && data.loseAck) throw new Error("ACK lost");
        return Response.json({ task: { id, projectId: null, nodeId: null, modelId: intent.modelId, priceVersion: 2, quotedUnits: 12, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 12,
            executionStatus: "running", deliveryStatus: "pending", billingStatus: "reserved", video: { parameters, usagePolicy: "delivered_video", quotedVideoUnits: 1, reservedCredits: 12, phase: "accepted" } }, result: null });
    }) as typeof fetch });
    return { data, calls, client, context: (next: typeof current) => { current = next; }, gate: (next: typeof gate) => { gate = next; } };
}

test("video family keeps extensible gray labels, exact routing and the original one-use quote authority", async () => {
    const f = fixture(), families = await f.client.mappedModels();
    expect(families.map(item => item.displayName)).toEqual(["Grok Video"]);
    expect(families[0].specifications).toEqual(["720P", "1080P", "4K"]);
    families[0].combinations[0].credits = 999;
    const confirmed = await f.client.quote(intent); expect(confirmed.reservedCredits).toBe(12);
    await expect(f.client.submit(intent, { ...confirmed }, key)).rejects.toThrow();
    expect((await f.client.submit(intent, confirmed, key)).task.id).toBe(id);
    await expect(f.client.submit(intent, confirmed, key)).rejects.toThrow();
    const posts = f.calls.filter(call => call.path.endsWith("/tasks")); expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0].init?.body))).toEqual({ ...intent, confirmedPriceVersion: 2, confirmedQuoteFingerprint: quote.quoteFingerprint });
    expect(f.calls.every(call => new Headers(call.init?.headers).get("x-canvas-account-id") === scope.accountId)).toBe(true);
});

test("missing source or mismatched version, credits and complete parameters disable rather than reroute", async () => {
    for (const change of [
        (f: ReturnType<typeof fixture>) => { f.data.nodes = []; },
        (f: ReturnType<typeof fixture>) => { f.data.nodes[0].id = "other-source"; },
        (f: ReturnType<typeof fixture>) => { f.data.nodes[0].videoPricing.priceVersion = 3; },
        (f: ReturnType<typeof fixture>) => { f.data.nodes[0].videoPricing.videoSpecs[0].creditsPerVideo = 13; },
        (f: ReturnType<typeof fixture>) => { f.data.nodes[0].videoPricing.videoSpecs[0].parameters.durationSeconds = 10; },
    ]) {
        const f = fixture(); change(f); const families = await f.client.mappedModels();
        expect(families[0].combinations[0]).toMatchObject({ available: false });
        expect(families[0].combinations[0]).not.toHaveProperty("nodeModelId");
        await expect(f.client.quote(intent)).rejects.toMatchObject({ code: "catalog_changed", outcome: "not-sent" });
        expect(f.calls).toHaveLength(2);
    }
});

test("family names and unsupported resolution or duration never synthesize an executable request", async () => {
    const f = fixture(); await f.client.mappedModels();
    for (const input of [{ ...intent, modelId: "grok-family" }, { ...intent, parameters: { ...parameters, resolution: "1080p" } }, { ...intent, parameters: { ...parameters, durationSeconds: 10 } }])
        await expect(f.client.quote(input as VideoGenerationIntent)).rejects.toMatchObject({ code: "catalog_changed" });
    expect(f.calls).toHaveLength(2);
});

test("failed refresh clears mappings and existing quote authority without automatic retry", async () => {
    const f = fixture(); await f.client.mappedModels(); const confirmed = await f.client.quote(intent); f.data.failMapping = true;
    await expect(f.client.mappedModels()).rejects.toThrow();
    await expect(f.client.quote(intent)).rejects.toMatchObject({ code: "catalog_changed" });
    await expect(f.client.submit(intent, confirmed, key)).rejects.toThrow();
    expect(f.calls).toHaveLength(5);
});

test("late quotes and account epochs cannot restore a previous confirmation", async () => {
    for (const boundary of ["refresh", "account"]) {
        const f = fixture(); await f.client.mappedModels(); let release!: () => void;
        f.gate(path => path.endsWith("/quote") ? new Promise(resolve => { release = resolve; }) : Promise.resolve());
        const pending = f.client.quote(intent);
        if (boundary === "refresh") await f.client.mappedModels(); else f.context({ ...scope, epoch: 2 });
        release(); await expect(pending).rejects.toThrow();
        expect(f.calls.some(call => call.path.endsWith("/tasks"))).toBe(false);
    }
});

test("unknown task acknowledgement recovers by original key even when the mapping directory fails", async () => {
    const f = fixture(); await f.client.mappedModels(); const confirmed = await f.client.quote(intent); f.data.loseAck = true;
    await expect(f.client.submit(intent, confirmed, key)).rejects.toMatchObject({ outcome: "unknown" });
    f.data.failMapping = true; await expect(f.client.mappedModels()).rejects.toThrow();
    expect((await f.client.recover(key)).task.id).toBe(id);
    expect(f.calls.at(-1)?.init?.method).toBe("GET"); expect(f.calls.at(-1)?.path).toContain(encodeURIComponent(key));
    expect(f.calls.filter(call => call.path.endsWith("/tasks"))).toHaveLength(1);
});
