import { expect, test } from "bun:test";
import type { CanvasDraft } from "../../../../packages/shared/src/index";
import type { CanvasFirstSaveContext } from "../../services/saas/canvas-first-save";
import { createDraftClient } from "../../services/saas/drafts";
import { CanvasVersionSaveError, createCanvasVersionSession, type CanvasVersionSelection } from "../../services/saas/canvas-version-save";
import { createCanvasCloudSelection } from "./canvas-cloud-selection";

const firstId = "a1b2c3d4-e5f6-47a8-b9c0-123456abcdef", nextId = "b1b2c3d4-e5f6-47a8-b9c0-123456abcdef";
const context: CanvasFirstSaveContext = { accountId: "synthetic-selection-account", epoch: 1, localProjectId: "synthetic-project", cloudCanvas: true };
const select = (id = firstId) => ({ accountId: context.accountId, id, revision: 1 });
const response = (id = firstId) => Response.json({ draft: {
    id, revision: 1, title: "synthetic", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", documentVersion: 1,
    document: { id: "source-project", title: "synthetic", nodes: [], connections: [], chatSessions: [] },
} satisfies CanvasDraft });
const outcome = <T>(value: Promise<T>) => value.then((result) => ({ result }), (error) => ({ error }));
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}
function harness() {
    let open = true, current: CanvasFirstSaveContext | null = { ...context };
    let adopted: ReturnType<typeof createCanvasVersionSession> | null = null;
    const modes: string[] = [], requests: string[] = [], replies = [deferred<Response>(), deferred<Response>()];
    const candidates: ReturnType<typeof createCanvasVersionSession>[] = [];
    let afterVerified: (() => void) | undefined;
    const createSession = () => createCanvasVersionSession(() => current, (getScope) => createDraftClient(getScope, Object.assign(async (path: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("GET");
        requests.push(String(path));
        return replies[requests.length - 1].promise;
    }, { preconnect: fetch.preconnect })));
    const controller = createCanvasCloudSelection(() => open, () => {
        const candidate = createSession(), resume = candidate.resumeFromCloudSelection;
        candidates.push(candidate);
        return afterVerified ? { ...candidate, async resumeFromCloudSelection(selection: CanvasVersionSelection) { await resume(selection); afterVerified?.(); } } : candidate;
    }, (candidate) => {
        if (adopted) throw new CanvasVersionSaveError("already_seeded", "unknown");
        adopted = candidate; modes.push("version");
    });
    return { controller, candidates, requests, replies, modes, adopted: () => adopted,
        setOpen: (value: boolean) => { open = value; }, setContext: (value: CanvasFirstSaveContext | null) => { current = value; },
        afterVerified: (callback: () => void) => { afterVerified = callback; },
        acknowledgeCreation() { adopted = createSession(); adopted.seedCreation({ id: nextId, revision: 1, updatedAt: "2026-01-01T00:00:00Z" }); },
    };
}

test("closing and reopening directory confirmation keeps B when canceled A returns last", async () => {
    const h = harness(), first = outcome(h.controller.confirm(select()));
    h.controller.cancel();
    const next = outcome(h.controller.confirm(select(nextId)));
    h.replies[1].resolve(response(nextId));
    expect(await next).toEqual({ result: undefined });
    h.replies[0].resolve(response());
    expect(await first).toMatchObject({ error: { code: "context_changed" } });
    expect(h.adopted()?.getState()).toEqual({ status: "ready", id: nextId, revision: 1 });
    expect(h.candidates[0].getState()).toEqual({ status: "blocked" });
    expect(h.modes).toEqual(["version"]);
    h.controller.cancel(); // Closing the dialog must not dispose its already adopted session.
    h.adopted()!.open().close();
    expect(h.adopted()?.getState()).toEqual({ status: "ready", id: nextId, revision: 1 });
    h.adopted()?.dispose();
});

test("closing the parent before lifecycle cleanup prevents a late candidate from changing mode or baseline", async () => {
    const h = harness(), pending = outcome(h.controller.confirm(select()));
    h.setOpen(false);
    h.replies[0].resolve(response());
    expect(await pending).toMatchObject({ error: { code: "window_closed" } });
    expect(h.adopted()).toBeNull(); expect(h.modes).toEqual([]);
    expect(h.candidates[0].getState()).toEqual({ status: "blocked" });
    h.setOpen(true);
    const next = outcome(h.controller.confirm(select(nextId)));
    h.replies[1].resolve(response(nextId));
    expect(await next).toEqual({ result: undefined });
    expect(h.adopted()?.getState()).toMatchObject({ id: nextId });
    h.adopted()?.dispose();
});

test("confirmation blocks same-frame duplicates and cannot replace a directly acknowledged creation", async () => {
    const h = harness(), pending = outcome(h.controller.confirm(select()));
    expect(await outcome(h.controller.confirm(select(nextId)))).toMatchObject({ error: { code: "busy", outcome: "not-sent" } });
    expect(h.requests).toHaveLength(1);
    h.acknowledgeCreation();
    h.replies[0].resolve(response());
    expect(await pending).toMatchObject({ error: { code: "already_seeded" } });
    expect(h.adopted()?.getState()).toEqual({ status: "ready", id: nextId, revision: 1 });
    expect(h.candidates[0].getState()).toEqual({ status: "blocked" });
    expect(h.modes).toEqual([]);
    h.adopted()?.dispose();
});

for (const change of ["account", "epoch", "project"] as const) test(`a ${change} change during directory GET cannot establish a baseline`, async () => {
    const h = harness(), pending = outcome(h.controller.confirm(select()));
    h.setContext({ ...context, ...(change === "account" ? { accountId: "synthetic-other" } : change === "epoch" ? { epoch: 2 } : { localProjectId: "other-project" }) });
    h.replies[0].resolve(response());
    expect(await pending).toHaveProperty("error");
    expect(h.adopted()).toBeNull(); expect(h.modes).toEqual([]);
    expect(h.candidates[0].getState()).toEqual({ status: "blocked" });
});

test("scope is checked again after candidate verification before page ownership transfer", async () => {
    const h = harness();
    h.afterVerified(() => h.setContext({ ...context, epoch: 2 }));
    const pending = outcome(h.controller.confirm(select()));
    h.replies[0].resolve(response());
    expect(await pending).toMatchObject({ error: { code: "account_changed" } });
    expect(h.adopted()).toBeNull(); expect(h.modes).toEqual([]);
    expect(h.candidates[0].getState()).toEqual({ status: "blocked" });
});
