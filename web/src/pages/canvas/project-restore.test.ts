import { expect, spyOn, test } from "bun:test";
import { isProjectRestored, loadProjectCloudMedia, startProjectRestore } from "./project-restore";
import { createAccountStore } from "../../stores/use-account-store";
import { createMediaClient } from "../../services/api/media";
import { CloudMediaHydrationError, hydrateCanvasCloudMediaDocument, revokeCloudMediaObjectUrls } from "../../services/saas/cloud-media-hydration";
import type { AccountSessionSync } from "../../services/saas/account-session-sync";
import type { AccountSite } from "../../services/saas/account";
import type { JsonObject, SessionPrincipal } from "../../../../packages/shared/src/index";

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

test("pre-fix effect fixture reproduces late A replacing B and boolean readiness writing A into B", async () => {
    // Mirrors the old restore/apply and save-effect conditions; no React, media or user storage is loaded.
    const a = deferred<string>();
    let nodes = "A before switching", projectLoaded = true;
    const restoringA = (async () => { nodes = await a.promise; projectLoaded = true; })();
    const firstBRender = { projectId: "B", nodes, projectLoaded };
    projectLoaded = false; // A state update in an effect does not change this render's other effect closures.
    const writes: { projectId: string; nodes: string }[] = [];
    if (firstBRender.projectLoaded) writes.push({ projectId: firstBRender.projectId, nodes: firstBRender.nodes });
    nodes = "B restored";
    a.resolve("A late restore");
    await restoringA;
    expect(writes).toEqual([{ projectId: "B", nodes: "A before switching" }]);
    expect(nodes).toBe("A late restore");
});

test("first render of B cannot save the still-loaded A state before effects run", () => {
    const loadedProjectId = "A", routeProjectId = "B";
    const writes: string[] = [];
    if (isProjectRestored(loadedProjectId, routeProjectId)) writes.push("A nodes -> B");
    expect(writes).toEqual([]);
    expect(isProjectRestored(null, routeProjectId)).toBe(false);
    expect(isProjectRestored("B", routeProjectId)).toBe(true);
});

test("a scheduled viewport save keeps its project's snapshot instead of reading the next project's ref", () => {
    const viewport = { x: 12, y: 34, k: 2 };
    const viewportRef = { current: viewport };
    const writes: { projectId: string; viewport: typeof viewport }[] = [];
    const saveA = () => writes.push({ projectId: "A", viewport });
    viewportRef.current = { x: 98, y: 76, k: 1 };
    saveA();
    expect(writes).toEqual([{ projectId: "A", viewport: { x: 12, y: 34, k: 2 } }]);
    expect(writes[0].viewport).not.toEqual(viewportRef.current);
});

test("late A restore cannot replace B, clear its history or enable saving A state into B", async () => {
    const a = deferred<{ nodes: string; sessions: string }>();
    const b = deferred<{ nodes: string; sessions: string }>();
    const applied: string[] = [], errors: string[] = [];
    let loadedProjectId: string | null = null;
    let document = { nodes: "unchanged", sessions: "unchanged" };
    const start = (id: string, value: Promise<typeof document>) => startProjectRestore(
        () => value,
        (restored) => { document = restored; loadedProjectId = id; applied.push(id); },
        () => { errors.push(id); },
    );
    const old = start("A", a.promise);
    old.cancel();
    const current = start("B", b.promise);
    b.resolve({ nodes: "B nodes", sessions: "B sessions" });
    await current.settled;
    a.resolve({ nodes: "A nodes", sessions: "A sessions" });
    await old.settled;
    expect(applied).toEqual(["B"]);
    expect(document).toEqual({ nodes: "B nodes", sessions: "B sessions" });
    expect(isProjectRestored(loadedProjectId, "B")).toBe(true);
    expect(errors).toEqual([]);
});

