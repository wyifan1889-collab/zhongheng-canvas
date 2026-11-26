import { expect, test } from "bun:test";
import { createCanvasVersionSession, CanvasVersionSaveError } from "./canvas-version-save";
import type { CanvasFirstSaveContext } from "./canvas-first-save";
import { createDraftClient, DraftError } from "./drafts";
import type { CanvasDraft } from "../../../../packages/shared/src/index";

const id = "a1b2c3d4-e5f6-47a8-b9c0-123456abcdef", otherId = "b1b2c3d4-e5f6-47a8-b9c0-123456abcdef";
const context: CanvasFirstSaveContext = { accountId: "synthetic-account-A", epoch: 1, localProjectId: "synthetic-project-A", cloudCanvas: true };
const creation = () => ({ id, revision: 1, updatedAt: "2026-01-01T00:00:00.000Z" });
function project() {
    return {
        id: context.localProjectId, title: "synthetic-private-title", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
        nodes: [{ id: "text", type: "text", metadata: { content: "synthetic-private-original", errorDetails: undefined } }],
        connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: true, viewport: { x: 0, y: 0, k: 1 },
        extension: { media: "https://synthetic.invalid/media", plugin: { content: "synthetic-private-extension" } },
    };
}
function draft(revision = 1): CanvasDraft {
    return { ...creation(), revision, title: "synthetic-private-title", createdAt: "2026-01-01T00:00:00.000Z", documentVersion: 1, document: JSON.parse(JSON.stringify(project())) };
}
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const outcome = <T>(value: Promise<T>) => value.then((result) => ({ result }), (error) => ({ error }));
function checkError(error: unknown, code: string, expectedOutcome?: string) {
    expect(error).toBeInstanceOf(CanvasVersionSaveError);
    const failure = error as CanvasVersionSaveError;
    expect(failure.code).toBe(code);
    if (expectedOutcome) expect(failure.outcome).toBe(expectedOutcome);
    expect(failure).not.toHaveProperty("cause"); expect(failure).not.toHaveProperty("document");
    expect(String(failure)).not.toContain("synthetic-private");
    return failure;
}
async function rejected(value: Promise<unknown>, code: string, expectedOutcome?: string) {
    return checkError(await value.catch((error) => error), code, expectedOutcome);
}
function refused(action: () => unknown, code: string, expectedOutcome = "not-sent") {
    let failure: unknown; try { action(); } catch (error) { failure = error; }
    return checkError(failure, code, expectedOutcome);
}
function harness(resolveMedia: (ids: string[]) => Promise<{ items: ReadonlyArray<{ id: string }>; missing: ReadonlyArray<string> }> = async (ids) => ({ items: ids.map((id) => ({ id })), missing: [] })) {
    let active: CanvasFirstSaveContext | null = { ...context }, remote: CanvasDraft | null = draft(), factories = 0;
    const requests: { path: string; method: string; body?: Record<string, unknown> }[] = [];
    const hooks: { fetch?: (path: string, options: RequestInit) => Promise<Response>; factory?: () => void } = {};
    const session = createCanvasVersionSession(() => active, (getScope) => {
        factories++; hooks.factory?.();
        return createDraftClient(getScope, (async (path, options) => {
            const method = options!.method!, body = options!.body ? JSON.parse(String(options!.body)) : undefined;
            requests.push({ path: String(path), method, ...(body ? { body } : {}) });
            expect(new Headers(options!.headers).get("x-canvas-account-id")).toBe(context.accountId);
            expect(options!.credentials).toBe("same-origin");
            expect(options!.cache).toBe("no-store");
            if (hooks.fetch) return hooks.fetch(String(path), options!);
            if (!remote) return Response.json({ error: { code: "not_found" } }, { status: 404 });
            if (method === "PUT") {
                if (body.expectedRevision !== remote.revision) return Response.json({ error: { code: "revision_conflict" }, currentRevision: remote.revision }, { status: 409 });
                remote = { ...remote, title: body.title, document: body.document, revision: remote.revision + 1, updatedAt: `2026-01-01T00:00:0${remote.revision}.000Z` };
            }
            return Response.json({ draft: remote });
        }) as typeof fetch);
    }, () => ({ resolve: resolveMedia }));
    return { session, requests, hooks, factories: () => factories, setContext: (value: CanvasFirstSaveContext | null) => { active = value; },
        remote: () => remote, setRemote: (value: CanvasDraft | null) => { remote = value; } };
}

