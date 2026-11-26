import { describe, expect, test } from "bun:test";
import { createDraftClient, DraftError, type DraftInput, type DraftAccountScope } from "./drafts";

const id = "10000000-0000-4000-8000-000000000001";
const otherId = "10000000-0000-4000-8000-000000000002";
const scope = () => ({ accountId: "synthetic-account-A", epoch: 1 });
const input: DraftInput = { title: "原版测试项目", documentVersion: 1, document: { nodes: [{ id: "a", metadata: { content: "保留原稿" } }], connections: [] } };
const result = (revision = 1) => ({ id, ...structuredClone(input), revision, createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z" });
const mockFetch = (run: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch =>
    Object.assign(run, { preconnect: fetch.preconnect });

test("shared reads require an explicit, consistent resource access projection while old owner reads remain compatible", async () => {
    for (const role of ["owner", "editor", "viewer"] as const) {
        const access = { role, ownerId: "Case-Sensitive-Owner", readOnly: role === "viewer" };
        const client = createDraftClient(scope, mockFetch(async () => Response.json({ draft: result(), access: { ...access, token: "discard" } })));
        expect(await client.getWithAccess(id)).toEqual({ draft: result(), access });
    }
    for (const access of [undefined, { role: "viewer", ownerId: "owner", readOnly: false }, { role: "admin", ownerId: "owner", readOnly: false }, { role: "editor", ownerId: "", readOnly: false }]) {
        const client = createDraftClient(scope, mockFetch(async () => Response.json({ draft: result(), access })));
        await expect(client.getWithAccess(id)).rejects.toMatchObject({ code: "unavailable" });
        expect(await client.get(id)).toEqual(result());
    }
});

test("resource permission refusals are definite and never interpreted as a writable role", async () => {
    const client = createDraftClient(scope, mockFetch(async () => Response.json({ error: { code: "permission_denied" } }, { status: 403 })));
    await expect(client.save(id, { ...input, expectedRevision: 1 })).rejects.toMatchObject({ code: "permission_denied", outcome: "rejected" });
});

describe("JSON draft transport (synthetic fetch; not complete cloud canvas sync)", () => {
    test("uses fixed same-origin routes, cookie transport and strict payload projection", async () => {
        const calls: { path: string; options: RequestInit }[] = [];
        const client = createDraftClient(scope, mockFetch(async (path, options) => {
            calls.push({ path: String(path), options: options! });
            if (String(path).includes("?")) return Response.json({ items: [{ ...result(), ownerId: "discard", token: "discard" }], nextCursor: "next" });
            const creationId = options?.method === "POST" ? JSON.parse(String(options.body)).creationId : id;
            return Response.json({ draft: { ...result(options?.method === "PUT" ? 2 : 1), id: creationId, ownerId: "discard", token: "discard" }, secret: "discard" });
        }));
        const page = await client.list({ limit: 2, cursor: "abc+/?=&" });
        expect(page.items).toEqual([{ id, title: input.title, revision: 1, createdAt: result().createdAt, updatedAt: result().updatedAt }]);
        expect(page.nextCursor).toBe("next");
        expect(await client.get(id)).toEqual(result());
        const created = await client.create({ ...input, ownerId: "fake", role: "admin" } as DraftInput);
        expect(created).toEqual({ ...result(), id: created.id });
        expect(await client.save(id, { ...input, expectedRevision: 1 })).toEqual(result(2));
        expect(calls.map((call) => call.path)).toEqual([
            "/api/v1/canvases?limit=2&cursor=abc%2B%2F%3F%3D%26", `/api/v1/canvases/${id}`, "/api/v1/canvases", `/api/v1/canvases/${id}`,
        ]);
        expect(calls.map((call) => call.options.method)).toEqual(["GET", "GET", "POST", "PUT"]);
        for (const { options } of calls) {
            expect(options.credentials).toBe("same-origin");
            expect(options.redirect).toBe("error");
            expect(options.cache).toBe("no-store");
            expect(options.referrerPolicy).toBe("no-referrer");
            expect(new Headers(options.headers).has("authorization")).toBe(false);
            expect(new Headers(options.headers).get("x-canvas-account-id")).toBe(scope().accountId);
        }
        expect(JSON.parse(String(calls[2].options.body))).toEqual({ ...input, creationId: created.id });
        expect(JSON.parse(String(calls[3].options.body))).toEqual({ ...input, expectedRevision: 1 });
    });

    test("invalid IDs, pagination and versions never make a request", async () => {
        let calls = 0;
        const client = createDraftClient(scope, mockFetch(async () => { calls++; return Response.json({}); }));
        for (const badId of ["../session", "//external.example", "local-nanoid", `${id}?ownerId=other`, ""]) {
            await expect(client.get(badId)).rejects.toMatchObject({ outcome: "not-sent" });
            await expect(client.save(badId, { ...input, expectedRevision: 1 })).rejects.toMatchObject({ outcome: "not-sent" });
        }
        for (const revision of [0, -1, 0.5, NaN, Number.MAX_SAFE_INTEGER]) {
            await expect(client.save(id, { ...input, expectedRevision: revision })).rejects.toMatchObject({ outcome: "not-sent" });
        }
        await expect(client.list({ limit: 0 })).rejects.toMatchObject({ outcome: "not-sent" });
        await expect(client.list({ cursor: "" })).rejects.toMatchObject({ outcome: "not-sent" });
        await expect(client.create({ ...input, documentVersion: 2 } as unknown as DraftInput)).rejects.toMatchObject({ outcome: "not-sent" });
        expect(calls).toBe(0);
    });

    test("rejects lossy JSON before sending instead of stripping data", async () => {
        let calls = 0, getters = 0;
        const client = createDraftClient(scope, mockFetch(async () => { calls++; return Response.json({ draft: result() }); }));
        const cycle: Record<string, unknown> = {}; cycle.self = cycle;
        const accessor = { get content() { getters++; return "secret"; } };
        const hidden = Object.defineProperty({}, "content", { value: "hidden", enumerable: false });
        const customArray: unknown[] & { attachment?: string } = []; customArray.attachment = "lost";
        class RewritingArray extends Array { toJSON() { return []; } }
        for (const value of [undefined, NaN, Infinity, 1n, () => {}, Symbol("x"), new Date(), new Map(), new Blob(["x"]), cycle, accessor, hidden, { [Symbol("x")]: "lost" }, [undefined], new Array(2), customArray, new RewritingArray("would-disappear")]) {
            await expect(client.create({ ...input, document: { value } } as DraftInput)).rejects.toMatchObject({ code: "invalid_input", outcome: "not-sent" });
        }
        expect(calls).toBe(0);
        expect(getters).toBe(0);
    });

    test("a request snapshots content immediately and never mutates the caller", async () => {
        const local = structuredClone(input);
        let payload = "", finish!: (response: Response) => void;
        const client = createDraftClient(scope, mockFetch(async (_path, options) => {
            payload = String(options!.body);
            return await new Promise<Response>((resolve) => { finish = resolve; });
        }));
        const pending = client.create(local);
        local.title = "请求期间继续编辑";
        local.document.nodes = [];
        const { creationId } = JSON.parse(payload);
        expect(JSON.parse(payload)).toEqual({ ...input, creationId });
        finish(Response.json({ draft: { ...result(), id: creationId } }));
        expect(await pending).toEqual({ ...result(), id: creationId });
        expect(local.title).toBe("请求期间继续编辑");
        expect(local.document.nodes).toEqual([]);
    });

    test("conflicts preserve the supplied document and return current revision without a retry", async () => {
        let calls = 0;
        const local = structuredClone(input);
        const client = createDraftClient(scope, mockFetch(async () => { calls++; return Response.json({ error: { code: "revision_conflict", message: "secret" }, currentRevision: 4 }, { status: 409 }); }));
        await expect(client.save(id, { ...local, expectedRevision: 1 })).rejects.toMatchObject({ code: "revision_conflict", status: 409, outcome: "rejected", currentRevision: 4 });
        expect(local).toEqual(input);
        expect(calls).toBe(1);
    });

    test("known refusals are distinct from unknown write outcomes; errors never expose server content", async () => {
        for (const [status, code] of [[400, "invalid_input"], [400, "invalid_cursor"], [400, "account_context_required"], [409, "account_changed"], [401, "unauthorized"], [403, "invalid_origin"], [404, "not_found"], [413, "payload_too_large"], [429, "rate_limited"], [503, "cloud_unavailable"]] as const) {
            const client = createDraftClient(scope, mockFetch(async () => Response.json({ error: { code, message: "secret-body" } }, { status, headers: { "retry-after": "23" } })));
            try { await client.save(id, { ...input, expectedRevision: 1 }); throw new Error("unexpected success"); }
            catch (error) {
                expect(error).toBeInstanceOf(DraftError);
                expect(error).toMatchObject({ status, outcome: "rejected", retryAfter: status === 429 ? 23 : undefined });
                expect(String(error)).not.toContain("secret");
            }
        }
    });

    test("network, HTML, invalid JSON, 5xx and malformed success are unknown and never retried", async () => {
        for (const respond of [
            () => { throw new Error("secret-network"); },
            () => new Response("<html>secret</html>"),
            () => new Response("secret", { headers: { "content-type": "application/json" } }),
            () => Response.json({ error: { code: "service_unavailable", message: "secret" } }, { status: 503 }),
            () => Response.json({ error: { code: "constructor", message: "secret" } }, { status: 401 }),
            () => Response.json({ error: { code: "revision_conflict" }, currentRevision: "secret" }, { status: 409 }),
            () => Response.json({ ok: true }),
            () => Response.json({ draft: { ...result(), documentVersion: 2 } }),
            () => Response.json({ draft: { ...result(), id: otherId } }),
            () => Response.json({ draft: { ...result(), document: [] } }),
            () => Response.json({ draft: result(3) }),
        ]) {
            let calls = 0;
            const client = createDraftClient(scope, mockFetch(async () => { calls++; return respond(); }));
            await expect(client.save(id, { ...input, expectedRevision: 1 })).rejects.toMatchObject({ code: "unavailable", outcome: "unknown" });
            expect(calls).toBe(1);
        }
    });

    test("stalled requests abort and remain an unknown outcome", async () => {
        let aborted = false;
        const client = createDraftClient(scope, mockFetch(async (_path, options) => await new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); }, { once: true });
        })), { requestTimeoutMs: 5 });
        await expect(client.list()).rejects.toMatchObject({ code: "unavailable", outcome: "unknown" });
        expect(aborted).toBe(true);
    });

    test("malformed lists and wrong detail identity cannot be applied as another project", async () => {
        for (const data of [{ items: [{}], nextCursor: null }, { items: [], nextCursor: 2 }, { items: [], nextCursor: "" }, {}]) {
            const client = createDraftClient(scope, mockFetch(async () => Response.json(data)));
            await expect(client.list()).rejects.toMatchObject({ code: "unavailable" });
        }
        const client = createDraftClient(scope, mockFetch(async () => Response.json({ draft: { ...result(), id: otherId } })));
        await expect(client.get(id)).rejects.toMatchObject({ code: "unavailable" });
    });

    test("a stalled response body aborts after headers without resending the save", async () => {
        let calls = 0, receivedHeaders = false;
        let signal: AbortSignal | null | undefined;
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
            fetch: () => new Response(new ReadableStream({ start(controller) {
                controller.enqueue(new TextEncoder().encode('{"draft":'));
            } }), { headers: { "content-type": "application/json" } }),
        });
        const local = structuredClone(input);
        try {
            const client = createDraftClient(scope, mockFetch(async (path, options) => {
                calls++;
                signal = options?.signal;
                const response = await fetch(new URL(String(path), server.url), options);
                receivedHeaders = true;
                return response;
            }), { requestTimeoutMs: 100 });
            await expect(client.save(id, { ...local, expectedRevision: 1 })).rejects.toMatchObject({
                code: "unavailable", status: 200, outcome: "unknown",
            });
            expect(receivedHeaders).toBe(true);
            expect(signal?.aborted).toBe(true);
            expect(calls).toBe(1);
            expect(local).toEqual(input);
        } finally { await server.stop(true); }
    });

    test("a client never adopts a new account or lifetime, including same-account relogin", async () => {
        for (const replacement of [null, { accountId: "account-B", epoch: 1 }, { ...scope(), epoch: 2 }]) {
            let current: DraftAccountScope | null = scope();
            let calls = 0;
            const client = createDraftClient(() => current, mockFetch(async () => { calls++; return Response.json({}); }));
            current = replacement;
            for (const operation of [() => client.list(), () => client.get(id), () => client.create(input), () => client.save(id, { ...input, expectedRevision: 1 })]) {
                await expect(operation()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
            }
            current = scope(); // Even restoring old values cannot revive an invalidated client.
            await expect(client.list()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
            expect(calls).toBe(0);
        }
        let current: DraftAccountScope | null = null;
        const client = createDraftClient(() => current, mockFetch(async () => { throw new Error("must not send"); }));
        current = scope();
        await expect(client.create(input)).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
    });

    test("late success for all operations is discarded after switching account; writes stay unknown", async () => {
        for (const kind of ["list", "get", "create", "save"] as const) {
            let current = scope(), calls = 0;
            let finish!: (response: Response) => void;
            const local = structuredClone(input);
            const client = createDraftClient(() => current, mockFetch(async (_path, options) => {
                calls++;
                expect(new Headers(options?.headers).get("x-canvas-account-id")).toBe(scope().accountId);
                return new Promise<Response>((resolve) => { finish = resolve; });
            }));
            const pending = kind === "list" ? client.list() : kind === "get" ? client.get(id) : kind === "create" ? client.create(local) : client.save(id, { ...local, expectedRevision: 1 });
            const settled = pending.then(() => null, (error: unknown) => error);
            current = { accountId: "account-B", epoch: 2 };
            finish(Response.json(kind === "list" ? { items: [result()], nextCursor: null } : { draft: result(kind === "save" ? 2 : 1) }));
            expect(await settled).toMatchObject({ code: "account_changed", outcome: "unknown" });
            expect(calls).toBe(1);
            expect(local).toEqual(input);
            expect(current).toEqual({ accountId: "account-B", epoch: 2 });
        }
    });

    test("account changes during response-body reading discard the old body", async () => {
        let current = scope();
        let finish!: (value: unknown) => void;
        let bodyStarted!: () => void;
        const started = new Promise<void>((resolve) => { bodyStarted = resolve; });
        const client = createDraftClient(() => current, mockFetch(async () => {
            const response = Response.json({});
            response.json = () => { bodyStarted(); return new Promise((resolve) => { finish = resolve; }); };
            return response;
        }));
        const pending = client.get(id);
        const settled = pending.then(() => null, (error: unknown) => error);
        await started;
        current = { ...scope(), epoch: 3 }; // A → B → A, same final ID but a new lifetime.
        finish({ draft: result() });
        expect(await settled).toMatchObject({ code: "account_changed", outcome: "unknown" });
    });

    test("old failures cannot invalidate a newer account client and no request is replayed", async () => {
        for (const failure of ["network", "unauthorized", "account_changed"] as const) {
            let current = scope(), calls = 0;
            let finish!: (response: Response) => void, fail!: (error: Error) => void;
            const old = createDraftClient(() => current, mockFetch(async () => {
                calls++;
                return new Promise<Response>((resolve, reject) => { finish = resolve; fail = reject; });
            }));
            const pending = old.create(input);
            const settled = pending.then(() => null, (error: unknown) => error);
            current = { accountId: "account-B", epoch: 2 };
            const newer = createDraftClient(() => current, mockFetch(async () => Response.json({ items: [], nextCursor: null })));
            if (failure === "network") fail(new Error("private-network-error"));
            else finish(Response.json({ error: { code: failure } }, { status: failure === "unauthorized" ? 401 : 409 }));
            expect(await settled).toMatchObject({ code: "account_changed", outcome: "unknown" });
            expect(await newer.list()).toEqual({ items: [], nextCursor: null });
            expect(calls).toBe(1);
        }
    });

    test("server session mismatch invalidates the bound client without revealing or adopting another ID", async () => {
        let calls = 0;
        const client = createDraftClient(scope, mockFetch(async () => {
            calls++;
            return Response.json({ error: { code: "account_changed", message: "secret-account-B" } }, { status: 409 });
        }));
        await expect(client.create(input)).rejects.toMatchObject({ code: "account_changed", outcome: "rejected", status: 409 });
        await expect(client.create(input)).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
        expect(calls).toBe(1);
    });
});
