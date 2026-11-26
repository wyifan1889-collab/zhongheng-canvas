import { expect, test } from "bun:test";
import { createCanvasReceiptReview, CanvasReceiptReviewError, type CanvasReceiptReviewContext } from "./canvas-receipt-review";
import { createReceiptedDraftClient } from "./creation-receipts";
import { DraftError, type DraftCreationCheck, type DraftCreationReference } from "./drafts";

const id = "a1b2c3d4-e5f6-47a8-b9c0-123456abcdef", otherId = "b1b2c3d4-e5f6-47a8-b9c0-123456abcdef";
const scope: CanvasReceiptReviewContext = { accountId: "synthetic-account-A", epoch: 1, localProjectId: "synthetic-project-A" };
const found = (projectId = scope.localProjectId): DraftCreationCheck => ({ status: "found-current", draft: {
    id, title: "synthetic-private-title", revision: 2, updatedAt: "2026-01-01T00:00:01.000Z", createdAt: "2026-01-01T00:00:00.000Z",
    documentVersion: 1, document: { id: projectId, nodes: [{ content: "synthetic-private-document" }], media: "synthetic-private-media" },
} });
const reference = (reconcile: () => Promise<DraftCreationCheck> = async () => found()): DraftCreationReference => ({ id, reconcile });
function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const outcome = <T>(value: Promise<T>) => value.then((result) => ({ result }), (error) => ({ error }));
async function safeError(value: Promise<unknown>, code: string) {
    const error = await value.catch((failure) => failure);
    expect(error).toBeInstanceOf(CanvasReceiptReviewError);
    expect(error.code).toBe(code);
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("document");
    expect(String(error)).not.toContain("synthetic-private");
    return error;
}

test("construction has zero I/O; load reads every reference and only explicit check performs GET", async () => {
    const methods: string[] = [], projects: string[] = [];
    let factories = 0, puts = 0;
    const review = createCanvasReceiptReview(() => scope, (getScope) => {
        factories++;
        return createReceiptedDraftClient(getScope, {
            async put() { puts++; throw new Error("must not write"); },
            async list(accountId, localProjectId) {
                expect(accountId).toBe(scope.accountId); projects.push(localProjectId);
                return [id, otherId].map((creationId) => ({ accountId, localProjectId, creationId }));
            },
        }, (async (path, options) => {
            methods.push(options!.method!);
            expect(path).toBe(`/api/v1/canvases/${id}`);
            expect(options!.body).toBeUndefined();
            expect(new Headers(options!.headers).get("x-canvas-account-id")).toBe(scope.accountId);
            const value = found();
            return Response.json({ draft: value.status === "found-current" ? value.draft : null });
        }) as typeof fetch);
    });
    expect(Object.keys(review).sort()).toEqual(["check", "dispose", "load"]);
    expect(factories).toBe(0); expect(projects).toEqual([]); expect(methods).toEqual([]);
    expect(await review.load()).toEqual([{ id, status: "unchecked" }, { id: otherId, status: "unchecked" }]);
    expect(factories).toBe(1); expect(projects).toEqual([scope.localProjectId]); expect(methods).toEqual([]);
    const checked = await review.check(id.toUpperCase());
    expect(checked).toEqual({ id, status: "found-current", revision: 2, updatedAt: "2026-01-01T00:00:01.000Z" });
    expect(Object.isFrozen(checked)).toBe(true);
    expect(JSON.stringify(checked)).not.toContain("synthetic-private");
    expect(methods).toEqual(["GET"]); expect(puts).toBe(0);
});

test("unknown or not-loaded IDs cannot trigger a request, and an empty list is not an error", async () => {
    let checks = 0;
    const review = createCanvasReceiptReview(() => scope, () => ({ recover: async () => [reference(async () => { checks++; return found(); })] }));
    await safeError(review.check(id), "not_loaded");
    await review.load();
    for (const candidate of [otherId, "", "../secret", `${id}?q=synthetic-private`, null, 1]) await safeError(review.check(candidate as string), "not_loaded");
    expect(checks).toBe(0);
    expect(await createCanvasReceiptReview(() => scope, () => ({ recover: async () => [] })).load()).toEqual([]);
});