test("constructor, seeding, open and synchronous prepare do zero I/O; two explicit CAS successes advance only the confirmed baseline", async () => {
    const h = harness(), seed = creation();
    expect(h.session.getState()).toEqual({ status: "empty" });
    h.session.seedCreation(seed); seed.id = otherId; seed.revision = 99;
    const first = h.session.open(), input = project(), prepared = first.prepare(input);
    expect(h.factories()).toBe(0); expect(h.requests).toEqual([]);
    expect(prepared).toEqual({ id, expectedRevision: 1, counts: { nodes: 1, connections: 0, chats: 0, localMediaReferences: 0, omittedOptionalFields: 1 } });
    expect(Object.isFrozen(prepared.counts)).toBe(true);
    input.title = "edited later"; input.nodes[0].metadata.content = "edited later"; input.extension.plugin.content = "edited later";
    const saved = await first.submit();
    expect(saved).toEqual({ id, revision: 2, updatedAt: "2026-01-01T00:00:01.000Z" });
    expect(h.session.getState()).toEqual({ status: "ready", id, revision: 2 });
    expect(h.requests[0]).toMatchObject({ method: "PUT", path: `/api/v1/canvases/${id}`, body: { expectedRevision: 1, document: {
        title: "synthetic-private-title", nodes: [{ id: "text", type: "text", metadata: { content: "synthetic-private-original" } }], extension: project().extension,
    } } });
    expect(h.requests[0].body).not.toHaveProperty("creationId");
    expect(JSON.stringify([saved, prepared, first.getState(), h.session.getState()])).not.toContain("synthetic-private");
    first.close();
    const second = h.session.open(); expect(second.getState().phase).toBe("idle");
    const next = project(); next.nodes[0].metadata.content = "synthetic-private-second";
    expect(second.prepare(next).expectedRevision).toBe(2);
    expect((await second.submit()).revision).toBe(3);
    expect(h.requests.map((request) => [request.method, request.body?.expectedRevision])).toEqual([["PUT", 1], ["PUT", 2]]);
    expect(h.session.getState()).toEqual({ status: "ready", id, revision: 3 });
    expect(h.remote()!.document.nodes).toEqual([{ id: "text", type: "text", metadata: { content: "synthetic-private-second" } }]);
});

test("only an empty session accepts revision-one creation summaries; no baseline cannot read or write", async () => {
    const h = harness(), empty = h.session.open();
    expect(empty.getState()).toEqual({ phase: "blocked" });
    refused(() => empty.prepare(project()), "no_baseline");
    await rejected(empty.submit(), "no_baseline", "not-sent");
    await rejected(empty.reconcile(), "no_baseline", "not-sent");
    for (const invalid of [null, {}, { ...creation(), id: "local-project" }, { ...creation(), revision: 0 }, { ...creation(), revision: 2 }, { ...creation(), updatedAt: "bad" }]) {
        refused(() => h.session.seedCreation(invalid as ReturnType<typeof creation>), "invalid_baseline");
        expect(h.session.getState()).toEqual({ status: "empty" });
    }
    h.session.seedCreation({ ...creation(), id: id.toUpperCase() });
    refused(() => h.session.seedCreation(creation()), "already_seeded");
    expect(h.session.getState()).toEqual({ status: "ready", id, revision: 1 });
    expect(h.factories()).toBe(0); expect(h.requests).toEqual([]);
});

test("old receipts remain read-only and never establish a baseline or issue a GET", async () => {
    const h = harness();
    await rejected(h.session.resumeFromReceipt(id), "invalid_baseline", "not-sent");
    expect(h.session.getState()).toEqual({ status: "empty" });
    expect(h.requests).toEqual([]);
});

