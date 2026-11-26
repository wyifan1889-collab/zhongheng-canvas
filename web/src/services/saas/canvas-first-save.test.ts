import { expect, test } from "bun:test";
import { createCanvasFirstSave, CanvasFirstSaveError, type CanvasFirstSaveContext } from "./canvas-first-save";
import { createReceiptedDraftClient } from "./creation-receipts";
import type { CreationReceipt } from "./creation-receipt-store";
import type { CanvasDraft } from "../../../../packages/shared/src/index";

const context: CanvasFirstSaveContext = { accountId: "synthetic-account-A", epoch: 1, localProjectId: "synthetic-project-A", cloudCanvas: true };
const oldId = "a1b2c3d4-e5f6-47a8-b9c0-123456abcdef";
function project() {
    return {
        id: context.localProjectId, title: "synthetic-private-title", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        nodes: [{ id: "node-1", type: "text", metadata: { content: "synthetic-private-original", errorDetails: undefined } }],
        connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: true, viewport: { x: 0, y: 0, k: 1 },
        extension: { preserved: "https://synthetic.invalid/remote-media", plugin: { value: "synthetic-private-extension" } },
    };
}
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const outcome = <T>(value: Promise<T>) => value.then((result) => ({ result }), (error) => ({ error }));
async function safeError(value: Promise<unknown>, code: string, expectedOutcome?: string) {
    const error = await value.catch((failure) => failure);
    expect(error).toBeInstanceOf(CanvasFirstSaveError);
    expect(error.code).toBe(code);
    if (expectedOutcome) expect(error.outcome).toBe(expectedOutcome);
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("document");
    expect(String(error)).not.toContain("synthetic-private");
    return error as CanvasFirstSaveError;
}
function harness(resolveMedia: (ids: string[]) => Promise<{ items: ReadonlyArray<{ id: string }>; missing: ReadonlyArray<string> }> = async (ids) => ({ items: ids.map((id) => ({ id })), missing: [] })) {
    let active: CanvasFirstSaveContext | null = { ...context }, factories = 0, lists = 0, puts = 0;
    const rows = new Map<string, CreationReceipt>(), drafts = new Map<string, CanvasDraft>();
    const methods: string[] = [], events: string[] = [];
    const hooks: {
        list?: () => Promise<void>;
        put?: () => Promise<void>;
        fetch?: (path: string, options: RequestInit) => Promise<Response>;
    } = {};
    const save = createCanvasFirstSave(() => active, (getScope) => {
        factories++;
        return createReceiptedDraftClient(getScope, {
            async list(accountId, localProjectId) {
                lists++; events.push("list"); await hooks.list?.();
                return [...rows.values()].filter((row) => row.accountId === accountId && row.localProjectId === localProjectId);
            },
            async put(row) {
                puts++; events.push("put-start"); await hooks.put?.();
                rows.set(row.creationId, structuredClone(row)); events.push("put-committed");
            },
        }, (async (path, options) => {
            const method = options!.method!;
            methods.push(method); events.push(method);
            if (hooks.fetch) return hooks.fetch(String(path), options!);
            if (method === "POST") {
                const body = JSON.parse(String(options!.body));
                const draft: CanvasDraft = { ...body, id: body.creationId, revision: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" };
                delete (draft as CanvasDraft & { creationId?: string }).creationId;
                drafts.set(draft.id, draft);
                return Response.json({ draft });
            }
            const draft = drafts.get(String(path).split("/").at(-1)!);
            return draft ? Response.json({ draft }) : Response.json({ error: { code: "not_found" } }, { status: 404 });
        }) as typeof fetch);
    }, () => ({ resolve: resolveMedia }));
    return { save, hooks, rows, drafts, methods, events, setContext: (value: CanvasFirstSaveContext | null) => { active = value; }, stats: () => ({ factories, lists, puts }) };
}

test("constructor and state access have zero I/O; explicit preparation and one submit preserve the full fixed snapshot", async () => {
    const h = harness(), input = project(), listGate = deferred<void>();
    h.hooks.list = () => listGate.promise;
    expect(h.save.getState()).toEqual({ phase: "idle" });
    expect(h.stats()).toEqual({ factories: 0, lists: 0, puts: 0 });
    expect(Object.keys(h.save).sort()).toEqual(["dispose", "getState", "prepare", "reconcile", "submit"]);
    const preparing = h.save.prepare(input);
    expect(h.save.getState()).toEqual({ phase: "preparing", counts: { nodes: 1, connections: 0, chats: 0, localMediaReferences: 0, omittedOptionalFields: 1 } });
    input.title = "edited later"; input.nodes[0].metadata.content = "edited later"; input.extension.plugin.value = "edited later";
    listGate.resolve();
    const prepared = await preparing;
    expect(Object.keys(prepared).sort()).toEqual(["counts", "id"]);
    expect(prepared.counts).toEqual({ nodes: 1, connections: 0, chats: 0, localMediaReferences: 0, omittedOptionalFields: 1 });
    expect(prepared).not.toHaveProperty("mediaComplete");
    expect(h.methods).toEqual([]); expect(h.rows.size).toBe(0);
    const saved = await h.save.submit();
    expect(saved).toEqual({ id: prepared.id, revision: 1, updatedAt: "2026-01-01T00:00:01Z" });
    expect(h.events).toEqual(["list", "put-start", "put-committed", "POST"]);
    expect([...h.rows.values()]).toEqual([{ accountId: context.accountId, localProjectId: context.localProjectId, creationId: prepared.id }]);
    const stored = h.drafts.get(prepared.id)!;
    expect(stored.title).toBe("synthetic-private-title");
    expect(stored.document.nodes).toEqual([{ id: "node-1", type: "text", metadata: { content: "synthetic-private-original" } }]);
    expect(stored.document.extension).toEqual(project().extension);
    expect(h.save.getState()).toEqual({ phase: "submitted", ...prepared });
    expect(JSON.stringify([prepared, saved, h.save.getState(), [...h.rows.values()]])).not.toContain("synthetic-private");
    expect(Object.isFrozen(prepared.counts)).toBe(true);
    expect(input.nodes[0].metadata.content).toBe("edited later");
});

test("disabled, absent or changed context prevents preparation before storage or network", async () => {
    for (const next of [null, { ...context, cloudCanvas: false }, { ...context, cloudCanvas: undefined }, { ...context, cloudCanvas: "true" }, { ...context, epoch: 2 }, { ...context, localProjectId: "other-project" }]) {
        const h = harness(); h.setContext(next as CanvasFirstSaveContext | null);
        const code = next === null || next.epoch !== context.epoch ? "account_changed" : next.localProjectId !== context.localProjectId ? "context_changed" : "cloud_unavailable";
        await safeError(h.save.prepare(project()), code, "not-sent");
        h.setContext({ ...context });
        await safeError(h.save.prepare(project()), code, "not-sent");
        expect(h.stats()).toEqual({ factories: 0, lists: 0, puts: 0 });
        expect(h.methods).toEqual([]); expect(h.save.getState()).toEqual({ phase: "blocked" });
    }
    let active = { ...context, cloudCanvas: false }, factories = 0;
    const save = createCanvasFirstSave(() => active, () => { factories++; throw new Error("must not construct"); });
    active = { ...context };
    await safeError(save.prepare(project()), "cloud_unavailable", "not-sent");
    expect(factories).toBe(0);
});

test("malformed projects and all detected local media fail before receipt access", async () => {
    for (const candidate of [null, {}, { ...project(), id: "other-project" }, { ...project(), extension: { invalid: Number.NaN } }]) {
        const h = harness();
        await safeError(h.save.prepare(candidate), "invalid_project", "not-sent");
        expect(h.stats()).toEqual({ factories: 0, lists: 0, puts: 0 });
        expect(h.methods).toEqual([]);
    }
    for (const content of ["image:local", "video:local", "audio-reference:local", "blob:https://synthetic.invalid/local", "data:image/png;base64,synthetic", "file:///synthetic/local"]) {
        const h = harness(), value = project(); value.nodes[0].metadata.content = content;
        await safeError(h.save.prepare(value), "local_media", "not-sent");
        expect(h.save.getState().counts?.localMediaReferences).toBeGreaterThan(0);
        expect(h.stats()).toEqual({ factories: 0, lists: 0, puts: 0 });
        expect(h.methods).toEqual([]);
    }
    {
        const h = harness(), value = project();
        value.nodes[0].metadata = { content: "", videoTaskId: "video-task-private" };
        await safeError(h.save.prepare(value), "local_media", "not-sent");
        expect(h.save.getState().counts?.localMediaReferences).toBe(1);
        expect(h.stats()).toEqual({ factories: 0, lists: 0, puts: 0 });
    }
    {
        const h = harness(), value = project();
        value.nodes[0].type = "image";
        value.nodes[0].metadata.content = "https://example.invalid/image";
        await safeError(h.save.prepare(value), "local_media", "not-sent");
        expect(h.save.getState().counts?.localMediaReferences).toBe(1);
        expect(h.stats()).toEqual({ factories: 0, lists: 0, puts: 0 });
    }
});

test("owned cloud media references are resolved before the first receipt and save", async () => {
    const cloudMediaId = "11111111-1111-4111-8111-111111111111";
    const calls: string[][] = [], h = harness(async (ids) => { calls.push(ids); return { items: [{ id: cloudMediaId }], missing: [] }; });
    const value = project(); (value.nodes[0].metadata as Record<string, unknown>) = { cloudMediaId };
    const prepared = await h.save.prepare(value);
    expect(prepared.counts.localMediaReferences).toBe(0);
    expect(calls).toEqual([[cloudMediaId]]);
    expect(h.stats()).toEqual({ factories: 1, lists: 1, puts: 0 });
    await h.save.submit();
    expect(h.methods).toEqual(["POST"]);
});

test("first save strips a hydrated preview before sending the cloud document", async () => {
    const cloudMediaId = "11111111-1111-4111-8111-111111111111", h = harness();
    const value = project(); value.nodes[0].type = "image";
    (value.nodes[0].metadata as Record<string, unknown>) = { cloudMediaId, content: "blob:hydrated-preview", storageKey: "image:local-cache" };
    await h.save.prepare(value); await h.save.submit();
    const saved = [...h.drafts.values()][0]!;
    expect((saved.document.nodes as any[])[0].metadata).toEqual({ cloudMediaId, content: "" });
    expect((value.nodes[0].metadata as Record<string, unknown>).content).toBe("blob:hydrated-preview");
});

test("missing cloud media references block before a receipt or draft write", async () => {
    const cloudMediaId = "22222222-2222-4222-8222-222222222222", h = harness(async () => ({ items: [], missing: [cloudMediaId] }));
    const value = project(); (value.nodes[0].metadata as Record<string, unknown>) = { cloudMediaId };
    await safeError(h.save.prepare(value), "cloud_media", "not-sent");
    expect(h.stats()).toEqual({ factories: 0, lists: 0, puts: 0 });
    expect(h.methods).toEqual([]);
});

test("any existing receipt blocks a new intent without GET, selection, deletion or resubmission", async () => {
    const h = harness();
    h.rows.set(oldId, { accountId: context.accountId, localProjectId: context.localProjectId, creationId: oldId });
    const existing = await safeError(h.save.prepare(project()), "existing_receipts", "not-sent");
    expect(existing.creationId).toBe(oldId);
    await safeError(h.save.submit(), "already_started", "not-sent");
    await safeError(h.save.reconcile(), "not_submitted", "not-sent");
    expect(h.save.getState()).not.toHaveProperty("id");
    expect(h.rows.size).toBe(1); expect(h.methods).toEqual([]);
    expect(h.stats()).toEqual({ factories: 1, lists: 1, puts: 0 });
});

test("receipt read failure blocks this window and never mints or sends an intention", async () => {
    const h = harness(); h.hooks.list = async () => { throw new Error("synthetic-private-storage"); };
    await safeError(h.save.prepare(project()), "receipt_unavailable", "not-sent");
    await safeError(h.save.prepare(project()), "already_started", "not-sent");
    expect(h.save.getState()).not.toHaveProperty("id");
    expect(h.methods).toEqual([]); expect(h.rows.size).toBe(0);
});

test("concurrent preparation and submission cannot mint another ID or send twice", async () => {
    const h = harness(), listGate = deferred<void>(), putGate = deferred<void>(), putEntered = deferred<void>();
    h.hooks.list = () => listGate.promise;
    await safeError(h.save.submit(), "not_prepared", "not-sent");
    const pendingPrepare = h.save.prepare(project());
    await safeError(h.save.prepare(project()), "already_started", "not-sent");
    await safeError(h.save.submit(), "not_prepared", "not-sent");
    listGate.resolve(); const prepared = await pendingPrepare;
    await safeError(h.save.prepare(project()), "already_started", "not-sent");
    await safeError(h.save.reconcile(), "not_submitted", "not-sent");
    h.hooks.put = async () => { putEntered.resolve(); await putGate.promise; };
    const pendingSubmit = h.save.submit();
    await putEntered.promise;
    await safeError(h.save.submit(), "already_started", "not-sent");
    await safeError(h.save.reconcile(), "busy", "unknown");
    expect(h.methods).toEqual([]);
    putGate.resolve(); await pendingSubmit;
    await safeError(h.save.submit(), "already_started", "not-sent");
    expect(h.methods).toEqual(["POST"]); expect(h.rows.size).toBe(1);
    expect(h.save.getState().id).toBe(prepared.id);
});

test("dispose, gate closing, project change or account epoch change during receipt commit prevents POST", async () => {
    for (const change of ["dispose", "gate", "project", "account", "epoch"] as const) {
        const h = harness(), gate = deferred<void>(), entered = deferred<void>();
        const prepared = await h.save.prepare(project());
        h.hooks.put = async () => { entered.resolve(); await gate.promise; };
        const pending = outcome(h.save.submit()); await entered.promise;
        if (change === "dispose") h.save.dispose();
        else h.setContext({ ...context, ...(change === "gate" ? { cloudCanvas: false } : change === "project" ? { localProjectId: "other" } : change === "account" ? { accountId: "synthetic-account-B", epoch: 2 } : { epoch: 3 }) });
        gate.resolve();
        const code = change === "gate" ? "cloud_unavailable" : change === "dispose" || change === "project" ? "context_changed" : "account_changed";
        expect(await pending).toMatchObject({ error: { code, outcome: "not-sent" } });
        expect(h.methods).toEqual([]);
        expect([...h.rows.values()]).toEqual([{ accountId: context.accountId, localProjectId: context.localProjectId, creationId: prepared.id }]);
        h.setContext({ ...context });
        await safeError(h.save.submit(), code, "not-sent");
        expect(h.save.getState()).toEqual({ phase: change === "dispose" ? "disposed" : "blocked" });
    }
});

test("late POST success after closure or context change is not adopted and is never described as canceled", async () => {
    for (const change of ["dispose", "gate", "project", "epoch"] as const) {
        const h = harness(), gate = deferred<Response>(), entered = deferred<void>();
        const prepared = await h.save.prepare(project());
        let committed!: CanvasDraft;
        h.hooks.fetch = async (_path, options) => {
            const body = JSON.parse(String(options.body));
            committed = { ...body, id: body.creationId, revision: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" };
            h.drafts.set(prepared.id, committed); entered.resolve(); return gate.promise;
        };
        const pending = outcome(h.save.submit()); await entered.promise;
        if (change === "dispose") h.save.dispose();
        else h.setContext({ ...context, ...(change === "gate" ? { cloudCanvas: false } : change === "project" ? { localProjectId: "other" } : { epoch: 3 }) });
        gate.resolve(Response.json({ draft: committed }));
        const code = change === "gate" ? "cloud_unavailable" : change === "epoch" ? "account_changed" : "context_changed";
        expect(await pending).toMatchObject({ error: { code, outcome: "unknown" } });
        expect(h.methods).toEqual(["POST"]); expect(h.rows.size).toBe(1); expect(h.drafts.size).toBe(1);
        expect(h.save.getState()).not.toHaveProperty("id");
    }
});

test("receipt commit failure means no POST, but still consumes this window's one submission", async () => {
    const h = harness(); await h.save.prepare(project());
    h.hooks.put = async () => { throw new Error("synthetic-private-quota"); };
    await safeError(h.save.submit(), "receipt_unavailable", "not-sent");
    expect(h.save.getState().phase).toBe("submitted");
    await safeError(h.save.submit(), "already_started", "not-sent");
    await safeError(h.save.prepare(project()), "already_started", "not-sent");
    expect(h.methods).toEqual([]);
    expect(await h.save.reconcile()).toMatchObject({ status: "not-found-yet" });
    expect(h.methods).toEqual(["GET"]);
});

test("network errors and known refusals arriving after dispose still report an unknown prior write", async () => {
    for (const failedNetwork of [true, false]) {
        const h = harness(), gate = deferred<Response>(), entered = deferred<void>();
        await h.save.prepare(project());
        h.hooks.fetch = async () => { entered.resolve(); return gate.promise; };
        const pending = outcome(h.save.submit()); await entered.promise;
        h.save.dispose();
        if (failedNetwork) gate.reject(new Error("synthetic-private-late-network"));
        else gate.resolve(Response.json({ error: { code: "payload_too_large", message: "synthetic-private-late-server" } }, { status: 413 }));
        expect(await pending).toMatchObject({ error: { code: "context_changed", outcome: "unknown" } });
        expect(h.methods).toEqual(["POST"]);
        expect(h.rows.size).toBe(1);
        expect(h.save.getState()).toEqual({ phase: "disposed" });
    }
});

test("unknown POST, explicit 404 and repeated read failures never unlock a replacement intention", async () => {
    const h = harness(), prepared = await h.save.prepare(project());
    h.hooks.fetch = async (_path, options) => {
        if (options.method === "POST") throw new Error("synthetic-private-response-loss");
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
    };
    const failed = await safeError(h.save.submit(), "unavailable", "unknown");
    expect(failed.creationId).toBe(prepared.id);
    expect(h.methods).toEqual(["POST"]);
    expect(await h.save.reconcile()).toEqual({ id: prepared.id, status: "not-found-yet" });
    expect(h.rows.size).toBe(1);
    await safeError(h.save.submit(), "already_started", "not-sent");
    await safeError(h.save.prepare(project()), "already_started", "not-sent");
    h.hooks.fetch = async () => new Response("synthetic-private-html", { status: 503 });
    await safeError(h.save.reconcile(), "unavailable", "unknown");
    expect(h.methods).toEqual(["POST", "GET", "GET"]);
    expect(h.save.getState()).toMatchObject({ phase: "submitted", id: prepared.id });
});

test("known POST rejections keep safe codes and valid supplied limit seconds without automatic retry", async () => {
    for (const [status, code] of [[409, "creation_exists"], [413, "payload_too_large"], [403, "invalid_origin"], [429, "rate_limited"]] as const) {
        const h = harness(); await h.save.prepare(project());
        h.hooks.fetch = async () => Response.json({ error: { code, message: "synthetic-private-server" } }, { status, headers: { "retry-after": "23" } });
        const failed = await safeError(h.save.submit(), code, "rejected");
        expect(failed.retryAfter).toBe(code === "rate_limited" ? 23 : undefined);
        await safeError(h.save.submit(), "already_started", "not-sent");
        expect(h.methods).toEqual(["POST"]); expect(h.rows.size).toBe(1);
    }
});

test("success and reconciliation expose only current safe summary, never cloud document or title", async () => {
    const h = harness(), prepared = await h.save.prepare(project());
    await h.save.submit();
    const saved = h.drafts.get(prepared.id)!;
    saved.revision = 2; saved.updatedAt = "2026-01-01T00:00:02Z"; saved.title = "synthetic-private-replaced-title";
    saved.document.nodes = [{ content: "synthetic-private-newer-document" }];
    const result = await h.save.reconcile();
    expect(result).toEqual({ id: prepared.id, status: "found-current", revision: 2, updatedAt: "2026-01-01T00:00:02Z" });
    expect(result).not.toHaveProperty("snapshotSaved"); expect(result).not.toHaveProperty("document");
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
    expect(h.methods).toEqual(["POST", "GET"]);
});

test("cloud document with another project ID is refused on both submit and reconcile", async () => {
    for (const stage of ["submit", "reconcile"] as const) {
        const h = harness(), prepared = await h.save.prepare(project());
        if (stage === "reconcile") await h.save.submit();
        h.hooks.fetch = async () => Response.json({ draft: {
            id: prepared.id, title: "synthetic-private-title", revision: 1, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z",
            documentVersion: 1, document: { id: "other-project", body: "synthetic-private-body" },
        } });
        await safeError(stage === "submit" ? h.save.submit() : h.save.reconcile(), "project_mismatch", "unknown");
        await safeError(h.save.submit(), "already_started", "not-sent");
    }
});

test("late preparation and reconciliation cannot revive a closed or changed lifetime", async () => {
    const h = harness(), listGate = deferred<void>();
    h.hooks.list = () => listGate.promise;
    const pending = outcome(h.save.prepare(project()));
    h.save.dispose(); listGate.resolve();
    expect(await pending).toMatchObject({ error: { code: "context_changed", outcome: "not-sent" } });
    expect(h.save.getState()).toEqual({ phase: "disposed" }); expect(h.methods).toEqual([]);
    const other = harness(), prepared = await other.save.prepare(project()); await other.save.submit();
    const responseGate = deferred<Response>(), entered = deferred<void>();
    other.hooks.fetch = async () => { entered.resolve(); return responseGate.promise; };
    const checking = outcome(other.save.reconcile()); await entered.promise;
    await safeError(other.save.reconcile(), "busy", "unknown");
    other.setContext({ ...context, accountId: "synthetic-account-B", epoch: 2 });
    other.setContext({ ...context, epoch: 3 });
    responseGate.resolve(Response.json({ draft: other.drafts.get(prepared.id) }));
    expect(await checking).toMatchObject({ error: { code: "account_changed", outcome: "unknown" } });
    other.setContext({ ...context });
    await safeError(other.save.reconcile(), "account_changed", "unknown");
    expect(other.save.getState()).toEqual({ phase: "blocked" });
});

test("server session refusal invalidates the controller without leaking raw server errors", async () => {
    const h = harness(); await h.save.prepare(project());
    h.hooks.fetch = async () => Response.json({ error: { code: "unauthorized", message: "synthetic-private-auth" } }, { status: 401 });
    await safeError(h.save.submit(), "account_changed", "rejected");
    await safeError(h.save.reconcile(), "account_changed", "unknown");
    expect(h.methods).toEqual(["POST"]);
    expect(h.save.getState()).toEqual({ phase: "blocked" });
});
