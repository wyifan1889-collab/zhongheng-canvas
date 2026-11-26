import { expect, test } from "bun:test";
import { CanvasCloudLibraryError, createCanvasCloudLibrary } from "./canvas-cloud-library";
import type { CanvasFirstSaveContext } from "./canvas-first-save";
import { createDraftClient, DraftError, type DraftPage, type DraftSummary } from "./drafts";

const id = "a1b2c3d4-e5f6-47a8-b9c0-123456abcdef", otherId = "b1b2c3d4-e5f6-47a8-b9c0-123456abcdef";
const context: CanvasFirstSaveContext = { accountId: "synthetic-account-A", epoch: 1, localProjectId: "synthetic-project-A", cloudCanvas: true };
const row = (value = id): DraftSummary => ({ id: value, title: "synthetic-private-title", revision: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:01.000Z" });
const page = (items = [row()], nextCursor: string | null = null): DraftPage => ({ items, nextCursor });
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const outcome = <T>(value: Promise<T>) => value.then((result) => ({ result }), (error) => ({ error }));
function checkError(error: unknown, code: string) {
    expect(error).toBeInstanceOf(CanvasCloudLibraryError);
    const failure = error as CanvasCloudLibraryError;
    expect(failure.code).toBe(code);
    expect(failure).not.toHaveProperty("cause"); expect(failure).not.toHaveProperty("document");
    expect(String(failure)).not.toContain("synthetic-private");
    return failure;
}
const rejected = async (value: Promise<unknown>, code: string) => checkError(await value.catch((error) => error), code);
function harness(initial: CanvasFirstSaveContext | null = { ...context }) {
    let active = initial, factories = 0;
    const requests: { path: string; method: string }[] = [];
    const hooks: { fetch?: (path: string) => Promise<Response>; factory?: () => void; context?: () => CanvasFirstSaveContext | null } = {};
    const library = createCanvasCloudLibrary(() => hooks.context ? hooks.context() : active, (getScope) => {
        factories++; hooks.factory?.();
        return createDraftClient(getScope, (async (path, options) => {
            requests.push({ path: String(path), method: options!.method! });
            expect(options!.method).toBe("GET"); expect(options!.body).toBeUndefined();
            expect(new Headers(options!.headers).get("x-canvas-account-id")).toBe(context.accountId);
            expect(options!.credentials).toBe("same-origin"); expect(options!.cache).toBe("no-store");
            expect(options!.redirect).toBe("error"); expect(options!.referrerPolicy).toBe("no-referrer");
            return hooks.fetch ? hooks.fetch(String(path)) : Response.json(page());
        }) as typeof fetch);
    });
    return { library, requests, hooks, factories: () => factories, setContext: (value: CanvasFirstSaveContext | null) => { active = value; } };
}

test("constructor and state reads do zero I/O; the only explicit request retains summary fields, not document or extra data", async () => {
    const h = harness();
    expect(h.library.getState()).toEqual({ phase: "idle", page: null });
    expect(h.factories()).toBe(0); expect(h.requests).toEqual([]);
    expect(Object.keys(h.library).sort()).toEqual(["dispose", "getState", "loadFirst", "loadNext"]);
    h.hooks.fetch = async () => Response.json({ ...page(), items: [{ ...row(), documentVersion: 1, document: { private: "synthetic-private-body" }, credential: "synthetic-private-key" }], extra: "synthetic-private-extra" });
    const loaded = await h.library.loadFirst();
    expect(loaded).toEqual(page()); expect(h.library.getState()).toEqual({ phase: "ready", page: page() });
    expect(JSON.stringify([loaded, h.library.getState()])).not.toContain("synthetic-private-body");
    expect(h.factories()).toBe(1); expect(h.requests).toEqual([{ path: "/api/v1/canvases", method: "GET" }]);
});

test("pagination omits frontend limits, encodes the opaque cursor, replaces each page and never auto-loads", async () => {
    const h = harness(), cursor = "opaque+/=?&云";
    const first = page(Array.from({ length: 50 }, (_, i) => row(`${i.toString(16).padStart(8, "0")}-e5f6-47a8-b9c0-123456abcdef`)), cursor);
    h.hooks.fetch = async () => Response.json(h.requests.length === 1 ? first : page([row(otherId)]));
    await rejected(h.library.loadNext(), "no_next_page"); expect(h.requests).toEqual([]);
    const loaded = await h.library.loadFirst();
    expect(loaded.items.length).toBe(50); expect(h.requests.length).toBe(1);
    loaded.nextCursor = "edited-cursor"; loaded.items[0]!.title = "edited-title"; loaded.items.push(row());
    const snapshot = h.library.getState(); snapshot.page!.nextCursor = "edited-state-cursor"; snapshot.page!.items.length = 0;
    expect(h.library.getState().page).toEqual(first);
    expect(await h.library.loadNext()).toEqual(page([row(otherId)]));
    expect(h.library.getState().page!.items).toEqual([row(otherId)]);
    expect(h.requests.map((request) => request.path)).toEqual(["/api/v1/canvases", `/api/v1/canvases?${new URLSearchParams({ cursor })}`]);
    await rejected(h.library.loadNext(), "no_next_page"); expect(h.requests.length).toBe(2); expect(h.factories()).toBe(1);
});

test("a failed refresh clears old summaries and cursor before the request, then permits explicit first-page recovery", async () => {
    const h = harness(); h.hooks.fetch = async () => Response.json(page([row()], "next"));
    await h.library.loadFirst();
    const waiting = deferred<Response>(); h.hooks.fetch = () => waiting.promise;
    const refreshed = outcome(h.library.loadFirst());
    expect(h.library.getState()).toEqual({ phase: "loading", page: null });
    waiting.resolve(Response.json({ error: { code: "internal", detail: "synthetic-private-stack" } }, { status: 503 }));
    checkError((await refreshed).error, "unavailable");
    expect(h.library.getState()).toEqual({ phase: "error", page: null });
    await rejected(h.library.loadNext(), "no_next_page"); expect(h.requests.length).toBe(2);
    h.hooks.fetch = async () => Response.json(page([]));
    expect(await h.library.loadFirst()).toEqual(page([]));
    expect(h.library.getState()).toEqual({ phase: "ready", page: page([]) });
});

test("a failed next page is not an empty-success or stale display; explicit retry uses the intact previous cursor", async () => {
    const h = harness(); h.hooks.fetch = async () => Response.json(page([row()], "next"));
    const first = await h.library.loadFirst();
    const waiting = deferred<Response>(); h.hooks.fetch = () => waiting.promise;
    const next = outcome(h.library.loadNext()); expect(h.library.getState()).toEqual({ phase: "loading", page: null });
    waiting.reject(new Error("synthetic-private-network"));
    checkError((await next).error, "unavailable"); expect(h.library.getState()).toEqual({ phase: "error", page: null });
    expect(first).toEqual(page([row()], "next"));
    h.hooks.fetch = async () => Response.json(page([row(otherId)]));
    expect(await h.library.loadNext()).toEqual(page([row(otherId)]));
    expect(h.requests.map((request) => request.path)).toEqual(["/api/v1/canvases", "/api/v1/canvases?cursor=next", "/api/v1/canvases?cursor=next"]);
});

test("next while pending sends nothing; explicit first-page refresh supersedes a late next success", async () => {
    const h = harness(); h.hooks.fetch = async () => Response.json(page([row()], "next"));
    await h.library.loadFirst();
    const waiting = deferred<Response>(); h.hooks.fetch = () => waiting.promise;
    const older = outcome(h.library.loadNext());
    await rejected(h.library.loadNext(), "busy"); expect(h.requests.length).toBe(2);
    h.hooks.fetch = async () => Response.json(page([]));
    await h.library.loadFirst(); waiting.resolve(Response.json(page([row(otherId)], "later")));
    checkError((await older).error, "superseded");
    expect(h.library.getState()).toEqual({ phase: "ready", page: page([]) }); expect(h.requests.length).toBe(3);
});

test("a superseded failed request cannot clear a newer successful page", async () => {
    const h = harness(), waiting = deferred<Response>(); h.hooks.fetch = () => waiting.promise;
    const older = outcome(h.library.loadFirst());
    h.hooks.fetch = async () => Response.json(page([row(otherId)])); await h.library.loadFirst();
    waiting.reject(new Error("synthetic-private-network")); checkError((await older).error, "superseded");
    expect(h.library.getState()).toEqual({ phase: "ready", page: page([row(otherId)]) });
});

test("a superseded 401 permanently clears even a newer successful directory", async () => {
    const h = harness(), waiting = deferred<Response>(); h.hooks.fetch = () => waiting.promise;
    const older = outcome(h.library.loadFirst());
    h.hooks.fetch = async () => Response.json(page([row(otherId)])); await h.library.loadFirst();
    waiting.resolve(new Response("synthetic-private-auth", { status: 401 }));
    checkError((await older).error, "account_changed");
    expect(h.library.getState()).toEqual({ phase: "blocked", page: null });
    await rejected(h.library.loadFirst(), "account_changed"); expect(h.requests.length).toBe(2);
});

test("dispose before loading is zero I/O and permanently closed", async () => {
    const h = harness(); h.library.dispose(); h.library.dispose();
    expect(h.library.getState()).toEqual({ phase: "closed", page: null });
    await rejected(h.library.loadFirst(), "context_changed"); await rejected(h.library.loadNext(), "context_changed");
    expect(h.factories()).toBe(0); expect(h.requests).toEqual([]);
});

test("closing clears loaded titles and rejects delayed success, server rejection and network error", async () => {
    for (const late of ["success", "server", "network"]) {
        const h = harness(); h.hooks.fetch = async () => Response.json(page([row()], "next")); await h.library.loadFirst();
        const waiting = deferred<Response>(); h.hooks.fetch = () => waiting.promise;
        const pending = outcome(h.library.loadNext()); h.library.dispose();
        expect(h.library.getState()).toEqual({ phase: "closed", page: null });
        if (late === "network") waiting.reject(new Error("synthetic-private-stack"));
        else waiting.resolve(late === "success" ? Response.json(page()) : Response.json({ error: { code: "unauthorized" } }, { status: 401 }));
        checkError((await pending).error, "context_changed");
        expect(h.library.getState()).toEqual({ phase: "closed", page: null });
        await rejected(h.library.loadFirst(), "context_changed"); expect(h.requests.length).toBe(2);
    }
});

test("account, epoch, project, gate and missing context clear loaded data permanently even when the old context returns", async () => {
    const changes: [CanvasFirstSaveContext | null, string][] = [
        [{ ...context, accountId: "synthetic-account-B" }, "account_changed"], [{ ...context, epoch: 2 }, "account_changed"],
        [{ ...context, localProjectId: "synthetic-project-B" }, "context_changed"], [{ ...context, cloudCanvas: false }, "cloud_unavailable"], [null, "account_changed"],
    ];
    for (const [changed, code] of changes) {
        const h = harness(); await h.library.loadFirst(); h.setContext(changed);
        expect(h.library.getState()).toEqual({ phase: "blocked", page: null }); h.setContext({ ...context });
        await rejected(h.library.loadFirst(), code); await rejected(h.library.loadNext(), code);
        expect(h.library.getState()).toEqual({ phase: "blocked", page: null }); expect(h.requests.length).toBe(1);
    }
});

test("scope changes during fetch reject late summaries without requiring a UI state read", async () => {
    for (const changed of [{ ...context, accountId: "synthetic-account-B" }, { ...context, epoch: 2 }, { ...context, localProjectId: "synthetic-project-B" }, { ...context, cloudCanvas: false }]) {
        const h = harness(), waiting = deferred<Response>(); h.hooks.fetch = () => waiting.promise;
        const pending = outcome(h.library.loadFirst()); h.setContext(changed); waiting.resolve(Response.json(page()));
        const code = changed.accountId !== context.accountId || changed.epoch !== context.epoch ? "account_changed" : changed.localProjectId !== context.localProjectId ? "context_changed" : "cloud_unavailable";
        checkError((await pending).error, code); expect(h.library.getState()).toEqual({ phase: "blocked", page: null });
        h.setContext({ ...context }); await rejected(h.library.loadFirst(), code); expect(h.requests.length).toBe(1);
    }
});

test("guard also covers asynchronous JSON consumption and context getters that throw", async () => {
    const h = harness(), body = deferred<unknown>(), reading = deferred<void>();
    h.hooks.fetch = async () => {
        const response = Response.json(page());
        Object.defineProperty(response, "json", { value: () => { reading.resolve(); return body.promise; } }); return response;
    };
    const pending = outcome(h.library.loadFirst()); await reading.promise;
    h.hooks.context = () => { throw new Error("synthetic-private-context"); }; body.resolve(page());
    checkError((await pending).error, "account_changed"); expect(h.library.getState()).toEqual({ phase: "blocked", page: null });
    h.hooks.context = undefined; await rejected(h.library.loadFirst(), "account_changed"); expect(h.requests.length).toBe(1);
});

test("initial missing account or closed gate and factory-time context change send no request", async () => {
    for (const initial of [null, { ...context, cloudCanvas: false }]) {
        const h = harness(initial); await rejected(h.library.loadFirst(), initial ? "cloud_unavailable" : "account_changed");
        h.setContext({ ...context }); await rejected(h.library.loadFirst(), initial ? "cloud_unavailable" : "account_changed");
        expect(h.factories()).toBe(0); expect(h.requests).toEqual([]);
    }
    const h = harness(); h.hooks.factory = () => h.setContext({ ...context, localProjectId: "synthetic-project-B" });
    await rejected(h.library.loadFirst(), "context_changed"); expect(h.requests).toEqual([]); expect(h.factories()).toBe(1);
});

test("constructor snapshots context values so mutating the caller object cannot rebind a controller", async () => {
    const mutable = { ...context }, h = harness(mutable); mutable.epoch++;
    await rejected(h.library.loadFirst(), "account_changed"); expect(h.requests).toEqual([]);
});

test("all 401 contracts and explicit account refusal permanently block both read methods", async () => {
    const refusals = [
        () => Response.json({ error: { code: "unauthorized", detail: "synthetic-private-auth" } }, { status: 401 }),
        () => new Response("synthetic-private-proxy-auth", { status: 401 }),
        () => Response.json({ unexpected: "synthetic-private-auth" }, { status: 401 }),
        () => Response.json({ error: { code: "account_context_required" } }, { status: 400 }),
        () => Response.json({ error: { code: "account_changed" } }, { status: 409 }),
    ];
    for (const refusal of refusals) {
        const h = harness(); h.hooks.fetch = async () => Response.json(page([row()], "next")); await h.library.loadFirst();
        h.hooks.fetch = async () => refusal(); await rejected(h.library.loadNext(), "account_changed");
        expect(h.library.getState()).toEqual({ phase: "blocked", page: null });
        await rejected(h.library.loadFirst(), "account_changed"); await rejected(h.library.loadNext(), "account_changed"); expect(h.requests.length).toBe(2);
    }
});

test("rate limit keeps only a valid retry hint, has no automatic retry, and error text never includes server detail", async () => {
    for (const value of ["17", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
        const h = harness(); h.hooks.fetch = async () => Response.json({ error: { code: "rate_limited", message: "synthetic-private-backend" } }, { status: 429, headers: { "retry-after": value } });
        const failure = await rejected(h.library.loadFirst(), "rate_limited"); expect(failure.retryAfter).toBe(value === "17" ? 17 : undefined);
        expect(h.library.getState()).toEqual({ phase: "error", page: null }); expect(h.requests.length).toBe(1);
    }
    const h = harness(); h.hooks.fetch = async () => { throw new Error("synthetic-private-network-stack"); };
    await rejected(h.library.loadFirst(), "unavailable"); expect(h.requests.length).toBe(1);
});

test("malformed list and summary contracts cannot be treated as empty success and explicit refresh remains possible", async () => {
    const malformed = [
        null, {}, { items: [], nextCursor: "" }, { items: [], nextCursor: 7 }, { items: {} , nextCursor: null },
        page([null as unknown as DraftSummary]), page([{ ...row(), id: "not-a-cloud-id" }]), page([{ ...row(), title: null as unknown as string }]),
        page([{ ...row(), revision: 0 }]), page([{ ...row(), revision: 1.5 }]), page([{ ...row(), revision: Number.MAX_SAFE_INTEGER + 1 }]),
        page([{ ...row(), createdAt: "bad-date" }]), page([{ ...row(), updatedAt: "bad-date" }]), page([row(), row(id.toUpperCase())]),
    ];
    for (const value of malformed) {
        const h = harness(); h.hooks.fetch = async () => Response.json(value);
        await rejected(h.library.loadFirst(), "unavailable"); expect(h.library.getState()).toEqual({ phase: "error", page: null });
        h.hooks.fetch = async () => Response.json(page([])); expect(await h.library.loadFirst()).toEqual(page([])); expect(h.requests.length).toBe(2);
    }
});

test("a repeated pagination cursor fails without advancing and supports explicit retry of that page", async () => {
    const h = harness(); h.hooks.fetch = async () => Response.json(page([row()], "same")); await h.library.loadFirst();
    await rejected(h.library.loadNext(), "unavailable"); expect(h.library.getState()).toEqual({ phase: "error", page: null });
    h.hooks.fetch = async () => Response.json(page([row(otherId)])); expect(await h.library.loadNext()).toEqual(page([row(otherId)]));
    expect(h.requests.slice(1).map((request) => request.path)).toEqual(["/api/v1/canvases?cursor=same", "/api/v1/canvases?cursor=same"]);
});

test("minimal list-only factories are guarded and unknown client errors are replaced with fixed safe errors", async () => {
    let calls = 0;
    const library = createCanvasCloudLibrary(() => context, () => ({ list: async () => { calls++; throw new Error("synthetic-private-client"); } }));
    expect(calls).toBe(0); await rejected(library.loadFirst(), "unavailable"); expect(calls).toBe(1);
    const limited = createCanvasCloudLibrary(() => context, () => ({ list: async () => { throw new DraftError("rate_limited", "synthetic-private-client", 429, "rejected", undefined, 5); } }));
    expect((await rejected(limited.loadFirst(), "rate_limited")).retryAfter).toBe(5);
});