test("found results expose no title, document or media and never cache the previous response", async () => {
    let checks = 0, privateReads = 0;
    const review = createCanvasReceiptReview(() => scope, () => ({ recover: async () => [reference(async () => {
        checks++;
        return { status: "found-current", draft: {
            id, revision: checks, updatedAt: "2026-01-01T00:00:00.000Z", documentVersion: 1, createdAt: "2026-01-01T00:00:00.000Z",
            get title() { privateReads++; throw new Error("synthetic-private-title"); },
            document: { id: scope.localProjectId, get media() { privateReads++; throw new Error("synthetic-private-media"); } },
        } };
    })] }));
    await review.load();
    const first = await review.check(id), second = await review.check(id);
    expect(first).toMatchObject({ status: "found-current", revision: 1 });
    expect(second).toMatchObject({ status: "found-current", revision: 2 });
    expect(Object.keys(second).sort()).toEqual(["id", "revision", "status", "updatedAt"]);
    expect(checks).toBe(2); expect(privateReads).toBe(0);
});

test("not-found-yet keeps the loaded reference and does not infer a failed creation", async () => {
    let checks = 0;
    const review = createCanvasReceiptReview(() => scope, () => ({ recover: async () => [reference(async () => {
        checks++; return checks === 1 ? { status: "not-found-yet" } : found();
    })] }));
    await review.load();
    expect(await review.check(id)).toEqual({ id, status: "not-found-yet" });
    expect(checks).toBe(1);
    expect(await review.check(id)).toMatchObject({ status: "found-current" });
    expect(checks).toBe(2);
});

test("a different or missing local project ID is refused without returning cloud content", async () => {
    for (const value of [found("other-project"), { ...found(), status: "found-current", draft: { ...(found() as Extract<DraftCreationCheck, { status: "found-current" }>).draft, document: {} } }]) {
        let checks = 0;
        const review = createCanvasReceiptReview(() => scope, () => ({ recover: async () => [reference(async () => { checks++; return value as DraftCreationCheck; })] }));
        await review.load();
        await safeError(review.check(id), "project_mismatch");
        expect(checks).toBe(1);
    }
});

test("malformed summaries or foreign creation IDs are safe failures, never found or absent", async () => {
    const valid = (found() as Extract<DraftCreationCheck, { status: "found-current" }>).draft;
    for (const value of [
        null, { status: "synthetic-private" }, { status: "found-current", draft: null },
        ...[{ id: otherId }, { revision: 0 }, { revision: 1.5 }, { updatedAt: "synthetic-private-invalid-date" }].map((patch) => ({ status: "found-current", draft: { ...valid, ...patch } })),
    ]) {
        const review = createCanvasReceiptReview(() => scope, () => ({ recover: async () => [reference(async () => value as DraftCreationCheck)] }));
        await review.load();
        await safeError(review.check(id), "unavailable");
    }
});

test("failed loads erase old references and malformed or duplicate references cannot be partially loaded", async () => {
    for (const next of [null, [reference(), null], [reference(), { ...reference(), id: "bad" }], [reference(), { ...reference(), id: id.toUpperCase() }], [reference(), { id: otherId }]]) {
        let loads = 0, checks = 0;
        const review = createCanvasReceiptReview(() => scope, () => ({ recover: async () => ++loads === 1
            ? [reference(async () => { checks++; return found(); })] : next as DraftCreationReference[] }));
        await review.load();
        await safeError(review.load(), "receipt_unavailable");
        await safeError(review.check(id), "not_loaded");
        expect(checks).toBe(0);
    }
    let loads = 0;
    const review = createCanvasReceiptReview(() => scope, () => ({ recover: async () => {
        if (++loads > 1) throw new Error("synthetic-private-storage");
        return [reference()];
    } }));
    await review.load();
    await safeError(review.load(), "receipt_unavailable");
    await safeError(review.check(id), "not_loaded");
});