test("only an explicit current-account directory selection verifies and adopts the exact revision", async () => {
    const h = harness();
    await h.session.resumeFromCloudSelection({ accountId: context.accountId, id, revision: 1 });
    expect(h.requests).toEqual([{ path: `/api/v1/canvases/${id}`, method: "GET" }]);
    expect(h.session.getState()).toEqual({ status: "ready", id, revision: 1 });
});

test("directory selection rejects foreign accounts, stale revisions and never creates a baseline", async () => {
    for (const selection of [
        { accountId: "synthetic-account-B", id, revision: 1 },
        { accountId: context.accountId, id, revision: 2 },
    ]) {
        const h = harness();
        if (selection.revision === 2) h.setRemote(draft(1));
        await rejected(h.session.resumeFromCloudSelection(selection), "invalid_baseline", selection.accountId === context.accountId ? "unknown" : "not-sent");
        expect(h.session.getState()).toEqual({ status: "empty" });
        expect(h.requests).toEqual(selection.accountId === context.accountId ? [{ path: `/api/v1/canvases/${id}`, method: "GET" }] : []);
        if (selection.revision === 2) {
            h.setRemote(draft(2));
            await h.session.resumeFromCloudSelection(selection);
            expect(h.session.getState()).toEqual({ status: "ready", id, revision: 2 });
        }
    }
});

test("directory selection race rejects a second confirmation before it starts another GET", async () => {
    const h = harness(), firstResponse = deferred<Response>();
    h.hooks.fetch = async (path) => path.endsWith(otherId)
        ? Response.json({ draft: { ...draft(), id: otherId } }) : firstResponse.promise;
    const first = outcome(h.session.resumeFromCloudSelection({ accountId: context.accountId, id, revision: 1 }));
    const second = await outcome(h.session.resumeFromCloudSelection({ accountId: context.accountId, id: otherId, revision: 1 }));
    firstResponse.resolve(Response.json({ draft: draft() }));
    expect(await first).toEqual({ result: undefined });
    expect(second).toMatchObject({ error: { code: "busy", outcome: "not-sent" } });
    expect(h.requests).toEqual([{ path: `/api/v1/canvases/${id}`, method: "GET" }]);
    expect(h.session.getState()).toEqual({ status: "ready", id, revision: 1 });
});

test("directory selection race cannot replace a creation acknowledged while its GET was pending", async () => {
    const h = harness(), response = deferred<Response>();
    h.hooks.fetch = () => response.promise;
    const selecting = outcome(h.session.resumeFromCloudSelection({ accountId: context.accountId, id, revision: 1 }));
    h.session.seedCreation({ ...creation(), id: otherId });
    response.resolve(Response.json({ draft: draft() }));
    expect(await selecting).toMatchObject({ error: { code: "already_seeded", outcome: "unknown" } });
    expect(h.session.getState()).toEqual({ status: "ready", id: otherId, revision: 1 });
    expect(h.requests).toHaveLength(1);
});

test("StrictMode-like open-close-open and closing a prepared unsent window preserve the page baseline", async () => {
    const h = harness(); h.session.seedCreation(creation());
    const initial = h.session.open(); initial.close(); initial.close();
    expect(initial.getState()).toEqual({ phase: "closed" });
    const prepared = h.session.open(); prepared.prepare(project()); prepared.close();
    expect(prepared.getState()).toEqual({ phase: "closed" });
    await rejected(prepared.submit(), "window_closed", "not-sent");
    expect(h.session.getState()).toEqual({ status: "ready", id, revision: 1 });
    expect(h.factories()).toBe(0); expect(h.requests).toEqual([]);
    const fresh = h.session.open(); fresh.prepare(project()); await fresh.submit();
    expect(h.session.getState()).toEqual({ status: "ready", id, revision: 2 });
});

