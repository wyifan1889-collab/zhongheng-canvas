import { expect, test } from "bun:test";
import { createDraftClient, type DraftAccountScope, type DraftInput } from "./drafts";

const id = "a1b2c3d4-e5f6-47a8-b9c0-123456abcdef";
const scope = () => ({ accountId: "synthetic-account-A", epoch: 1 });
const input: DraftInput = { title: "合成原始稿", documentVersion: 1, document: { nodes: [{ id: "text-a", content: "合成旧内容" }], connections: [] } };
const current = (draftId = id) => ({
    ...input, title: "已更新的当前云稿", document: { ...input.document, extension: { changed: true } },
    id: draftId, revision: 2, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z",
});
const missing = () => Response.json({ error: { code: "not_found" } }, { status: 404 });

test("after a synthetic refresh only the ID is needed to read revision two, with no reconstructed write", async () => {
    const methods: string[] = [];
    // Scope ends with the old client/intent/document discarded. Only an ID is carried across.
    const creationId = await (async () => {
        const oldClient = createDraftClient(scope, (async (_path, options) => {
            methods.push(options!.method!);
            throw new Error("synthetic response lost after commit");
        }) as typeof fetch);
        const oldIntent = oldClient.prepareCreate(structuredClone(input));
        await expect(oldIntent.submit()).rejects.toMatchObject({ outcome: "unknown", creationId: oldIntent.id });
        return oldIntent.id;
    })();
    const refreshedClient = createDraftClient(() => ({ ...scope(), epoch: 2 }), (async (path, options) => {
        methods.push(options!.method!);
        expect(path).toBe(`/api/v1/canvases/${creationId}`);
        expect(options!.body).toBeUndefined();
        expect(options!.credentials).toBe("same-origin");
        expect(options!.cache).toBe("no-store");
        expect(options!.redirect).toBe("error");
        expect(new Headers(options!.headers).get("x-canvas-account-id")).toBe(scope().accountId);
        return Response.json({ draft: current(creationId) });
    }) as typeof fetch);
    const reference = refreshedClient.recoverCreate(creationId.toUpperCase());
    expect(methods).toEqual(["POST"]);
    expect(reference.id).toBe(creationId);
    expect(Object.isFrozen(reference)).toBe(true);
    expect(Object.keys(reference).sort()).toEqual(["id", "reconcile"]);
    const checked = await reference.reconcile();
    expect(checked).toEqual({ status: "found-current", draft: current(creationId) });
    expect(checked).not.toHaveProperty("saved");
    expect(methods).toEqual(["POST", "GET"]);
});

test("a known 404 only reports not-found-yet and never creates a replacement", async () => {
    const methods: string[] = [];
    const client = createDraftClient(scope, (async (_path, options) => { methods.push(options!.method!); return missing(); }) as typeof fetch);
    const reference = client.recoverCreate(id);
    expect(methods).toEqual([]);
    expect(await reference.reconcile()).toEqual({ status: "not-found-yet" });
    expect(reference).not.toHaveProperty("submit");
    expect(reference).not.toHaveProperty("create");
    expect(reference).not.toHaveProperty("save");
    expect(methods).toEqual(["GET"]);
});

test("invalid IDs and unavailable account scope are refused without I/O", () => {
    let calls = 0;
    const fetcher = (async () => { calls++; throw new Error("must not send"); }) as typeof fetch;
    const client = createDraftClient(scope, fetcher);
    for (const invalid of ["", "local-nanoid", "../session", "//untrusted.example", `${id}?ownerId=other`, ` ${id}`, null, 42]) {
        expect(() => client.recoverCreate(invalid as string)).toThrow(expect.objectContaining({ code: "invalid_input", outcome: "not-sent" }));
    }
    expect(() => createDraftClient(() => null, fetcher).recoverCreate(id)).toThrow(expect.objectContaining({ code: "account_changed", outcome: "not-sent" }));
    expect(calls).toBe(0);
});

test("references and original intents cannot be rebound after account or epoch changes", async () => {
    for (const next of [null, { accountId: "synthetic-account-B", epoch: 2 }, { ...scope(), epoch: 2 }]) {
        let active: DraftAccountScope | null = scope(), calls = 0;
        const client = createDraftClient(() => active, (async () => { calls++; throw new Error("must not send"); }) as typeof fetch);
        const reference = client.recoverCreate(id);
        const intent = client.prepareCreate(structuredClone(input));
        active = next;
        expect(() => client.recoverCreate(id)).toThrow(expect.objectContaining({ code: "account_changed", outcome: "not-sent" }));
        await expect(reference.reconcile()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
        await expect(intent.reconcile()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
        await expect(intent.submit()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
        active = scope();
        await expect(reference.reconcile()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
        expect(calls).toBe(0);
    }
});

test("401 and account refusals invalidate the read reference instead of claiming absence", async () => {
    for (const [status, code] of [[401, "unauthorized"], [409, "account_changed"], [400, "account_context_required"]] as const) {
        let calls = 0;
        const client = createDraftClient(scope, (async () => { calls++; return Response.json({ error: { code } }, { status }); }) as typeof fetch);
        const reference = client.recoverCreate(id);
        await expect(reference.reconcile()).rejects.toMatchObject({ code, status, outcome: "rejected" });
        await expect(reference.reconcile()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
        expect(calls).toBe(1);
    }
});

test("late 404 and successful responses from an expired account lifetime are discarded", async () => {
    for (const response of [missing(), Response.json({ draft: current() })]) {
        let active = scope(), calls = 0;
        let finish!: (response: Response) => void;
        const client = createDraftClient(() => active, (async () => {
            calls++;
            return new Promise<Response>((resolve) => { finish = resolve; });
        }) as typeof fetch);
        const reference = client.recoverCreate(id);
        const pending = reference.reconcile().then((value) => ({ value }), (error) => ({ error }));
        active = { ...scope(), epoch: 2 };
        finish(response);
        expect(await pending).toMatchObject({ error: { code: "account_changed", outcome: "unknown" } });
        await expect(reference.reconcile()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
        expect(calls).toBe(1);
    }
});

test("server failures, foreign IDs and malformed responses never become found or not-found-yet", async () => {
    for (const respond of [
        () => { throw new Error("synthetic-private-network"); },
        () => Response.json({ error: { code: "service_unavailable" } }, { status: 503 }),
        () => Response.json({ error: { code: "not_found" } }, { status: 500 }),
        () => new Response("synthetic-private-html", { status: 404 }),
        () => Response.json({ error: { code: "other" } }, { status: 404 }),
        () => Response.json({ draft: current(crypto.randomUUID()) }),
        () => Response.json({ draft: { ...current(), revision: 0 } }),
    ]) {
        let calls = 0;
        const reference = createDraftClient(scope, (async () => { calls++; return respond(); }) as typeof fetch).recoverCreate(id);
        const error = await reference.reconcile().catch((failure) => failure);
        expect(error).toMatchObject({ code: "unavailable", outcome: "unknown" });
        expect(String(error)).not.toContain("synthetic-private");
        expect(calls).toBe(1);
    }
});
