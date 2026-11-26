import { expect, test } from "bun:test";
import { GenerationTrackingError, type GenerationTrackingItem, type GenerationTrackingResponse, type GenerationTrackingScope } from "../services/saas/generation";
import { createGenerationTracker, generationTrackingPresentation, type GenerationTrackerNotice, type GenerationTrackerRegistration } from "./use-generation-tracker";

const account: GenerationTrackingScope = { accountId: "synthetic-owner", epoch: 1 };
const id = (n = 1) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const initial = (n = 1, patch: Partial<GenerationTrackerRegistration> = {}): GenerationTrackerRegistration => ({ ...account, taskId: id(n), projectId: "original-canvas", modelId: "synthetic-text",
    originRoute: "/canvas/original-canvas", kindHint: "text", executionStatus: "running", deliveryStatus: "pending", billingStatus: "reserved", ...patch });
const task = (taskId: string, patch: Partial<GenerationTrackingItem> = {}): GenerationTrackingItem => ({ taskId, projectId: "original-canvas", nodeId: null, modelId: "synthetic-text",
    executionStatus: "running", deliveryStatus: "pending", billingStatus: "reserved", updatedAt: "2026-10-26T00:00:00.000Z", ...patch });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const settle = async () => { for (let i = 0; i < 8; ++i) await Promise.resolve(); };
function harness() {
    let scope: GenerationTrackingScope | null = account, clock = 0, timerId = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const delays: number[] = [];
    const calls: { ids: string[]; scope: GenerationTrackingScope; signal?: AbortSignal; gate: ReturnType<typeof deferred<GenerationTrackingResponse>> }[] = [];
    const notices: GenerationTrackerNotice[] = [], dismissed: string[] = [];
    const store = createGenerationTracker({ getScope: () => scope, now: () => clock,
        setTimer: (callback, delay) => { const key = ++timerId; delays.push(delay); timers.set(key, { at: clock + delay, callback }); return key; },
        clearTimer: handle => { timers.delete(handle as number); },
        clientFactory: captured => ({ read: (ids, signal) => { const gate = deferred<GenerationTrackingResponse>(); calls.push({ ids: [...ids], scope: captured, signal, gate }); return gate.promise; } }) });
    const sinks = { notify: (notice: GenerationTrackerNotice) => { notices.push(notice); }, dismiss: (key: string) => { dismissed.push(key); } };
    const cleanup = store.getState().start(sinks);
    return { store, calls, notices, dismissed, cleanup, sinks, delays,
        register: (value = initial()) => store.getState().register(value),
        entry: (n = 1) => Object.values(store.getState().entries).find(entry => entry.taskId === id(n)),
        setScope: (next: GenerationTrackingScope | null) => { scope = next; },
        async advance(ms = 0) {
            clock += ms;
            for (;;) {
                const next = [...timers.entries()].filter(([, value]) => value.at <= clock).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                timers.delete(next[0]); next[1].callback(); await settle();
            }
        },
        async resolve(index: number, patch: Partial<GenerationTrackingItem> = {}) {
            calls[index].gate.resolve({ items: calls[index].ids.map(value => task(value, patch)), missingTaskIds: [], requestId: `synthetic-${index}` }); await settle();
        },
        async reject(index: number, error: unknown) { calls[index].gate.reject(error); await settle(); },
    };
}

test("T4 tracker rotates 51 tasks as 50 then 1, waits after completion, and never overlaps deferred reads", async () => {
    const h = harness();
    for (let n = 1; n <= 51; ++n) h.register(initial(n));
    await h.advance();
    expect(h.calls).toHaveLength(1); expect(h.calls[0].ids).toEqual(Array.from({ length: 50 }, (_, n) => id(n + 1)));
    await h.advance(10000); expect(h.calls).toHaveLength(1);
    await h.resolve(0);
    await h.advance(2499); expect(h.calls).toHaveLength(1);
    await h.advance(1); expect(h.calls[1].ids).toEqual([id(51)]);
    await h.resolve(1); await h.advance(2500);
    expect(h.calls[2].ids).toEqual(h.calls[0].ids);
    h.register(initial(52)); await h.advance(10000); expect(h.calls).toHaveLength(3);
    await h.resolve(2); await h.advance(2500);
    expect(h.calls[3].ids).toEqual([id(51), id(52)]);
    expect(h.notices).toHaveLength(0); h.cleanup();
});

