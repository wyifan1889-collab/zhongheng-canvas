import { describe, expect, test } from "bun:test";
import { createProviderGateway, type ProviderTarget } from "../src/provider-gateway";

const model = "gemini-3.8-flash-tts";
const target: ProviderTarget = { providerId: "independent-provider", adapter: "openai-compatible",
    endpoint: "https://provider.example/v1", credential: "server-secret", providerModel: model };
const request = { target, path: "chat/completions", body: { model, messages: [{ role: "user", content: "hello" }], stream: false }, maxBytes: 1024 };
const payload = { model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: "[media](data:audio/wav;base64,UklGRg==)" } }] };
const resolvePublic = async () => ["93.184.216.34"];
const unknown = { status: "unknown", code: "provider_response_unknown", retryable: false };

describe("bounded Chat audio transport", () => {
    test("uses the configured endpoint, one authenticated request, and the exact audio envelope", async () => {
        let calls = 0;
        const gateway = createProviderGateway(async (url, init) => {
            calls++;
            expect(String(url)).toBe("https://provider.example/v1/chat/completions");
            expect(init?.redirect).toBe("error");
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer server-secret");
            expect(new Headers(init?.headers).get("accept")).toBe("application/json");
            expect(JSON.parse(String(init?.body))).toEqual(request.body);
            return Response.json(payload);
        }, resolvePublic);
        expect(await gateway.requestChatAudio(request)).toMatchObject({ status: "succeeded", source: "audio_chat_data_uri", contentType: "audio/wav", body: Buffer.from("RIFF") });
        expect(calls).toBe(1);
    });

    test("rejects private addresses before disclosing the credential", async () => {
        let calls = 0;
        const gateway = createProviderGateway(async () => { calls++; return Response.json(payload); }, async () => ["127.0.0.1"]);
        expect(await gateway.requestChatAudio(request)).toEqual({ status: "failed", code: "provider_invalid_response", requestSent: false });
        expect(calls).toBe(0);
    });

    test("accepts a real fetch-decompressed gzip body while bounding decoded bytes", async () => {
        const compressed = Bun.gzipSync(JSON.stringify(payload));
        const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
            return new Response(compressed, { headers: { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(compressed.length) } });
        } });
        try {
            const gateway = createProviderGateway(async () => fetch(server.url), resolvePublic);
            expect(await gateway.requestChatAudio(request)).toMatchObject({ status: "succeeded", body: Buffer.from("RIFF") });
            const bounded = { ...request, maxBytes: compressed.length };
            expect(JSON.stringify(payload).length).toBeGreaterThan(compressed.length);
            expect(await gateway.requestChatAudio(bounded)).toEqual(unknown);
        } finally { server.stop(true); }
    });

    test("rejects a missing model before any request", async () => {
        let calls = 0;
        const gateway = createProviderGateway(async () => { calls++; return Response.json(payload); }, resolvePublic);
        expect(await gateway.requestChatAudio({ ...request, target: { ...target, providerModel: undefined } }))
            .toEqual({ status: "failed", code: "provider_invalid_response", requestSent: false });
        expect(calls).toBe(0);
    });

    test("bounds the complete encoded response before JSON parsing", async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(1025)); }, cancel() { cancelled = true; } });
        const gateway = createProviderGateway(async () => new Response(body, { headers: { "content-type": "application/json" } }), resolvePublic);
        expect(await gateway.requestChatAudio(request)).toEqual(unknown);
        expect(cancelled).toBe(true);
    });

    test("treats malformed, truncated, mismatched and non-JSON successes as unknown", async () => {
        const cases = [
            new Response("{", { headers: { "content-type": "application/json" } }),
            new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
            Response.json({ ...payload, model: "other-model" }),
            new Response(JSON.stringify(payload), { headers: { "content-type": "text/html" } }),
            new Response(JSON.stringify(payload), { headers: { "content-type": "application/json", "content-length": "999" } }),
        ];
        for (const response of cases) {
            const gateway = createProviderGateway(async () => response, resolvePublic);
            expect(await gateway.requestChatAudio(request)).toEqual(unknown);
        }
    });

    test("keeps explicit rejections failed and server errors unknown without retrying", async () => {
        for (const status of [400, 401, 403, 404, 429, 500, 502]) {
            let calls = 0;
            const gateway = createProviderGateway(async () => { calls++; return new Response("private response", { status }); }, resolvePublic);
            expect(await gateway.requestChatAudio(request)).toEqual(status < 500 ? { status: "failed", code: "provider_rejected" } : unknown);
            expect(calls).toBe(1);
        }
    });
});