test("account, epoch and project changes permanently invalidate even after restoring the old context", async () => {
    for (const [next, code] of [
        [null, "account_changed"], [{ ...scope, accountId: "synthetic-account-B", epoch: 2 }, "account_changed"],
        [{ ...scope, epoch: 2 }, "account_changed"], [{ ...scope, localProjectId: "synthetic-project-B" }, "context_changed"],
    ] as const) {
        let active: CanvasReceiptReviewContext | null = { ...scope }, reads = 0;
        const review = createCanvasReceiptReview(() => active, () => ({ recover: async () => { reads++; return [reference()]; } }));
        await review.load();
        active = next;
        await safeError(review.check(id), code);
        active = { ...scope };
        await safeError(review.load(), code);
        await safeError(review.check(id), code);
        expect(reads).toBe(1);
    }
});

test("late load success or failure after an account epoch change never publishes references", async () => {
    for (const reject of [false, true]) {
        const gate = deferred<DraftCreationReference[]>();
        let active = { ...scope };
        const review = createCanvasReceiptReview(() => active, () => ({ recover: () => gate.promise }));
        const pending = outcome(review.load());
        active = { ...scope, accountId: "synthetic-account-B", epoch: 2 };
        active = { ...scope, epoch: 3 }; // A -> B -> A still has a different confirmed lifetime.
        if (reject) gate.reject(new Error("synthetic-private-late")); else gate.resolve([reference()]);
        expect(await pending).toMatchObject({ error: { code: "account_changed" } });
        await safeError(review.check(id), "account_changed");
    }
});

test("late check success, absence and failure after project change are discarded", async () => {
    for (const response of [found(), { status: "not-found-yet" } as const, new Error("synthetic-private-late")]) {
        const gate = deferred<DraftCreationCheck>();
        let active = { ...scope };
        const review = createCanvasReceiptReview(() => active, () => ({ recover: async () => [reference(() => gate.promise)] }));
        await review.load();
        const pending = outcome(review.check(id));
        active = { ...scope, localProjectId: "synthetic-project-B" };
        if (response instanceof Error) gate.reject(response); else gate.resolve(response);
        expect(await pending).toMatchObject({ error: { code: "context_changed" } });
        active = { ...scope };
        await safeError(review.check(id), "context_changed");
    }
});

test("dispose blocks late load/check and reopening requires a fresh independent controller", async () => {
    for (const phase of ["load", "check"] as const) {
        const loading = deferred<DraftCreationReference[]>(), checking = deferred<DraftCreationCheck>();
        const old = createCanvasReceiptReview(() => scope, () => ({ recover: () => phase === "load" ? loading.promise : Promise.resolve([reference(() => checking.promise)]) }));
        if (phase === "check") await old.load();
        const pending = outcome(phase === "load" ? old.load() : old.check(id));
        old.dispose(); old.dispose();
        const fresh = createCanvasReceiptReview(() => scope, () => ({ recover: async () => [reference()] }));
        expect(await fresh.load()).toEqual([{ id, status: "unchecked" }]);
        if (phase === "load") loading.resolve([reference()]); else checking.resolve(found());
        expect(await pending).toMatchObject({ error: { code: "context_changed" } });
        await safeError(old.check(id), "context_changed");
        expect(await fresh.check(id)).toMatchObject({ status: "found-current" });
    }
});