test("cancelled A cannot revive after A to B to A or unmount", async () => {
    const oldA = deferred<string>(), currentA = deferred<string>();
    const applied: string[] = [];
    const first = startProjectRestore(() => oldA.promise, (value) => applied.push(value), () => {});
    first.cancel();
    const latest = startProjectRestore(() => currentA.promise, (value) => applied.push(value), () => {});
    currentA.resolve("new A");
    await latest.settled;
    oldA.resolve("old A");
    await first.settled;
    expect(applied).toEqual(["new A"]);
    const unmounted = startProjectRestore(async () => "after unmount", (value) => applied.push(value), () => {});
    unmounted.cancel();
    await unmounted.settled;
    expect(applied).toEqual(["new A"]);
});

test("partial media failure never applies a partial document and does not retry", async () => {
    let loads = 0, errors = 0;
    const original = { nodes: ["A original"], sessions: ["A original conversation"] };
    const stored = structuredClone(original);
    const restored = startProjectRestore(async () => {
        loads++;
        const nodes = await Promise.resolve(["hydrated A nodes"]);
        const sessions = await Promise.reject<string[]>(new Error("private media storage detail"));
        return { nodes, sessions };
    }, (value) => Object.assign(stored, value), () => { errors++; });
    await restored.settled;
    expect(stored).toEqual(original);
    expect(loads).toBe(1);
    expect(errors).toBe(1);
});

test("cancelled restore failure cannot report an error or navigate away from the current project", async () => {
    const value = deferred<string>();
    let applied = 0, navigated = 0;
    const old = startProjectRestore(() => value.promise, () => { applied++; }, () => { navigated++; });
    old.cancel();
    value.reject(new Error("private late storage error"));
    await old.settled;
    expect(applied).toBe(0);
    expect(navigated).toBe(0);
});

function accountRestoreFixture() {
    let user: SessionPrincipal = { id: "synthetic-restore-account", name: "Restore", email: "restore@example.test", role: "user" };
    let site: AccountSite = { registration: false, cloudCanvas: true, cloudMedia: true, captcha: { siteKey: "public-test-key", action: "account" } };
    let reveal = () => {};
    const sync: AccountSessionSync = {
        subscribeVisible(listener) { reveal = listener; return () => {}; },
        subscribeInvalidated() { return () => {}; }, publishInvalidated() {}, close() {},
    };
    const store = createAccountStore({ site: async () => site, session: async () => user, submit: async () => {} }, sync);
    return {
        store,
        async recheck(change: "role" | "cloudCanvas" | "cloudMedia" | "unchanged") {
            if (change === "role") user = { ...user, role: "admin" };
            if (change === "cloudCanvas") site = { ...site, cloudCanvas: false };
            if (change === "cloudMedia") site = { ...site, cloudMedia: false };
            reveal();
            await store.getState().initialize();
        },
    };
}

const restoreMediaId = "11111111-1111-4111-8111-111111111111";
const restoreDocument: JsonObject = {
    id: "synthetic-project", title: "Synthetic restore", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    nodes: [{ id: "image-1", type: "image", title: "Image", position: { x: 0, y: 0 }, width: 200, height: 100, metadata: { cloudMediaId: restoreMediaId, content: "blob:expired" } }],
    connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
};