test("the page write lock is acquired before a reentrant client factory and same-frame second submission", async () => {
    const h = harness(), gate = deferred<Response>(); h.session.seedCreation(creation());
    const first = h.session.open(), other = h.session.open(); first.prepare(project()); other.prepare(project());
    let fromFactory!: Promise<unknown>;
    h.hooks.factory = () => { expect(h.session.getState().status).toBe("saving"); fromFactory = outcome(other.submit()); };
    h.hooks.fetch = () => gate.promise;
    const pending = first.submit();
    expect(await fromFactory).toMatchObject({ error: { code: "busy", outcome: "not-sent" } });
    await rejected(first.submit(), "busy", "not-sent");
    expect(h.requests.map((request) => request.method)).toEqual(["PUT"]);
    other.close(); expect(h.session.getState().status).toBe("saving");
    gate.resolve(Response.json({ draft: draft(2) })); await pending;
    expect(h.session.getState()).toEqual({ status: "ready", id, revision: 2 });
    await rejected(first.submit(), "already_started", "not-sent");
});

test("a second prepared window cannot submit its old baseline after another window succeeds", async () => {
    const h = harness(); h.session.seedCreation(creation());
    const first = h.session.open(), stale = h.session.open(); first.prepare(project()); stale.prepare(project());
    await first.submit();
    await rejected(stale.submit(), "stale_baseline", "not-sent");
    expect(stale.getState().phase).toBe("blocked");
    expect(h.requests).toHaveLength(1);
    expect(h.session.getState()).toEqual({ status: "ready", id, revision: 2 });
    const fresh = h.session.open(); fresh.prepare(project()); await fresh.submit();
    expect(h.requests.map((request) => request.body?.expectedRevision)).toEqual([1, 2]);
});

test("same-window repeated preparation is refused and local/invalid content cannot start a request", async () => {
    const h = harness(); h.session.seedCreation(creation());
    for (const candidate of [null, {}, { ...project(), id: "other-local" }, { ...project(), extension: { invalid: Number.NaN } }]) {
        const window = h.session.open(); refused(() => window.prepare(candidate), "invalid_project"); window.close();
    }
    for (const media of ["image:local", "video-reference:local", "blob:https://synthetic.invalid/x", "data:image/png;base64,synthetic", "file:///local"]) {
        const window = h.session.open(), value = project(); value.nodes[0].metadata.content = media;
        refused(() => window.prepare(value), "local_media"); window.close();
    }
    {
        const window = h.session.open(), value = project();
        value.nodes[0].metadata = { content: "", videoTaskId: "video-task-private" };
        refused(() => window.prepare(value), "local_media"); window.close();
    }
    {
        const window = h.session.open(), value = project();
        value.nodes[0].type = "image";
        value.nodes[0].metadata.content = "https://example.invalid/image";
        refused(() => window.prepare(value), "local_media"); window.close();
    }
    const window = h.session.open(); window.prepare(project()); refused(() => window.prepare(project()), "already_started");
    expect(h.session.getState()).toEqual({ status: "ready", id, revision: 1 });
    expect(h.requests).toEqual([]); expect(h.factories()).toBe(0);
});

test("owned cloud media references are checked at submit before the version PUT", async () => {
    const cloudMediaId = "11111111-1111-4111-8111-111111111111", calls: string[][] = [];
    const h = harness(async (ids) => { calls.push(ids); return { items: [{ id: cloudMediaId }], missing: [] }; });
    h.session.seedCreation(creation()); const window = h.session.open(), value = project();
    (value.nodes[0].metadata as Record<string, unknown>) = { cloudMediaId };
    const prepared = window.prepare(value);
    expect(prepared.counts.localMediaReferences).toBe(0);
    expect(calls).toEqual([]);
    await window.submit();
    expect(calls).toEqual([[cloudMediaId]]);
    expect(h.requests[0].method).toBe("PUT");
});

test("version save strips a hydrated preview before the PUT", async () => {
    const cloudMediaId = "11111111-1111-4111-8111-111111111111", h = harness();
    h.session.seedCreation(creation()); const window = h.session.open(), value = project();
    value.nodes[0].type = "image";
    (value.nodes[0].metadata as Record<string, unknown>) = { cloudMediaId, content: "blob:hydrated-preview", storageKey: "image:local-cache" };
    window.prepare(value); await window.submit();
    expect((h.requests[0].body!.document as any).nodes[0].metadata).toEqual({ cloudMediaId, content: "" });
    expect((value.nodes[0].metadata as Record<string, unknown>).content).toBe("blob:hydrated-preview");
});