test("a newer load supersedes late load/check responses without restoring old references", async () => {
    for (const phase of ["load", "check"] as const) {
        const loading = deferred<DraftCreationReference[]>(), checking = deferred<DraftCreationCheck>();
        let loads = 0;
        const review = createCanvasReceiptReview(() => scope, () => ({ recover: async () => {
            loads++;
            if (loads > 1) return [{ id: otherId, reconcile: async () => ({ status: "not-found-yet" as const }) }];
            return phase === "load" ? loading.promise : [reference(() => checking.promise)];
        } }));
        if (phase === "check") await review.load();
        const earlier = outcome(phase === "load" ? review.load() : review.check(id));
        expect(await review.load()).toEqual([{ id: otherId, status: "unchecked" }]);
        if (phase === "load") loading.resolve([reference()]); else checking.resolve(found());
        expect(await earlier).toMatchObject({ error: { code: "superseded" } });
        await safeError(review.check(id), "not_loaded");
        expect(await review.check(otherId)).toEqual({ id: otherId, status: "not-found-yet" });
    }
});

test("a newer check can complete while every later-arriving older outcome is superseded", async () => {
    for (const response of [found(), { status: "not-found-yet" } as const, new Error("synthetic-private-old-check")]) {
        const gate = deferred<DraftCreationCheck>();
        let checks = 0;
        const review = createCanvasReceiptReview(() => scope, () => ({ recover: async () => [reference(() => ++checks === 1 ? gate.promise : Promise.resolve(found()))] }));
        await review.load();
        const earlier = outcome(review.check(id));
        const latest = await review.check(id);
        expect(latest).toMatchObject({ status: "found-current", revision: 2 });
        if (response instanceof Error) gate.reject(response); else gate.resolve(response);
        expect(await earlier).toMatchObject({ error: { code: "superseded" } });
        expect(latest).toEqual({ id, status: "found-current", revision: 2, updatedAt: "2026-01-01T00:00:01.000Z" });
        expect(checks).toBe(2);
    }
});

test("a newer failed load cannot be undone by a late successful check", async () => {
    const gate = deferred<DraftCreationCheck>();
    let loads = 0, checks = 0;
    const review = createCanvasReceiptReview(() => scope, () => ({ recover: async () => {
        if (++loads > 1) throw new Error("synthetic-private-new-load");
        return [reference(() => { checks++; return gate.promise; })];
    } }));
    await review.load();
    const earlier = outcome(review.check(id));
    await safeError(review.load(), "receipt_unavailable");
    gate.resolve(found());
    expect(await earlier).toMatchObject({ error: { code: "superseded" } });
    await safeError(review.check(id), "not_loaded");
    expect(checks).toBe(1);
});

test("account refusals remain account_changed and permanently invalidate both operations", async () => {
    for (const source of ["account_changed", "account_context_required", "unauthorized"]) {
        let checks = 0;
        const review = createCanvasReceiptReview(() => scope, () => ({ recover: async () => [reference(async () => {
            checks++; throw new DraftError(source, "synthetic-private-auth");
        })] }));
        await review.load();
        await safeError(review.check(id), "account_changed");
        await safeError(review.load(), "account_changed");
        await safeError(review.check(id), "account_changed");
        expect(checks).toBe(1);
    }
    await safeError(createCanvasReceiptReview(() => scope, () => ({ recover: async () => { throw new DraftError("account_changed", "synthetic-private-storage-wrapper"); } })).load(), "account_changed");
});

test("unknown errors are sanitized, while only valid supplied rate-limit seconds are retained", async () => {
    for (const seconds of [17, 0, -1, 1.5, Number.NaN, undefined]) {
        let checks = 0;
        const review = createCanvasReceiptReview(() => scope, () => ({ recover: async () => [reference(async () => {
            checks++; throw new DraftError("rate_limited", "synthetic-private-429", 429, "rejected", undefined, seconds);
        })] }));
        await review.load();
        const error = await safeError(review.check(id), "rate_limited");
        expect(error.retryAfter).toBe(seconds === 17 ? 17 : undefined);
        expect(checks).toBe(1);
    }
    const review = createCanvasReceiptReview(() => scope, () => ({ recover: async () => [reference(async () => { throw new Error("synthetic-private-network"); })] }));
    await review.load();
    await safeError(review.check(id), "unavailable");
    await safeError(createCanvasReceiptReview(() => scope, () => { throw new Error("synthetic-private-factory"); }).load(), "receipt_unavailable");
});