for (const change of ["role", "cloudCanvas", "cloudMedia", "unchanged"] as const) {
    test(`pending media restore follows the real account scope after a ${change} visibility recheck`, async () => {
        const h = accountRestoreFixture();
        await h.store.getState().initialize();
        const before = h.store.getState().getDraftScope()!;
        const download = deferred<Response>(), downloading = deferred<void>();
        let requests = 0, applied = 0, errors = 0;
        let createdUrls: readonly string[] = [];
        const client = createMediaClient(() => h.store.getState().user?.id ?? null, async (path, init) => {
            requests++;
            expect(new Headers(init?.headers).get("x-canvas-account-id")).toBe(before.accountId);
            if (String(path).endsWith("/resolve")) return Response.json({ items: [{ id: restoreMediaId, kind: "image", contentType: "image/png", sizeBytes: 3, createdAt: "2026-01-01T00:00:00.000Z", url: `/api/v1/media/${restoreMediaId}` }], missing: [] });
            downloading.resolve();
            return download.promise;
        });
        const restoring = startProjectRestore(async () => {
            const value = await hydrateCanvasCloudMediaDocument(restoreDocument, client);
            createdUrls = value.objectUrls;
            return value;
        }, () => { applied++; }, () => { errors++; }, {
            getScope: () => h.store.getState().getDraftScope(),
            discard: (value: { objectUrls: readonly string[] }) => revokeCloudMediaObjectUrls(value.objectUrls),
        });
        try {
            await downloading.promise;
            await h.recheck(change);
            expect(h.store.getState().status).toBe("ready");
            expect(h.store.getState().user?.id).toBe(before.accountId);
            expect(h.store.getState().site?.cloudMedia).toBe(change !== "cloudMedia");
            const changed = change !== "unchanged";
            if (changed) expect(h.store.getState().getDraftScope()!.epoch).toBeGreaterThan(before.epoch);
            else expect(h.store.getState().getDraftScope()).toEqual(before);
            download.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
            await restoring.settled;
            expect(requests).toBe(2);
            expect(applied).toBe(changed ? 0 : 1);
            expect(errors).toBe(changed ? 1 : 0); // Reuse the failure UI instead of leaving a loading shell.
            expect(createdUrls).toHaveLength(1);
            if (changed) await expect(fetch(createdUrls[0])).rejects.toThrow();
            else {
                expect(new Uint8Array(await (await fetch(createdUrls[0])).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
                await h.recheck("role");
                // Changing permissions later does not revoke an already adopted local view.
                expect((await fetch(createdUrls[0])).ok).toBe(true);
                expect(applied).toBe(1);
            }
            expect((restoreDocument.nodes as JsonObject[])[0].metadata).toEqual({ cloudMediaId: restoreMediaId, content: "blob:expired" });
        } finally { restoring.cancel(); revokeCloudMediaObjectUrls(createdUrls); }
    });
}

test("unscoped local restoration remains available when no account is configured", async () => {
    const document = { nodes: ["local text"], viewport: { x: 2, y: 3, k: 1 } };
    const applied: typeof document[] = [];
    let errors = 0;
    const restoring = startProjectRestore(async (isCurrent) => {
        expect(isCurrent()).toBe(true);
        return document;
    }, (value) => { applied.push(value); }, () => { errors++; });
    await restoring.settled;
    expect(applied).toHaveLength(1);
    expect(applied[0]).toBe(document);
    expect(errors).toBe(0);
});

test("scope change during resolve prevents the following media GET from using the new lifetime", async () => {
    const h = accountRestoreFixture();
    await h.store.getState().initialize();
    const resolveResponse = deferred<Response>(), resolving = deferred<void>();
    let requests = 0, applied = 0, errors = 0;
    const restoring = startProjectRestore(async (isCurrent) => {
        const client = createMediaClient(() => isCurrent() ? h.store.getState().getDraftScope()?.accountId ?? null : null, async () => {
            requests++;
            resolving.resolve();
            return resolveResponse.promise;
        });
        return hydrateCanvasCloudMediaDocument(restoreDocument, client);
    }, () => { applied++; }, () => { errors++; }, {
        getScope: () => h.store.getState().getDraftScope(),
        discard: (value) => revokeCloudMediaObjectUrls(value.objectUrls),
    });
    await resolving.promise;
    await h.recheck("role");
    resolveResponse.resolve(Response.json({ items: [{ id: restoreMediaId, kind: "image", contentType: "image/png", sizeBytes: 3, createdAt: "2026-01-01T00:00:00.000Z", url: `/api/v1/media/${restoreMediaId}` }], missing: [] }));
    await restoring.settled;
    expect(requests).toBe(1);
    expect(applied).toBe(0);
    expect(errors).toBe(1);
});

test("cancelled scoped restore releases a late result without applying or reporting an error", async () => {
    const localHydration = deferred<void>();
    const url = URL.createObjectURL(new Blob(["synthetic local preview"]));
    let applied = 0, errors = 0;
    const restoring = startProjectRestore(async () => {
        await localHydration.promise;
        return { objectUrls: [url] };
    }, () => { applied++; }, () => { errors++; }, {
        getScope: () => ({ accountId: "synthetic-restore-account", epoch: 1 }),
        discard: (value) => revokeCloudMediaObjectUrls(value.objectUrls),
    });
    try {
        restoring.cancel();
        localHydration.resolve();
        await restoring.settled;
        expect(applied).toBe(0);
        expect(errors).toBe(0);
        await expect(fetch(url)).rejects.toThrow();
    } finally { URL.revokeObjectURL(url); }
});

const restoredMediaMetadata = () => ({ items: [{ id: restoreMediaId, kind: "image", contentType: "image/png", sizeBytes: 3,
    createdAt: "2026-01-01T00:00:00.000Z", url: `/api/v1/media/${restoreMediaId}` }], missing: [] });

for (const stage of ["resolve", "download"] as const) {
    for (const [status, code] of [[409, "account_changed"], [401, "unauthorized"], [404, "not_found"], [503, "unavailable"]] as const) {
        test(`the production media loader rejects ${stage} HTTP ${status} even while the local account epoch is unchanged`, async () => {
            const h = accountRestoreFixture();
            await h.store.getState().initialize();
            const before = h.store.getState().getDraftScope()!;
            const stored = structuredClone(restoreDocument), original = structuredClone(stored);
            let loadedProjectId: string | null = null, applied = 0, failures = 0;
            const calls: string[] = [];
            const restoring = startProjectRestore((isCurrent) => loadProjectCloudMedia(stored, isCurrent,
                createMediaClient(() => isCurrent() ? h.store.getState().getDraftScope()?.accountId ?? null : null, async (path, init) => {
                    expect(new Headers(init?.headers).get("x-canvas-account-id")).toBe(before.accountId);
                    calls.push(String(path));
                    if (stage === "download" && String(path).endsWith("/resolve")) return Response.json(restoredMediaMetadata());
                    return Response.json({ error: { code } }, { status });
                })), () => { applied++; loadedProjectId = String(stored.id); }, () => { failures++; }, {
                getScope: () => h.store.getState().getDraftScope(),
                discard: (value) => revokeCloudMediaObjectUrls(value.objectUrls),
            });
            await restoring.settled;
            expect(h.store.getState().getDraftScope()).toEqual(before);
            expect(calls).toEqual(stage === "resolve" ? ["/api/v1/media/resolve"] : ["/api/v1/media/resolve", `/api/v1/media/${restoreMediaId}`]);
            expect(applied).toBe(0);
            expect(failures).toBe(1);
            expect(isProjectRestored(loadedProjectId, String(stored.id))).toBe(false);
            expect(stored).toEqual(original);
        });
    }
}

test("the production media loader adopts fresh URLs after successful HTTP without mutating the stored project", async () => {
    const h = accountRestoreFixture();
    await h.store.getState().initialize();
    const stored = structuredClone(restoreDocument), original = structuredClone(stored);
    const adopted: Awaited<ReturnType<typeof loadProjectCloudMedia<JsonObject>>>[] = [];
    let failures = 0;
    const restoring = startProjectRestore((isCurrent) => loadProjectCloudMedia(stored, isCurrent,
        createMediaClient(() => isCurrent() ? h.store.getState().getDraftScope()?.accountId ?? null : null, async (path) =>
            String(path).endsWith("/resolve") ? Response.json(restoredMediaMetadata()) : new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }))),
    (value) => { adopted.push(value); }, () => { failures++; }, {
        getScope: () => h.store.getState().getDraftScope(), discard: (value) => revokeCloudMediaObjectUrls(value.objectUrls),
    });
    try {
        await restoring.settled;
        expect(failures).toBe(0);
        expect(adopted).toHaveLength(1);
        expect(adopted[0].objectUrls).toHaveLength(1);
        const url = adopted[0].objectUrls[0];
        expect((adopted[0].project.nodes as JsonObject[])[0].metadata).toEqual({ cloudMediaId: restoreMediaId, content: url });
        expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
        expect(stored).toEqual(original);
    } finally { restoring.cancel(); adopted.forEach((value) => revokeCloudMediaObjectUrls(value.objectUrls)); }
});