test("missing cloud media references block a version PUT and leave the session read-only", async () => {
    const cloudMediaId = "22222222-2222-4222-8222-222222222222", h = harness(async () => ({ items: [], missing: [cloudMediaId] }));
    h.session.seedCreation(creation()); const window = h.session.open(), value = project();
    (value.nodes[0].metadata as Record<string, unknown>) = { cloudMediaId }; window.prepare(value);
    await rejected(window.submit(), "cloud_media", "not-sent");
    expect(h.requests).toEqual([]);
    expect(h.session.getState().status).toBe("blocked");
});

test("409 preserves the original expected revision, exposes only observed revision and remains read-only after latest GET", async () => {
    const h = harness(); h.session.seedCreation(creation()); h.setRemote(draft(8));
    const window = h.session.open(); window.prepare(project());
    const failure = await rejected(window.submit(), "revision_conflict", "rejected");
    expect(failure.currentRevision).toBe(8);
    const conflict = { status: "conflict", id, revision: 1, observedRevision: 8 };
    expect(h.session.getState()).toEqual(conflict); expect(window.getState().phase).toBe("conflict");
    expect(await window.reconcile()).toMatchObject({ id, status: "found-current", revision: 8 });
    expect(h.session.getState()).toEqual(conflict);
    window.close(); const reopened = h.session.open(); expect(reopened.getState()).toMatchObject({ phase: "conflict", expectedRevision: 1, observedRevision: 8 });
    refused(() => reopened.prepare(project()), "readonly"); await rejected(reopened.submit(), "readonly", "not-sent");
    refused(() => h.session.seedCreation(creation()), "already_seeded");
    expect(h.requests.map((request) => request.method)).toEqual(["PUT", "GET"]);
});

test("unknown writes stay locked whether explicit GET finds a newer revision or reports 404", async () => {
    for (const committed of [true, false]) {
        const h = harness(); h.session.seedCreation(creation());
        h.hooks.fetch = async (_path, options) => {
            if (options.method === "PUT") { h.setRemote(committed ? draft(2) : null); throw new Error("synthetic-private-response-lost"); }
            return h.remote() ? Response.json({ draft: h.remote() }) : Response.json({ error: { code: "not_found" } }, { status: 404 });
        };
        const window = h.session.open(); window.prepare(project());
        await rejected(window.submit(), "unavailable", "unknown");
        expect(h.session.getState()).toEqual({ status: "unknown", id, revision: 1 });
        window.close(); const reopened = h.session.open(); expect(reopened.getState().phase).toBe("unknown");
        expect(await reopened.reconcile()).toMatchObject({ id, status: committed ? "found-current" : "not-found-yet" });
        expect(h.session.getState()).toEqual({ status: "unknown", id, revision: 1 });
        refused(() => reopened.prepare(project()), "readonly"); await rejected(reopened.submit(), "readonly", "not-sent");
        expect(h.requests.map((request) => request.method)).toEqual(["PUT", "GET"]);
    }
});

test("closing an in-flight PUT immediately locks the whole session; late success, rejection or failure cannot revive it", async () => {
    for (const response of [Response.json({ draft: draft(2) }),
        Response.json({ error: { code: "revision_conflict" }, currentRevision: 8 }, { status: 409 }),
        Response.json({ error: { code: "payload_too_large" } }, { status: 413 }), new Error("synthetic-private-late")]) {
        const h = harness(), gate = deferred<Response>(); h.session.seedCreation(creation());
        h.hooks.fetch = () => gate.promise;
        const window = h.session.open(); window.prepare(project()); const pending = outcome(window.submit());
        window.close();
        expect(window.getState()).toEqual({ phase: "closed" });
        expect(h.session.getState()).toEqual({ status: "unknown", id, revision: 1 });
        const reopened = h.session.open(); expect(reopened.getState().phase).toBe("unknown");
        refused(() => reopened.prepare(project()), "readonly");
        if (response instanceof Error) gate.reject(response); else gate.resolve(response);
        expect(await pending).toMatchObject({ error: { code: "window_closed", outcome: "unknown" } });
        expect(h.session.getState()).toEqual({ status: "unknown", id, revision: 1 });
        await rejected(reopened.submit(), "readonly", "not-sent"); expect(h.requests).toHaveLength(1);
    }
});