test("T4 duplicate registration preserves original source and terminal baselines do not announce completion", async () => {
    const h = harness();
    h.register(initial(1, { executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" }));
    h.register(initial(1, { originRoute: "/canvas/another", projectId: "another", modelId: "changed", kindHint: "image" }));
    await h.advance(100000);
    expect(h.calls).toHaveLength(0); expect(h.notices).toHaveLength(0);
    expect(h.entry()).toMatchObject({ originRoute: "/canvas/original-canvas", projectId: "original-canvas", modelId: "synthetic-text", kindHint: "text", polling: false });
    for (const originRoute of ["https://outside.invalid/canvas/a", "//outside.invalid/canvas/a", "/canvas/a?token=secret", "/canvas/a#token", "/canvas/../account"]) h.register(initial(2, { originRoute }));
    h.register(initial(3, { accountId: "foreign-owner" }));
    expect(Object.values(h.store.getState().entries)).toHaveLength(1); h.cleanup();
});

test("video uses original workbench route, pauses unknown and manual receipt restores the same tracker entry", async () => {
    const h = harness(), video = initial(1, { projectId: null, nodeId: null, originRoute: "/video", kindHint: "video" });
    h.register(video); await h.advance();
    await h.resolve(0, { projectId: null, executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" });
    expect(h.entry()?.polling).toBe(false); expect(h.notices.at(-1)?.title).toContain("平台视频");
    expect(h.notices.at(-1)?.description).toContain("视频工作台"); expect(h.notices.at(-1)?.originRoute).toBe("/video");
    await h.advance(10000); expect(h.calls).toHaveLength(1);
    expect(h.store.getState().reconcileVideoReceipt({ ...video, executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" })).toBe(true);
    expect(h.entry()).toMatchObject({ originRoute: "/video", kindHint: "video", polling: false, billingStatus: "captured" });
    expect(Object.values(h.store.getState().entries)).toHaveLength(1);
    expect(h.store.getState().reconcileVideoReceipt({ ...video, originRoute: "/audio" })).toBe(false); h.cleanup();
});

test("U1 notification unread state follows actual notices, viewing and later status changes", async () => {
    const h = harness(); h.register();
    expect(Object.values(h.store.getState().notices)).toHaveLength(0);
    await h.advance(); await h.resolve(0);
    expect(Object.values(h.store.getState().notices)).toHaveLength(0);
    await h.advance(2500); await h.resolve(1, { executionStatus: "queued" });
    const notice = Object.values(h.store.getState().notices)[0];
    expect(notice).toMatchObject({ ...account, read: false, taskId: id() });
    h.store.getState().markNoticesRead([notice.key]);
    expect(h.store.getState().notices[notice.key].read).toBe(true);
    await h.advance(2500); await h.resolve(2, { executionStatus: "queued" });
    expect(h.store.getState().notices[notice.key].read).toBe(true);
    await h.advance(2500); await h.resolve(3, { executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
    expect(Object.values(h.store.getState().notices)).toHaveLength(1);
    expect(h.store.getState().notices[notice.key]).toMatchObject({ read: false, level: "success" });
    h.store.getState().untrack(account.accountId, id());
    expect(Object.values(h.store.getState().notices)).toHaveLength(0);
    h.cleanup();
});

test("U1 notices clear on account changes and reject stale read actions and late responses", async () => {
    const h = harness(); h.register(); await h.advance();
    await h.resolve(0, { executionStatus: "queued" });
    const notice = Object.values(h.store.getState().notices)[0];
    await h.advance(2500);
    h.setScope({ accountId: "another-owner", epoch: 2 });
    h.store.getState().markNoticesRead([notice.key]);
    expect(h.store.getState().notices[notice.key].read).toBe(false);
    h.store.getState().syncAccount();
    expect(Object.values(h.store.getState().notices)).toHaveLength(0);
    await h.resolve(1, { executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
    expect(Object.values(h.store.getState().notices)).toHaveLength(0);
    expect(notice.isCurrent()).toBe(false);
    h.cleanup();
});

test("T4 audio review combinations pause polling while retaining nonterminal record states", async () => {
    for (const patch of [
        { executionStatus: "unknown" as const }, { executionStatus: "timeout" as const },
        { deliveryStatus: "unknown" as const }, { billingStatus: "pending_review" as const },
        { executionStatus: "succeeded" as const, deliveryStatus: "failed" as const },
    ]) {
        const h = harness();
        h.register(initial(1, { originRoute: "/audio", kindHint: "audio", projectId: null, ...patch }));
        expect(generationTrackingPresentation(h.entry()!).terminal).toBe(false);
        expect(h.entry()).toMatchObject({ originRoute: "/audio", kindHint: "audio", polling: false, ...patch });
        await h.advance(100000);
        expect(h.calls).toHaveLength(0); expect(h.notices).toHaveLength(0);
        h.register(initial(1, { originRoute: "/canvas/changed", kindHint: "text" }));
        expect(Object.values(h.store.getState().entries)).toHaveLength(1);
        expect(h.entry()?.originRoute).toBe("/audio"); h.cleanup();
    }
});

test("T4 manual audio reconciliation resumes one timer and dismisses its obsolete review notice", async () => {
    const h = harness(), audio = initial(1, { kindHint: "audio", originRoute: "/audio", projectId: null, nodeId: null });
    h.register(audio); await h.advance();
    await h.resolve(0, { projectId: null, executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" });
    expect(h.entry()?.polling).toBe(false); expect(h.notices).toHaveLength(1);
    const warning = h.notices[0];
    expect(h.store.getState().reconcileAudioReceipt(audio)).toBe(true);
    const scheduled = h.delays.length;
    expect(h.store.getState().reconcileAudioReceipt(audio)).toBe(true);
    expect(h.delays).toHaveLength(scheduled);
    expect(h.entry()).toMatchObject({ executionStatus: "running", deliveryStatus: "pending", billingStatus: "reserved", polling: true, readStatus: "ready" });
    expect(warning.isCurrent()).toBe(false); expect(h.dismissed).toEqual([warning.key]);
    await h.advance(2499); expect(h.calls).toHaveLength(1);
    await h.advance(1); expect(h.calls).toHaveLength(2);
    await h.resolve(1, { projectId: null }); expect(h.notices).toHaveLength(1); h.cleanup();
});

test("T4 a manual audio terminal receipt cannot be rolled back by a former in-flight batch", async () => {
    const h = harness(), audio = initial(1, { kindHint: "audio", originRoute: "/audio", projectId: null, nodeId: null });
    h.register(audio); await h.advance();
    const saved = { ...audio, executionStatus: "succeeded" as const, deliveryStatus: "saved" as const, billingStatus: "captured" as const };
    expect(h.store.getState().reconcileAudioReceipt(saved)).toBe(true);
    await h.resolve(0, { projectId: null, executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" });
    expect(h.entry()).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured", polling: false, readStatus: "ready" });
    expect(h.notices).toEqual([]);
    expect(h.store.getState().reconcileAudioReceipt(saved)).toBe(true);
    await h.advance(100000); expect(h.calls).toHaveLength(1); expect(h.notices).toEqual([]); h.cleanup();
});

test("T4 even an unchanged manual audio receipt supersedes its older batch without adding an immediate read", async () => {
    const h = harness(), audio = initial(1, { kindHint: "audio", originRoute: "/audio", projectId: null, nodeId: null });
    h.register(audio); await h.advance();
    const scheduled = h.delays.length;
    expect(h.store.getState().reconcileAudioReceipt(audio)).toBe(true);
    expect(h.store.getState().reconcileAudioReceipt(audio)).toBe(true);
    expect(h.delays).toHaveLength(scheduled); expect(h.calls).toHaveLength(1);
    await h.resolve(0, { projectId: null, executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" });
    expect(h.entry()).toMatchObject({ executionStatus: "running", deliveryStatus: "pending", billingStatus: "reserved", polling: true });
    expect(h.notices).toEqual([]);
    await h.advance(2499); expect(h.calls).toHaveLength(1);
    await h.advance(1); expect(h.calls).toHaveLength(2); h.cleanup();
});

test("T4 audio reconciliation cannot change the original scope, source or task association", () => {
    const h = harness(), audio = initial(1, { kindHint: "audio", originRoute: "/audio", projectId: null, nodeId: null,
        executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" });
    h.register(audio);
    for (const patch of [{ accountId: "foreign" }, { epoch: 2 }, { taskId: id(2) }, { modelId: "changed" }, { projectId: "changed" },
        { nodeId: "changed" }, { originRoute: "/image" }, { kindHint: "image" as const }]) {
        expect(h.store.getState().reconcileAudioReceipt({ ...audio, ...patch, executionStatus: "running" })).toBe(false);
        expect(h.entry()).toMatchObject(audio);
    }
    h.setScope({ ...account, epoch: 2 });
    expect(h.store.getState().reconcileAudioReceipt(audio)).toBe(false);
    expect(Object.values(h.store.getState().entries)).toHaveLength(0); h.cleanup();
});

test("T4 tracker updates three states at identical timestamps and deduplicates notices until trustworthy terminal settlement", async () => {
    const h = harness(); h.register(); await h.advance(); await h.resolve(0);
    expect(h.notices).toHaveLength(0);
    await h.advance(2500); await h.resolve(1, { executionStatus: "queued" });
    expect(h.notices).toHaveLength(1); const key = h.notices[0].key;
    await h.advance(2500); await h.resolve(2, { executionStatus: "queued" }); expect(h.notices).toHaveLength(1);
    await h.advance(2500); await h.resolve(3, { executionStatus: "succeeded", billingStatus: "captured" });
    expect(h.entry()).toMatchObject({ executionStatus: "succeeded", deliveryStatus: "pending", polling: true });
    expect(h.notices.at(-1)?.level).toBe("info"); expect(h.notices.at(-1)?.title).toContain("交付处理中");
    await h.advance(2500); await h.resolve(4, { executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "pending_review" });
    expect(h.entry()?.polling).toBe(true); expect(h.notices.at(-1)?.level).toBe("warning");
    await h.advance(2500); await h.resolve(5, { executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
    expect(h.entry()?.polling).toBe(false); expect(h.notices.at(-1)?.level).toBe("success");
    expect(new Set(h.notices.map(notice => notice.key))).toEqual(new Set([key]));
    expect(h.notices.every(notice => notice.isCurrent())).toBe(true);
    await h.advance(100000); expect(h.calls).toHaveLength(6); h.cleanup();
});

test("T4 tracker follows the approved terminal and review combinations without claiming refunds or result verification", () => {
    const cases: [GenerationTrackingItem["executionStatus"], GenerationTrackingItem["deliveryStatus"], GenerationTrackingItem["billingStatus"], boolean, GenerationTrackerNotice["level"]][] = [
        ["pending", "pending", "reserved", false, "info"], ["queued", "pending", "unbilled", false, "info"], ["running", "pending", "captured", false, "info"],
        ["succeeded", "pending", "captured", false, "info"], ["succeeded", "saved", "unbilled", false, "info"], ["succeeded", "visible", "reserved", false, "info"],
        ["succeeded", "saved", "captured", true, "success"], ["failed", "failed", "released", true, "error"], ["cancelled", "failed", "unbilled", true, "info"],
        ["unknown", "visible", "captured", false, "warning"], ["timeout", "pending", "unbilled", false, "warning"], ["succeeded", "unknown", "captured", false, "warning"],
        ["succeeded", "failed", "captured", false, "warning"], ["succeeded", "visible", "pending_review", false, "warning"],
        ["failed", "pending", "released", false, "warning"], ["cancelled", "failed", "reserved", false, "warning"], ["succeeded", "visible", "released", false, "warning"],
    ];
    for (const [executionStatus, deliveryStatus, billingStatus, terminal, level] of cases) {
        const presentation = generationTrackingPresentation({ executionStatus, deliveryStatus, billingStatus });
        expect(presentation).toMatchObject({ terminal, level });
        expect(presentation.description).not.toMatch(/退款|到账|扣款|免费|已落.*画布/);
    }
    expect(generationTrackingPresentation({ executionStatus: "failed", deliveryStatus: "failed", billingStatus: "unbilled" }).description).toContain("未计费");
    expect(generationTrackingPresentation({ executionStatus: "failed", deliveryStatus: "failed", billingStatus: "released" }).description).toContain("冻结积分已释放");
});

test("T4 temporary read errors preserve status, respect Retry-After, and recover using only the same task read", async () => {
    const h = harness(); h.register(); await h.advance();
    await h.reject(0, new GenerationTrackingError("rate_limited", "private server error must not appear", 429, 9000));
    expect(h.entry()).toMatchObject({ executionStatus: "running", deliveryStatus: "pending", billingStatus: "reserved", polling: true, readStatus: "unconfirmed" });
    expect(h.notices).toHaveLength(1); expect(h.notices[0].description).not.toContain("private server error");
    await h.advance(8999); expect(h.calls).toHaveLength(1);
    await h.advance(1); expect(h.calls[1].ids).toEqual([id()]);
    await h.reject(1, new Error("network failure")); expect(h.notices).toHaveLength(1);
    await h.advance(2499); expect(h.calls).toHaveLength(2);
    await h.advance(1); await h.resolve(2);
    expect(h.entry()?.readStatus).toBe("ready"); expect(h.notices).toHaveLength(2);
    expect(h.notices[1].key).toBe(h.notices[0].key); h.cleanup();
});

test("T4 Retry-After beyond the browser timer range waits in segments without reading before its deadline", async () => {
    const h = harness(), maximumTimer = 0x7fffffff;
    h.register(); await h.advance();
    await h.reject(0, new GenerationTrackingError("rate_limited", "private", 429, maximumTimer + 5000));
    expect(h.delays.at(-1)).toBe(maximumTimer);
    await h.advance(maximumTimer);
    expect(h.calls).toHaveLength(1); expect(h.delays.at(-1)).toBe(5000);
    await h.advance(4999); expect(h.calls).toHaveLength(1);
    await h.advance(1); expect(h.calls).toHaveLength(2);
    expect(h.delays.every(delay => delay >= 0 && delay <= maximumTimer)).toBe(true); h.cleanup();
});

test("T4 missing pauses a task without declaring rejection or changing its last statuses", async () => {
    const h = harness(); h.register(); await h.advance();
    h.calls[0].gate.resolve({ items: [], missingTaskIds: [id()], requestId: "missing" }); await settle();
    expect(h.entry()).toMatchObject({ executionStatus: "running", deliveryStatus: "pending", billingStatus: "reserved", readStatus: "missing", polling: false });
    expect(h.notices).toHaveLength(1); expect(h.notices[0].description).toContain("主动核对");
    await h.advance(100000); expect(h.calls).toHaveLength(1);
    const notice = h.notices[0]; h.cleanup(); expect(notice.isCurrent()).toBe(false); expect(h.dismissed).toEqual([notice.key]);
});

test("T4 a response with mismatched source cannot change origin metadata or declare completion", async () => {
    const h = harness(); h.register(initial(1, { nodeId: "original-node" })); await h.advance();
    await h.resolve(0, { projectId: "foreign-canvas", modelId: "foreign-model", nodeId: "foreign-node", executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
    expect(h.entry()).toMatchObject({ originRoute: "/canvas/original-canvas", projectId: "original-canvas", nodeId: "original-node", modelId: "synthetic-text", executionStatus: "running", polling: true, readStatus: "unconfirmed" });
    expect(h.notices.at(-1)?.level).toBe("warning"); h.cleanup();
});

test("T4 account epoch invalidation aborts, clears notices, and isolates an ignored-abort late response", async () => {
    const h = harness(); h.register(); await h.advance(); await h.resolve(0, { executionStatus: "queued" });
    const notice = h.notices[0]; await h.advance(2500);
    h.setScope({ ...account, epoch: 2 });
    expect(notice.isCurrent()).toBe(false); h.store.getState().syncAccount();
    expect(h.calls[1].signal?.aborted).toBe(true); expect(h.dismissed).toContain(notice.key); expect(Object.values(h.store.getState().entries)).toHaveLength(0);
    h.register(initial(2, { epoch: 2 })); await h.advance(10000); expect(h.calls).toHaveLength(2);
    await h.resolve(1, { executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
    expect(h.entry()).toBeUndefined(); expect(h.entry(2)?.executionStatus).toBe("running"); expect(h.notices).toHaveLength(1);
    await h.advance(2500); expect(h.calls[2].scope.epoch).toBe(2); expect(h.calls[2].ids).toEqual([id(2)]);
    h.setScope(null); h.store.getState().syncAccount(); expect(h.calls[2].signal?.aborted).toBe(true); h.cleanup();
});

test("T4 untrack and re-register of the same task cannot consume the former identity's late completion", async () => {
    const h = harness(); h.register(); await h.advance();
    h.store.getState().untrack(account.accountId, id());
    h.register(initial(1, { originRoute: "/canvas/new-source" }));
    await h.resolve(0, { executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
    expect(h.entry()).toMatchObject({ originRoute: "/canvas/new-source", executionStatus: "running", polling: true }); expect(h.notices).toHaveLength(0);
    await h.advance(2500); await h.resolve(1, { executionStatus: "queued" });
    const notice = h.notices[0]; expect(notice.isCurrent()).toBe(true);
    h.store.getState().untrack(account.accountId, id()); expect(notice.isCurrent()).toBe(false); expect(h.dismissed).toContain(notice.key); h.cleanup();
});

test("T4 stop invalidates old actions and a restart waits for an old ignored-abort read before continuing", async () => {
    const h = harness(); h.register(); await h.advance(); await h.resolve(0, { executionStatus: "queued" });
    const notice = h.notices[0]; await h.advance(2500); h.cleanup();
    expect(h.calls[1].signal?.aborted).toBe(true); expect(notice.isCurrent()).toBe(false); expect(h.store.getState().running).toBe(false);
    const restarted = h.store.getState().start(h.sinks); await h.advance(10000); expect(h.calls).toHaveLength(2);
    h.cleanup(); expect(h.store.getState().running).toBe(true);
    await h.resolve(1, { executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" });
    expect(h.entry()?.executionStatus).toBe("queued"); expect(h.notices).toHaveLength(1);
    await h.advance(2500); expect(h.calls).toHaveLength(3); expect(notice.isCurrent()).toBe(false); restarted();
});

test("T4 unauthorized stops all old-account entries and cannot be restarted without a new authoritative scope", async () => {
    for (const error of [new GenerationTrackingError("unauthorized", "private", 401), new GenerationTrackingError("account_changed", "private", 409), new GenerationTrackingError("account_context_required", "private", 400)]) {
        const h = harness(); for (let n = 1; n <= 51; ++n) h.register(initial(n)); await h.advance(); await h.reject(0, error);
        expect(Object.values(h.store.getState().entries).every(entry => !entry.polling && entry.readStatus === "account-stopped")).toBe(true);
        h.register(initial(52)); h.store.getState().syncAccount(); await h.advance(100000);
        expect(h.calls).toHaveLength(1); expect(h.entry(52)).toBeUndefined(); expect(h.notices).toHaveLength(0);
        h.setScope({ ...account, epoch: 2 }); h.store.getState().syncAccount(); h.register(initial(52, { epoch: 2 })); await h.advance();
        expect(h.calls).toHaveLength(2); expect(h.calls[1].ids).toEqual([id(52)]); h.cleanup();
    }
});
