import { expect, test } from "bun:test";
import { createDraftClient, type DraftAccountScope, type DraftInput } from "./drafts";

const scope = () => ({ accountId: "synthetic-A", epoch: 1 });
const input = (): DraftInput => ({
    title: "合成原版画布", documentVersion: 1,
    document: {
        id: "original-local-nanoid", title: "合成原版画布", createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z",
        nodes: ["text", "image", "video", "audio"].map((type) => ({ id: type, type, position: { x: 0, y: 0 }, width: 300, height: 200, metadata: { content: "" } })),
        connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
        plugin: { custom: [true, null, 3] },
    },
});
const saved = (id: string, value = input(), revision = 1) => ({ ...value, id, revision, createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z" });

test("preparing is I/O-free, snapshots the complete project and keeps cloud ID separate from document.id", async () => {
    const calls: { path: string; body: any }[] = [];
    const client = createDraftClient(scope, (async (path, options) => {
        const body = JSON.parse(String(options?.body));
        calls.push({ path: String(path), body });
        const { creationId, ...value } = body;
        return Response.json({ draft: saved(creationId, value) });
    }) as typeof fetch);
    const local = input(), before = structuredClone(local);
    const intent = client.prepareCreate(local);
    expect(calls).toHaveLength(0);
    expect(intent.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.keys(intent).sort()).toEqual(["id", "reconcile", "submit"]);
    expect(Object.isFrozen(intent)).toBe(true);
    expect(local).toEqual(before);
    local.title = "准备后继续编辑";
    local.document.nodes = [];
    local.document.plugin = { custom: "new" };
    const results = await Promise.all([intent.submit(), intent.submit()]);
    expect(calls.map((call) => call.body)).toEqual([{ ...before, creationId: intent.id }, { ...before, creationId: intent.id }]);
    expect(results[0].document).toEqual(before.document);
    expect(results[1].id).toBe(intent.id);
    expect(results[0].document.id).toBe("original-local-nanoid");
    expect(local.document.nodes).toEqual([]);
});

test("lost create response can be checked by exact ID without automatically writing again", async () => {
    const methods: string[] = [], paths: string[] = [];
    let cloudId = "";
    const client = createDraftClient(scope, (async (path, options) => {
        methods.push(options!.method!); paths.push(String(path));
        if (options!.method === "POST") {
            cloudId = JSON.parse(String(options!.body)).creationId;
            if (methods.length === 1) throw new Error("synthetic response lost after commit");
            return Response.json({ error: { code: "creation_exists", message: "private details" } }, { status: 409 });
        }
        return Response.json({ draft: saved(cloudId, { ...input(), title: "云端已经更新" }, 2) });
    }) as typeof fetch);
    const intent = client.prepareCreate(input());
    await expect(intent.submit()).rejects.toMatchObject({ outcome: "unknown", creationId: intent.id });
    expect(methods).toEqual(["POST"]);
    const checked = await intent.reconcile();
    expect(checked).toMatchObject({ status: "found-current", draft: { id: intent.id, revision: 2, title: "云端已经更新" } });
    expect(checked).not.toHaveProperty("saved");
    expect(methods).toEqual(["POST", "GET"]);
    expect(paths[1]).toBe(`/api/v1/canvases/${intent.id}`);
    const refused = await intent.submit().catch((error) => error);
    expect(refused).toMatchObject({ outcome: "rejected", code: "creation_exists", creationId: intent.id });
    expect(String(refused)).not.toContain("private");
    expect(methods).toEqual(["POST", "GET", "POST"]);
});

test("404 while creation is still in flight means not-found-yet, never safe to mint another ID", async () => {
    let finish!: (response: Response) => void;
    let committed = false;
    const methods: string[] = [];
    const client = createDraftClient(scope, (async (path, options) => {
        methods.push(options!.method!);
        if (options!.method === "POST") return new Promise<Response>((resolve) => { finish = resolve; });
        return committed ? Response.json({ draft: saved(String(path).split("/").at(-1)!) })
            : Response.json({ error: { code: "not_found" } }, { status: 404 });
    }) as typeof fetch);
    const intent = client.prepareCreate(input());
    const pending = intent.submit();
    expect(await intent.reconcile()).toEqual({ status: "not-found-yet" });
    expect(methods).toEqual(["POST", "GET"]);
    committed = true;
    finish(Response.json({ draft: saved(intent.id) }));
    expect((await pending).id).toBe(intent.id);
    expect(await intent.reconcile()).toMatchObject({ status: "found-current", draft: { id: intent.id } });
    expect(methods).toEqual(["POST", "GET", "GET"]);
});

test("read errors, foreign responses and malformed successes are not treated as absence or saved", async () => {
    for (const respond of [
        () => { throw new Error("private"); },
        () => Response.json({ error: { code: "service_unavailable" } }, { status: 503 }),
        () => Response.json({ error: { code: "not_found" } }, { status: 500 }),
        () => Response.json({ draft: saved(crypto.randomUUID()) }),
    ]) {
        let calls = 0;
        const client = createDraftClient(scope, (async () => { calls++; return respond(); }) as typeof fetch);
        await expect(client.prepareCreate(input()).reconcile()).rejects.toMatchObject({ code: "unavailable", outcome: "unknown" });
        expect(calls).toBe(1);
    }
});

test("prepared intents never submit or read after account/epoch changes", async () => {
    for (const next of [null, { accountId: "synthetic-B", epoch: 2 }, { ...scope(), epoch: 3 }]) {
        let current: DraftAccountScope | null = scope(), calls = 0;
        const client = createDraftClient(() => current, (async () => { calls++; throw new Error("must not send"); }) as typeof fetch);
        const intent = client.prepareCreate(input());
        current = next;
        await expect(intent.submit()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent", creationId: intent.id });
        await expect(intent.reconcile()).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
        current = scope();
        await expect(intent.submit()).rejects.toMatchObject({ outcome: "not-sent" });
        expect(calls).toBe(0);
    }
});

test("an account switch while reconciling discards even a definitive 404", async () => {
    let current = scope();
    let finish!: (response: Response) => void;
    const client = createDraftClient(() => current, (async () => new Promise<Response>((resolve) => { finish = resolve; })) as typeof fetch);
    const intent = client.prepareCreate(input());
    const pending = intent.reconcile().then(() => null, (error) => error);
    current = { accountId: "synthetic-B", epoch: 2 };
    finish(Response.json({ error: { code: "not_found" } }, { status: 404 }));
    expect(await pending).toMatchObject({ code: "account_changed", outcome: "unknown" });
});

test("one-shot create exposes its stable ID on an unknown outcome, with no automatic recovery", async () => {
    let calls = 0, creationId = "";
    const client = createDraftClient(scope, (async (_path, options) => {
        calls++; creationId = JSON.parse(String(options!.body)).creationId;
        throw new Error("synthetic loss");
    }) as typeof fetch);
    const error = await client.create(input()).catch((failure) => failure);
    expect(error).toMatchObject({ outcome: "unknown", creationId });
    expect(creationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls).toBe(1);
});

test("prepare refuses lossy JSON or unavailable scope before allocating a usable intent", () => {
    let calls = 0;
    const client = createDraftClient(scope, (async () => { calls++; throw new Error("must not send"); }) as typeof fetch);
    const local = input();
    Object.assign(local.document, { extension: undefined });
    expect(() => client.prepareCreate(local)).toThrow(expect.objectContaining({ code: "invalid_input", outcome: "not-sent" }));
    expect(() => createDraftClient(() => null).prepareCreate(input())).toThrow(expect.objectContaining({ code: "account_changed", outcome: "not-sent" }));
    expect(calls).toBe(0);
});