test("account, epoch, project and gate changes before sending permanently drop baseline and prepared contents", async () => {
    for (const [next, code] of [
        [null, "account_changed"], [{ ...context, accountId: "B", epoch: 2 }, "account_changed"], [{ ...context, epoch: 3 }, "account_changed"],
        [{ ...context, localProjectId: "B" }, "context_changed"], [{ ...context, cloudCanvas: false }, "cloud_unavailable"],
    ] as const) {
        const h = harness(); h.session.seedCreation(creation()); const window = h.session.open(); window.prepare(project());
        h.setContext(next);
        await rejected(window.submit(), code, "not-sent");
        expect(h.session.getState()).toEqual({ status: "blocked" }); expect(window.getState()).toEqual({ phase: "blocked" });
        h.setContext({ ...context }); refused(() => h.session.open(), code);
        expect(h.requests).toEqual([]); expect(h.factories()).toBe(0);
    }
});

test("the full context guard also covers client construction before fetch and rejects invalid initial gates", async () => {
    const h = harness(); h.session.seedCreation(creation()); const window = h.session.open(); window.prepare(project());
    h.hooks.factory = () => h.setContext({ ...context, cloudCanvas: false });
    await rejected(window.submit(), "cloud_unavailable", "not-sent");
    expect(h.requests).toEqual([]); expect(h.session.getState()).toEqual({ status: "blocked" });
    for (const gate of [false, undefined, "true"]) {
        const session = createCanvasVersionSession(() => ({ ...context, cloudCanvas: gate as boolean }));
        refused(() => session.seedCreation(creation()), "cloud_unavailable");
        refused(() => session.open(), "cloud_unavailable");
        expect(session.getState()).toEqual({ status: "blocked" });
    }
});

test("context changes or session disposal after sending discard late success without calling it canceled", async () => {
    for (const change of ["account", "epoch", "project", "gate", "dispose"] as const) {
        const h = harness(), gate = deferred<Response>(); h.session.seedCreation(creation());
        h.hooks.fetch = () => gate.promise;
        const window = h.session.open(); window.prepare(project()); const pending = outcome(window.submit());
        if (change === "dispose") h.session.dispose();
        else h.setContext({ ...context, ...(change === "account" ? { accountId: "B", epoch: 2 } : change === "epoch" ? { epoch: 3 } : change === "project" ? { localProjectId: "B" } : { cloudCanvas: false }) });
        gate.resolve(Response.json({ draft: draft(2) }));
        const code = change === "gate" ? "cloud_unavailable" : change === "project" || change === "dispose" ? "context_changed" : "account_changed";
        expect(await pending).toMatchObject({ error: { code, outcome: "unknown" } });
        expect(h.requests.map((request) => request.method)).toEqual(["PUT"]);
        expect(h.session.getState()).toEqual({ status: "blocked" }); expect(window.getState()).toEqual({ phase: "blocked" });
        h.setContext({ ...context }); refused(() => h.session.seedCreation(creation()), code);
    }
});

test("every attempted known rejection is read-only, including pre-send rejection and valid 429 seconds", async () => {
    for (const [status, code, expected] of [[413, "payload_too_large", "payload_too_large"], [429, "rate_limited", "rate_limited"], [403, "invalid_origin", "invalid_origin"], [400, "invalid_input", "unavailable"], [404, "not_found", "unavailable"]] as const) {
        const h = harness(); h.session.seedCreation(creation());
        h.hooks.fetch = async () => Response.json({ error: { code, message: "synthetic-private-raw" } }, { status, headers: { "retry-after": "11" } });
        const window = h.session.open(); window.prepare(project());
        const error = await rejected(window.submit(), expected, "rejected");
        expect(error.retryAfter).toBe(code === "rate_limited" ? 11 : undefined);
        expect(h.session.getState()).toEqual({ status: "blocked", id, revision: 1 });
        const reopened = h.session.open(); expect(reopened.getState().phase).toBe("blocked");
        await rejected(reopened.submit(), "readonly", "not-sent"); expect(h.requests).toHaveLength(1);
    }
    let sends = 0;
    const session = createCanvasVersionSession(() => context, () => ({
        async save() { sends++; throw new DraftError("invalid_input", "synthetic-private-local", 0, "not-sent"); }, async get() { return draft(); },
    }));
    session.seedCreation(creation()); const window = session.open(); window.prepare(project());
    await rejected(window.submit(), "unavailable", "not-sent");
    expect(session.getState()).toEqual({ status: "blocked", id, revision: 1 });
    await rejected(session.open().submit(), "readonly", "not-sent"); expect(sends).toBe(1);
});

