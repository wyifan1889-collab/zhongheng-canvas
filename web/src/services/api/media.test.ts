import { describe, expect, test } from "bun:test";
import { CloudMediaError, createMediaClient } from "./media";

const media = { id: "00000000-0000-4000-8000-000000000001", kind: "image", contentType: "image/png", sizeBytes: 3, createdAt: "2026-10-07T00:00:00.000Z", url: "/api/v1/media/00000000-0000-4000-8000-000000000001" } as const;
const quota = { quotaBytes: 1024, usedBytes: 3, availableBytes: 1021 };

test("canvas scope is carried by both private read URLs and never changes upload/list/delete ownership", async () => {
    const canvasId = "10000000-0000-4000-8000-000000000001", calls: Request[] = [];
    const client = createMediaClient(() => "actual-editor", async (input, init) => {
        const request = new Request(new URL(String(input), "http://localhost"), init); calls.push(request);
        if (request.url.includes("/resolve")) return Response.json({ items: [media], missing: [] });
        if (request.url.includes(`/${media.id}`) && request.method === "GET") return new Response("abc", { headers: { "content-type": "image/png" } });
        return Response.json({ items: [media], media, quota });
    }, { canvasId });
    await client.resolve([media.id]); await client.download(media.id);
    await client.list(); await client.upload(new Blob(["abc"], { type: "image/png" })); await client.remove(media.id);
    expect(calls.map((call) => new URL(call.url).pathname + new URL(call.url).search)).toEqual([
        `/api/v1/media/resolve?canvasId=${canvasId}`, `/api/v1/media/${media.id}?canvasId=${canvasId}`,
        "/api/v1/media", "/api/v1/media", `/api/v1/media/${media.id}`,
    ]);
    expect(await calls[0].json()).toEqual({ ids: [media.id] });
    expect(calls.every((call) => call.headers.get("x-canvas-account-id") === "actual-editor")).toBe(true);
});

test("late JSON and blob bodies are rejected after the bound canvas permission lifetime changes", async () => {
    for (const kind of ["json", "blob"] as const) {
        let current = true, finish!: () => void;
        const wait = new Promise<void>((resolve) => { finish = resolve; });
        const response = Response.json({ items: [media], missing: [] });
        if (kind === "json") response.json = async () => { await wait; return { items: [media], missing: [] }; };
        else response.blob = async () => { await wait; return new Blob(["abc"], { type: "image/png" }); };
        const client = createMediaClient(() => "account-a", async () => response, { isCurrent: () => current });
        const pending = kind === "json" ? client.resolve([media.id]) : client.download(media.id);
        await Promise.resolve(); current = false; finish();
        await expect(pending).rejects.toMatchObject({ code: "account_changed" });
    }
});

describe("cloud media client", () => {
    test("lists and uploads through same-origin account-bound requests", async () => {
        const calls: Request[] = [];
        const client = createMediaClient(() => "account-a", async (input, init) => {
            const request = new Request(new URL(String(input), "http://localhost").toString(), init);
            calls.push(request);
            if (request.method === "POST") return new Response(JSON.stringify({ media, quota }), { headers: { "content-type": "application/json" } });
            return new Response(JSON.stringify({ items: [media], quota }), { headers: { "content-type": "application/json" } });
        });
        expect((await client.list()).items[0]).toEqual(media);
        const uploaded = await client.upload(new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }));
        expect(uploaded.quota).toEqual(quota);
        expect(calls[0].headers.get("x-canvas-account-id")).toBe("account-a");
        expect(calls[1].headers.get("content-type")).toBe("image/png");
        expect(await calls[1].arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
    });

    test("downloads bytes and removes with a validated quota", async () => {
        let next = 0;
        const client = createMediaClient(() => "account-a", async (input) => {
            next++;
            if (next === 1) return new Response(new Uint8Array([9, 8]), { headers: { "content-type": "image/png" } });
            return new Response(JSON.stringify({ ok: true, quota: { quotaBytes: 1024, usedBytes: 0, availableBytes: 1024 } }), { headers: { "content-type": "application/json" } });
        });
        expect([...new Uint8Array(await (await client.download(media.id)).arrayBuffer())]).toEqual([9, 8]);
        expect((await client.remove(media.id)).usedBytes).toBe(0);
    });

    test("resolves only requested account media references and keeps the provider key out of the client contract", async () => {
        let sent: Request | undefined;
        const client = createMediaClient(() => "account-a", async (input, init) => {
            sent = new Request(new URL(String(input), "http://localhost").toString(), init);
            return new Response(JSON.stringify({ items: [media], missing: ["00000000-0000-4000-8000-000000000002"] }), { headers: { "content-type": "application/json" } });
        });
        const result = await client.resolve([media.id, "00000000-0000-4000-8000-000000000002"]);
        expect(result.items).toEqual([media]);
        expect(result.missing).toEqual(["00000000-0000-4000-8000-000000000002"]);
        expect(await sent!.json()).toEqual({ ids: [media.id, "00000000-0000-4000-8000-000000000002"] });
        expect(result.items[0]).not.toHaveProperty("objectKey");
    });

    test("maps quota refusal and missing account without transmitting a request", async () => {
        let called = false;
        const missing = createMediaClient(() => null, async () => { called = true; return new Response(); });
        await expect(missing.upload(new Blob(["x"], { type: "image/png" }))).rejects.toMatchObject({ code: "account_changed" });
        expect(called).toBe(false);
        const refused = createMediaClient(() => "account-a", async () => new Response(JSON.stringify({ error: { code: "quota_exceeded" } }), { status: 413, headers: { "content-type": "application/json" } }));
        await expect(refused.upload(new Blob(["x"], { type: "image/png" }))).rejects.toBeInstanceOf(CloudMediaError);
        const referenced = createMediaClient(() => "account-a", async () => new Response(JSON.stringify({ error: { code: "media_referenced" } }), { status: 409, headers: { "content-type": "application/json" } }));
        await expect(referenced.remove(media.id)).rejects.toMatchObject({ code: "media_referenced", status: 409 });
    });
});