test("the production media loader rejects a download completed after cancellation without allocating URLs", async () => {
    const h = accountRestoreFixture();
    await h.store.getState().initialize();
    const downloading = deferred<void>(), response = deferred<Response>();
    const created: string[] = [], nativeCreate = URL.createObjectURL.bind(URL);
    const create = spyOn(URL, "createObjectURL").mockImplementation((blob) => { const url = nativeCreate(blob); created.push(url); return url; });
    let applied = 0, failures = 0;
    const restoring = startProjectRestore((isCurrent) => loadProjectCloudMedia(restoreDocument, isCurrent,
        createMediaClient(() => isCurrent() ? h.store.getState().getDraftScope()?.accountId ?? null : null, async (path) => {
            if (String(path).endsWith("/resolve")) return Response.json(restoredMediaMetadata());
            downloading.resolve(); return response.promise;
        })), () => { applied++; }, () => { failures++; }, {
        getScope: () => h.store.getState().getDraftScope(), discard: (value) => revokeCloudMediaObjectUrls(value.objectUrls),
    });
    try {
        await downloading.promise;
        restoring.cancel();
        response.resolve(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
        await restoring.settled;
        expect(applied).toBe(0);
        expect(failures).toBe(0);
        expect(created).toHaveLength(0);
    } finally { restoring.cancel(); create.mockRestore(); revokeCloudMediaObjectUrls(created); }
});

for (const withLocalKey of [false, true]) test(`the production media loader rejects cloud references without a hydrator after cloudMedia closes (local key: ${withLocalKey})`, async () => {
    const h = accountRestoreFixture();
    await h.store.getState().initialize();
    await h.recheck("cloudMedia");
    const scope = h.store.getState().getDraftScope()!;
    expect(h.store.getState().site?.cloudMedia).toBe(false);
    const stored = structuredClone(restoreDocument);
    const expired = URL.createObjectURL(new Blob(["synthetic previous preview"]));
    URL.revokeObjectURL(expired);
    ((stored.nodes as JsonObject[])[0].metadata as JsonObject).content = expired;
    if (withLocalKey) ((stored.nodes as JsonObject[])[0].metadata as JsonObject).storageKey = "image:existing-local";
    const original = structuredClone(stored);
    let loadedProjectId: string | null = null, applied = 0, failures = 0, failure: unknown;
    const restoring = startProjectRestore(async (isCurrent) => {
        try { return await loadProjectCloudMedia(stored, isCurrent); }
        catch (error) { failure = error; throw error; }
    }, () => { applied++; loadedProjectId = String(stored.id); }, () => { failures++; }, {
        getScope: () => h.store.getState().getDraftScope(), discard: (value) => revokeCloudMediaObjectUrls(value.objectUrls),
    });
    await restoring.settled;
    expect(applied).toBe(0);
    expect(failures).toBe(1); // Same failure callback used by the existing page failure UI.
    expect(failure).toBeInstanceOf(CloudMediaHydrationError);
    expect(isProjectRestored(loadedProjectId, String(stored.id))).toBe(false);
    expect(h.store.getState().getDraftScope()).toEqual(scope);
    expect(stored).toEqual(original);
});

for (const withLocalKey of [false, true]) test(`the production media loader leaves a pure local project unchanged without media HTTP (local key: ${withLocalKey})`, async () => {
    const stored = structuredClone(restoreDocument);
    (stored.nodes as JsonObject[])[0].metadata = withLocalKey ? { storageKey: "image:existing-local", content: "blob:existing-local" } : { content: "本机原文字" };
    (stored.nodes as JsonObject[])[0].type = withLocalKey ? "image" : "text";
    const original = structuredClone(stored);
    let requests = 0;
    const media = createMediaClient(() => "synthetic-restore-account", async () => { requests++; throw new Error("unexpected media request"); });
    expect((await loadProjectCloudMedia(stored, () => true, media)).project).toBe(stored);
    expect((await loadProjectCloudMedia(stored, () => true)).project).toBe(stored);
    expect(requests).toBe(0);
    expect(stored).toEqual(original);
});
