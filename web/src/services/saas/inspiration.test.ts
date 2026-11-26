import { expect, test } from "bun:test";
import { createAdminInspirationClient, fetchPublicInspirations, InspirationServiceError, type InspirationItem, type InspirationWrite } from "./inspiration";
import type { DraftAccountScope } from "./drafts";

const admin = (): DraftAccountScope => ({ accountId: "synthetic-inspiration-admin", epoch: 3 });
const item = (patch: Partial<InspirationItem> = {}): InspirationItem => ({ id: "sample-1", type: "image", title: "公开金色海报", prompt: "完整提示词 & + # @图片1\n下一行", imageUrl: "https://public.example/cover.png", tags: ["金属", "包装"], ...patch });
const write = (items = [item()]): InspirationWrite => ({ expectedRevision: 4, items });
function fetcher(run: (path: string, init?: RequestInit) => Promise<Response>): typeof fetch {
    return Object.assign((input: RequestInfo | URL, init?: RequestInit) => run(String(input), init), { preconnect: fetch.preconnect });
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test("public GET omits credentials and account headers and returns only the six catalog fields", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const rows = [item(), item({ id: "sample-audio", type: "audio", imageUrl: "/inspiration-assets/covers/audio.png", tags: [] })];
    const result = await fetchPublicInspirations(undefined, fetcher(async (path, init) => { calls.push({ path, init }); return Response.json({ items: rows, revision: 88, requestId: "public-request", ownerId: "must-not-escape" }); }));
    expect(result).toEqual(rows); expect(result.map(row => Object.keys(row).sort())).toEqual(rows.map(() => ["id", "imageUrl", "prompt", "tags", "title", "type"]));
    expect(JSON.stringify(result)).not.toContain("must-not-escape"); expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: "/api/v1/inspiration/items", init: { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" } });
    expect(calls[0].init?.body).toBeUndefined();
    const headers = new Headers(calls[0].init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    for (const name of ["x-canvas-account-id", "authorization", "cookie", "content-type"]) expect(headers.has(name)).toBe(false);
});

test("public malformed catalogs and failed reads do not leak fields or retry", async () => {
    const responses = [
        () => Response.json({ items: [{ ...item(), userId: "private-field" }] }),
        () => Response.json({ items: [item(), item()] }),
        () => Response.json({ items: [{ ...item(), type: "text" }] }),
        () => Response.json({ items: {} }),
        () => new Response("private-upstream-body", { status: 502 }),
        () => new Response("{", { headers: { "content-type": "application/json" } }),
        () => { throw new Error("private-network-detail"); },
    ];
    for (const response of responses) {
        let calls = 0;
        const error = await fetchPublicInspirations(undefined, fetcher(async () => { calls++; return response(); })).catch(error => error);
        expect(error).toBeInstanceOf(InspirationServiceError); expect(error).toMatchObject({ code: "unconfirmed", outcome: "not-sent" });
        expect(error.message).not.toContain("private"); expect(calls).toBe(1);
    }
});

test("public cancellation propagates the supplied signal and does not retry", async () => {
    const controller = new AbortController(); let calls = 0, observed: AbortSignal | undefined;
    const reading = fetchPublicInspirations(controller.signal, fetcher(async (_path, init) => {
        calls++; observed = init?.signal ?? undefined;
        return await new Promise<never>((_, reject) => observed?.addEventListener("abort", () => reject(new DOMException("abort", "AbortError")), { once: true }));
    }));
    controller.abort();
    await expect(reading).rejects.toMatchObject({ outcome: "not-sent" }); expect(observed?.aborted).toBe(true); expect(calls).toBe(1);
});

test("admin GET and PUT use exact same-origin routes, scoped headers and the complete CAS body", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const client = createAdminInspirationClient(admin, fetcher(async (path, init) => {
        calls.push({ path, init });
        return Response.json({ revision: init?.method === "PUT" ? 5 : 4, items: [item()], requestId: "admin-request", internalPath: "discard" });
    }));
    expect(await client.read()).toEqual({ revision: 4, items: [item()] });
    expect(await client.save(write())).toEqual({ revision: 5, items: [item()] });
    expect(calls.map(call => [call.path, call.init?.method])).toEqual([["/api/v1/admin/inspiration/items", "GET"], ["/api/v1/admin/inspiration/items", "PUT"]]);
    expect(calls[0].init?.body).toBeUndefined(); expect(JSON.parse(String(calls[1].init?.body))).toEqual(write());
    for (const { init } of calls) {
        expect(init).toMatchObject({ credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
        expect(new Headers(init?.headers).get("x-canvas-account-id")).toBe(admin().accountId);
        expect(new Headers(init?.headers).has("authorization")).toBe(false);
    }
    expect(new Headers(calls[1].init?.headers).get("content-type")).toBe("application/json");
});

test("save snapshots all caller-owned fields and an empty list explicitly withdraws the catalog", async () => {
    const held = deferred<Response>(); let sent: RequestInit | undefined, calls = 0;
    const client = createAdminInspirationClient(admin, fetcher(async (_path, init) => { calls++; sent = init; return held.promise; }));
    const input = write(), expected = structuredClone(input), saving = client.save(input);
    input.expectedRevision = 99; input.items[0].title = "later edit"; input.items[0].tags.push("later-tag"); input.items.push(item({ id: "second" }));
    expect(JSON.parse(String(sent?.body))).toEqual(expected);
    held.resolve(Response.json({ revision: expected.expectedRevision + 1, items: expected.items }));
    expect(await saving).toEqual({ revision: 5, items: expected.items }); expect(calls).toBe(1);
    const empty = createAdminInspirationClient(admin, fetcher(async (_path, init) => { expect(JSON.parse(String(init?.body))).toEqual({ expectedRevision: 4, items: [] }); return Response.json({ revision: 5, items: [] }); }));
    expect(await empty.save(write([]))).toEqual({ revision: 5, items: [] });
});

test("invalid revisions, IDs, types, duplicate IDs and extra fields are refused before sending", async () => {
    let calls = 0; const client = createAdminInspirationClient(admin, fetcher(async () => { calls++; return Response.json({}); }));
    const invalids: unknown[] = [null, {}, { expectedRevision: -1, items: [] }, { expectedRevision: 0.5, items: [] }, { expectedRevision: Number.MAX_SAFE_INTEGER + 1, items: [] }, { ...write(), ignored: true },
        ...["", "  ", " padded", "padded ", 3, null].map(id => write([{ ...item(), id } as InspirationItem])),
        ...["text", "agent", "IMAGE", null, 1].map(type => write([{ ...item(), type } as InspirationItem])),
        write([item(), item()]), write([{ ...item(), extra: "ignored" } as InspirationItem]), write([item({ title: "\t" })]), write([item({ prompt: "\n " })]), write([item({ tags: [" "] })]),
    ];
    for (const input of invalids) await expect(client.save(input as InspirationWrite)).rejects.toMatchObject({ code: "invalid_input", outcome: "not-sent" });
    expect(calls).toBe(0);
});

test("dangerous URL schemes, credentials, private media and non-canonical public asset paths never send", async () => {
    let calls = 0; const client = createAdminInspirationClient(admin, fetcher(async () => { calls++; return Response.json({}); }));
    const urls = ["http://public.example/a.png", "javascript:alert(1)", "data:image/png;base64,AAA", "blob:https://public.example/id", "file:///private/a.png", "https://user:password@public.example/a.png", " https://public.example/a.png", "https://public.example/a b.png", "https://public.example\\private/a.png", "/api/v1/media/private-id", "https://public.example/api/v1/media/private-id", "https://public.example/API/V1/MEDIA/private-id", "/inspiration-assets/../private.png", "/inspiration-assets/a/./b.png", "/inspiration-assets/a%2fprivate.png", "/inspiration-assets/a.png?token=private", "/inspiration-assets/a.png#private"];
    for (const imageUrl of urls) await expect(client.save(write([item({ imageUrl })]))).rejects.toMatchObject({ code: "invalid_input", outcome: "not-sent" });
    expect(calls).toBe(0);
});

test("HTTPS covers require an explicit authority for both publishing and public rendering", async () => {
    let puts = 0;
    const client = createAdminInspirationClient(admin, fetcher(async () => { puts++; return Response.json({}); }));
    for (const imageUrl of ["https:public.example/a.png", "https:/public.example/a.png", "https:///public.example/a.png"]) {
        await expect(client.save(write([item({ imageUrl })]))).rejects.toMatchObject({ code: "invalid_input", outcome: "not-sent" });
        await expect(fetchPublicInspirations(undefined, fetcher(async () => Response.json({ items: [item({ imageUrl })] })))).rejects.toMatchObject({ code: "unconfirmed", outcome: "not-sent" });
    }
    expect(puts).toBe(0);
});

test("HTTPS local, private, metadata and reserved hosts are refused by the same public-cover rule", async () => {
    let calls = 0; const client = createAdminInspirationClient(admin, fetcher(async (_path, init) => { calls++; const input = JSON.parse(String(init?.body)); return Response.json({ revision: input.expectedRevision + 1, items: input.items }); }));
    for (const imageUrl of ["https://127.0.0.1/a.png", "https://127.1/a.png", "https://2130706433/a.png", "https://0x7f000001/a.png", "https://0177.0.0.1/a.png", "https://localhost/a.png", "https://LOCALHOST./a.png", "https://10.0.0.1/a.png", "https://172.16.0.1/a.png", "https://192.168.1.2/a.png", "https://100.64.0.1/a.png", "https://198.18.0.1/a.png", "https://224.0.0.1/a.png", "https://169.254.169.254/latest/meta-data", "https://[::1]/a.png", "https://[::ffff:127.0.0.1]/a.png", "https://[fc00::1]/a.png", "https://[fe80::1]/a.png", "https://[fd00:ec2::fe]/a.png", "https://0.0.0.0/a.png", "https://metadata.google.internal/a.png", "https://metadata.azure.com/a.png", "https://instance-data.ec2.internal/a.png", "https://server.local/a.png", "https://single-label/a.png"]) {
        await expect(client.save(write([item({ imageUrl })]))).rejects.toMatchObject({ code: "invalid_input", outcome: "not-sent" });
    }
    expect(calls).toBe(0);
});

test("canonical public assets, empty tags and complete large fields are not truncated or given new limits", async () => {
    const row = item({ title: " title kept ", prompt: "完整提示词".repeat(10_000), imageUrl: "/inspiration-assets/covers/public-cover_1.png", tags: [] });
    const client = createAdminInspirationClient(admin, fetcher(async (_path, init) => { const input = JSON.parse(String(init?.body)); return Response.json({ revision: input.expectedRevision + 1, items: input.items }); }));
    const result = await client.save(write([row])); expect(result.items).toEqual([row]); expect(result.items[0].prompt.length).toBe(row.prompt.length);
    for (const imageUrl of ["https://public.example/a.png?version=1#cover", "https://8.8.8.8/a.png", "https://[2606:4700:4700::1111]/a.png", "https://[::ffff:8.8.8.8]/a.png"]) {
        const publicRow = item({ imageUrl }); expect((await client.save(write([publicRow]))).items).toEqual([publicRow]);
    }
});

test("account replacement, logout and epoch mutation before a call invalidate the bound admin client", async () => {
    for (const next of [null, { accountId: "another-admin", epoch: 3 }, { ...admin(), epoch: 4 }]) {
        let current: DraftAccountScope | null = admin(), calls = 0;
        const client = createAdminInspirationClient(() => current, fetcher(async () => { calls++; return Response.json({ revision: 4, items: [] }); }));
        current = next;
        await expect(client.read()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
        await expect(client.save(write())).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
        current = admin(); await expect(client.read()).rejects.toMatchObject({ code: "account_changed" }); expect(calls).toBe(0);
    }
});

test("a mutable original scope cannot rewrite the client's captured epoch", async () => {
    const current = admin(); let calls = 0;
    const client = createAdminInspirationClient(() => current, fetcher(async () => { calls++; return Response.json({ revision: 4, items: [] }); }));
    current.epoch++;
    await expect(client.read()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" }); expect(calls).toBe(0);
});

test.each(["read", "save"] as const)("scope changes while %s is in flight reject late content and do not revive on restoration", async command => {
    const held = deferred<Response>(); let current: DraftAccountScope | null = admin(), calls = 0;
    const client = createAdminInspirationClient(() => current, fetcher(async () => { calls++; return held.promise; }));
    const pending = command === "read" ? client.read() : client.save(write()); current = { ...admin(), epoch: 4 };
    held.resolve(Response.json({ revision: command === "read" ? 4 : 5, items: [item()] }));
    await expect(pending).rejects.toMatchObject({ code: "account_changed", outcome: command === "read" ? "not-sent" : "unknown" });
    current = admin(); await expect(client.read()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" }); expect(calls).toBe(1);
});

test("successful PUT must confirm the exact next revision, full list, fields and order", async () => {
    const input = write([item(), item({ id: "second", type: "video" })]);
    const responses: unknown[] = [{ revision: 4, items: input.items }, { revision: 6, items: input.items }, { revision: 5, items: [] }, { revision: 5, items: [...input.items].reverse() }, ...["title", "prompt", "imageUrl", "tags"].map(field => ({ revision: 5, items: [{ ...item(), [field]: field === "tags" ? ["changed"] : "changed" }, input.items[1]] })), { revision: 5, items: [{ ...item(), private: "leak" }, input.items[1]] }];
    for (const response of responses) {
        let calls = 0; const client = createAdminInspirationClient(admin, fetcher(async () => { calls++; return Response.json(response); }));
        await expect(client.save(input)).rejects.toMatchObject({ code: "unconfirmed", outcome: "unknown" }); expect(calls).toBe(1);
    }
});

test("409 conflict/busy and other recognized rejection codes use safe messages without resending", async () => {
    for (const [status, code] of [[409, "inspiration_revision_conflict"], [409, "inspiration_busy"], [400, "invalid_input"], [429, "rate_limited"], [413, "payload_too_large"], [503, "inspiration_unavailable"]] as const) {
        let calls = 0; const client = createAdminInspirationClient(admin, fetcher(async () => { calls++; return Response.json({ error: { code, message: "private-server-detail" }, currentRevision: 99 }, { status }); }));
        const error = await client.save(write()).catch(error => error);
        expect(error).toMatchObject({ code, status, outcome: "rejected" }); expect(error.message).not.toContain("private"); expect(calls).toBe(1);
    }
});

test("authentication or role rejection permanently invalidates the current admin client", async () => {
    for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [400, "account_context_required"], [409, "account_changed"]] as const) {
        let calls = 0; const client = createAdminInspirationClient(admin, fetcher(async () => { calls++; return Response.json({ error: { code } }, { status }); }));
        await expect(client.save(write())).rejects.toMatchObject({ code, outcome: "rejected" });
        await expect(client.read()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" }); expect(calls).toBe(1);
    }
});

test("unrecognized 5xx, proxy responses, malformed JSON and network failures keep PUT unknown without retries", async () => {
    const responses = [() => Response.json({ error: { code: "service_unavailable", message: "private-file-path" } }, { status: 503 }), () => Response.json({ error: { code: "db_error" } }, { status: 500 }), () => new Response("private-proxy-error", { status: 502, headers: { "content-type": "text/plain" } }), () => new Response("{", { headers: { "content-type": "application/json" } }), () => Response.json({}), () => { throw new Error("private-network-address"); }];
    for (const response of responses) {
        let calls = 0; const client = createAdminInspirationClient(admin, fetcher(async () => { calls++; return response(); }));
        const error = await client.save(write()).catch(error => error);
        expect(error).toMatchObject({ code: "unconfirmed", outcome: "unknown" }); expect(error.message).not.toContain("private"); expect(calls).toBe(1);
    }
});

test("HTTP status must match a known rejection code before treating the write as explicitly refused", async () => {
    let calls = 0; const client = createAdminInspirationClient(admin, fetcher(async () => { calls++; return Response.json({ error: { code: "inspiration_revision_conflict" } }, { status: 500 }); }));
    await expect(client.save(write())).rejects.toMatchObject({ code: "unconfirmed", outcome: "unknown" }); expect(calls).toBe(1);
});

test.each([false, true])("the request deadline covers stalled %s headers/body and aborts without retry", async receivedHeaders => {
    let calls = 0, aborted = false;
    const client = createAdminInspirationClient(admin, fetcher(async (_path, init) => {
        calls++;
        const stalled = () => new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); }, { once: true }));
        if (!receivedHeaders) return await stalled();
        const response = Response.json({}); response.json = stalled; return response;
    }), { requestTimeoutMs: 5 });
    await expect(client.save(write())).rejects.toMatchObject({ code: "unconfirmed", outcome: "unknown" }); expect(aborted).toBe(true); expect(calls).toBe(1);
});
