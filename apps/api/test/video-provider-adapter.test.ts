import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { createProviderGateway, type VideoHttpsRequest } from "../src/provider-gateway";
import { buildVideoProviderCreateRequest, videoProviderTaskPath } from "../src/video-provider-request";
import { createVideoProviderAdapter } from "../src/video-provider-adapter";
import type { VideoRuntimePolicy } from "../src/generation-video-config";
const binding = { protocol: "yunfei-grok-video-v1" as const, providerId: "provider", providerModel: "administrator-exact-model", endpoint: "https://provider.example/v1" };
const parameters = { mode: "text" as const, durationSeconds: 3, resolution: "480p" as const, aspectRatio: "16:9" as const, generateAudio: false };
const target = { ...binding, adapter: "openai-compatible" as const, credential: "private-credential" };
const policy = { createTimeoutMs: 1000, inspectTimeoutMs: 1000, downloadTimeoutMs: 1000, jsonMaxBytes: 1024, maxVideoBytes: 1024 } as VideoRuntimePolicy;
function transport(body: string | Uint8Array, status = 200, headers: Record<string, string> = { "content-type": "application/json" }, remote = "93.184.216.34", complete = true) {
    const calls: { url: string; options: any; sent: Uint8Array[] }[] = [];
    const request = ((url: URL, options: any, callback: any) => {
        const sent: Uint8Array[] = []; calls.push({ url: url.toString(), options, sent });
        return new Writable({ write(chunk, _encoding, done) { sent.push(new Uint8Array(chunk)); done(); }, final(done) {
            const response = Object.assign(Readable.from([Buffer.from(body)]), { statusCode: status, headers,
                socket: { remoteAddress: remote, authorized: true }, complete });
            callback(response); done();
        } });
    }) as VideoHttpsRequest;
    return { request, calls };
}
test("video JSON pins a checked address into TLS lookup and uses the original credential/path", async () => {
    const mock = transport(JSON.stringify({ id: "id", object: "video", status: "queued" }));
    let lookups = 0;
    const gateway = createProviderGateway(undefined, async () => { lookups++; return ["93.184.216.34"]; }, mock.request);
    const result = await gateway.requestVideoJson({ target, path: "videos", body: { model: binding.providerModel }, maxBytes: 1024, signal: AbortSignal.timeout(1000) });
    expect(result.status).toBe("observed"); expect(lookups).toBe(1);
    expect(mock.calls[0].url).toBe("https://provider.example/v1/videos");
    expect(mock.calls[0].options.agent).toBe(false);
    expect(mock.calls[0].options.headers.authorization).toBe("Bearer private-credential");
    let pinned: unknown; mock.calls[0].options.lookup("provider.example", {}, (_error: unknown, address: string) => { pinned = address; });
    expect(pinned).toBe("93.184.216.34");
});
test("HTTP errors, redirects, rebinds, compression, length and byte-budget faults remain observations unknown", async () => {
    for (const mock of [transport("{}", 401), transport("{}", 404), transport("{}", 429), transport("{}", 503), transport("{}", 302),
        transport("{}", 200, { "content-type": "application/json" }, "127.0.0.1"), transport("{}", 200, { "content-type": "application/json", "content-encoding": "gzip" }),
        transport("{}", 200, { "content-type": "application/json", "content-length": "99" }), transport("x".repeat(1025)), transport("{}", 200, { "content-type": "application/json" }, "93.184.216.34", false)]) {
        const gateway = createProviderGateway(undefined, async () => ["93.184.216.34"], mock.request);
        const result = await gateway.requestVideoJson({ target, path: "videos", maxBytes: 1024, signal: AbortSignal.timeout(1000) });
        expect(result.status).toBe("unknown"); expect(mock.calls).toHaveLength(1);
    }
});
test("private DNS and missing deadline never send video requests", async () => {
    const mock = transport("{}"); const gateway = createProviderGateway(undefined, async () => ["10.0.0.2"], mock.request);
    expect((await gateway.requestVideoJson({ target, path: "videos", maxBytes: 1024, signal: AbortSignal.timeout(1000) })).status).toBe("unknown");
    expect((await gateway.requestVideoJson({ target, path: "videos", maxBytes: 1024 })).status).toBe("unknown"); expect(mock.calls).toHaveLength(0);
});
test("an unresolved DNS check consumes the same deadline and cannot start a late connection", async () => {
    const mock = transport("{}"); let answer!: (addresses: string[]) => void;
    const gateway = createProviderGateway(undefined, () => new Promise(resolve => { answer = resolve; }), mock.request);
    const result = await gateway.requestVideoJson({ target, path: "videos", maxBytes: 1024, signal: AbortSignal.timeout(10) });
    expect(result.status).toBe("unknown"); expect(mock.calls).toHaveLength(0);
    answer(["93.184.216.34"]); await Promise.resolve(); await Promise.resolve();
    expect(mock.calls).toHaveLength(0);
});
test("bounded content only accepts exact MP4 bytes and never invents successful delivery", async () => {
    const mock = transport(new Uint8Array([1, 2, 3]), 200, { "content-type": "video/mp4", "content-length": "3" });
    const gateway = createProviderGateway(undefined, async () => ["93.184.216.34"], mock.request);
    expect(await gateway.requestVideoContent({ target, path: "videos/original/content", method: "GET", maxBytes: 3, signal: AbortSignal.timeout(1000) }))
        .toEqual({ status: "resolved", httpStatus: 200, contentType: "video/mp4", body: new Uint8Array([1, 2, 3]) });
});
test("canonical create rejects aliases and first-frame mismatch; original IDs remain encoded", () => {
    expect(buildVideoProviderCreateRequest(binding, { prompt: "test" }, parameters)).toEqual({ model: binding.providerModel, prompt: "test", duration: 3, resolution: "480p", generate_audio: false, aspect_ratio: "16:9" });
    expect(buildVideoProviderCreateRequest(binding, { prompt: "test" }, { ...parameters, watermark: false } as any)).toBeNull();
    expect(buildVideoProviderCreateRequest(binding, { prompt: "test", referenceMediaId: "id" }, { mode: "first_frame", durationSeconds: 3, resolution: "480p", generateAudio: false })).toBeNull();
    expect(videoProviderTaskPath("a/b..", true)).toBe("videos/a%2Fb%2E%2E/content"); expect(videoProviderTaskPath("..")).toBeNull();
});
test("adapter never loops create and all subsequent operations use the same binding and original ID", async () => {
    const calls: any[] = [];
    const adapter = createVideoProviderAdapter({ policy, credential: async () => "private", gateway: {
        async requestVideoJson(input) { calls.push(input); return { status: "observed", httpStatus: 200, payload: { id: "id/original", object: "video", status: calls.length === 1 ? "queued" : "completed" } }; },
        async requestVideoContent(input) { calls.push(input); return { status: "unknown", httpStatus: 404, reason: "response_unknown" }; },
    } });
    expect((await adapter.create(binding, { prompt: "test" }, parameters)).status).toBe("accepted");
    expect((await adapter.inspect(binding, "id/original")).status).toBe("completed");
    expect((await adapter.resolveAsset(binding, "id/original")).status).toBe("unknown");
    expect(calls.map(call => [call.method, call.path])).toEqual([["POST", "videos"], ["GET", "videos/id%2Foriginal"], ["GET", "videos/id%2Foriginal/content"]]);
    expect(calls.every(call => call.target.endpoint === binding.endpoint)).toBe(true);
});