test("malformed or foreign PUT success cannot advance the baseline or return cloud contents", async () => {
    for (const patch of [{ id: otherId }, { revision: 9 }, { updatedAt: "synthetic-private-invalid" }, { document: { id: "other-project", body: "synthetic-private-body" } }]) {
        const h = harness(); h.session.seedCreation(creation());
        h.hooks.fetch = async () => Response.json({ draft: { ...draft(2), ...patch } });
        const window = h.session.open(); window.prepare(project());
        await rejected(window.submit(), "document" in patch ? "project_mismatch" : "unavailable", "unknown");
        expect(h.session.getState()).toEqual({ status: "unknown", id, revision: 1 });
        expect(h.requests).toHaveLength(1);
    }
});

test("readback is observational even while ready; missing, foreign and mismatched records never become baselines", async () => {
    const h = harness(); h.session.seedCreation(creation()); const window = h.session.open();
    h.setRemote(draft(8)); const result = await window.reconcile();
    expect(result).toMatchObject({ id, status: "found-current", revision: 8 });
    expect(Object.keys(result).sort()).toEqual(["id", "revision", "status", "updatedAt"]);
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
    expect(h.session.getState()).toEqual({ status: "ready", id, revision: 1 });
    h.setRemote(null); expect(await window.reconcile()).toEqual({ id, status: "not-found-yet" });
    // A cloud document can now carry another device's local project ID after
    // an explicit mount/save; the account and cloud ID remain authoritative.
    h.setRemote({ ...draft(9), document: { id: "other-device-project" } });
    expect(await window.reconcile()).toMatchObject({ id, revision: 9, status: "found-current" });
    for (const remote of [{ ...draft(), id: otherId }, { ...draft(), document: { id: "" } }]) {
        h.setRemote(remote);
        await rejected(window.reconcile(), remote.id === otherId ? "unavailable" : "project_mismatch", "unknown");
    }
    expect(h.session.getState()).toEqual({ status: "ready", id, revision: 1 });
    expect(h.requests.every((request) => request.method === "GET" && !request.body)).toBe(true);
});

test("late GET after close is discarded, and concurrent manual reads cannot auto-apply an old revision", async () => {
    const h = harness(), gate = deferred<Response>(); h.session.seedCreation(creation());
    h.hooks.fetch = () => gate.promise;
    const window = h.session.open(), pending = outcome(window.reconcile());
    await rejected(window.reconcile(), "busy", "unknown"); window.close();
    gate.resolve(Response.json({ draft: draft(8) }));
    expect(await pending).toMatchObject({ error: { code: "window_closed", outcome: "unknown" } });
    expect(window.getState()).toEqual({ phase: "closed" });
    expect(h.session.getState()).toEqual({ status: "ready", id, revision: 1 });
    expect(h.requests).toHaveLength(1);
});

test("server account refusals permanently hide old session identifiers on both writes and reads", async () => {
    for (const method of ["PUT", "GET"]) {
        const h = harness(); h.session.seedCreation(creation());
        h.hooks.fetch = async () => Response.json({ error: { code: "unauthorized", message: "synthetic-private-auth" } }, { status: 401 });
        const window = h.session.open(); if (method === "PUT") window.prepare(project());
        await rejected(method === "PUT" ? window.submit() : window.reconcile(), "account_changed", method === "PUT" ? "rejected" : "unknown");
        expect(h.session.getState()).toEqual({ status: "blocked" }); expect(window.getState()).toEqual({ phase: "blocked" });
        refused(() => h.session.open(), "account_changed"); expect(h.requests).toHaveLength(1);
    }
});
