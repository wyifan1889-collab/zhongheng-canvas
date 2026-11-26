import { expect, test } from "bun:test";
import { createAudioGenerationClient, type AudioGenerationScope, type AudioGenerationTaskView } from "@/services/saas/audio-generation";
import { createGenerationTracker, type GenerationTrackerNotice, type GenerationTrackerRegistration } from "@/stores/use-generation-tracker";
import { createAudioTaskRegistration } from "./audio-task-tracking";

const scope: AudioGenerationScope = { accountId: "synthetic-audio-owner", epoch: 4 };
const taskId = "11111111-1111-4111-8111-111111111111";
const view = (patch: Partial<AudioGenerationTaskView["task"]> = {}): AudioGenerationTaskView => ({ task: {
    id: taskId, projectId: null, nodeId: null, modelId: "synthetic-audio", priceVersion: 1, quotedUnits: 1,
    billingUnitSnapshot: "request", creditsPerUnitSnapshot: 1,
    audioSnapshot: { status: "recorded", input: { text: "合成朗读文字" }, parameters: { voice: "default", format: "wav" } },
    executionStatus: "queued", deliveryStatus: "pending", billingStatus: "reserved", ...patch,
}, result: null });

test("audio registers one verified task after a single confirmed submission, and recovery never submits again", async () => {
    const registrations: GenerationTrackerRegistration[] = [], calls: { path: string; method?: string }[] = [];
    const register = createAudioTaskRegistration({ scope, getScope: () => scope, isCurrent: () => true,
        tracker: { getState: () => ({ register: value => { registrations.push(value); },
            reconcileAudioReceipt: value => registrations.some(item => item.taskId === value.taskId) }) } });
    const model = { id: "synthetic-audio", displayName: "合成语音", capability: "audio", group: null,
        audio: { voices: ["default"], formats: ["wav"], instructions: false },
        audioPricing: { priceVersion: 1, billingUnit: "request", creditsPerUnit: 1 } };
    const client = createAudioGenerationClient({ scope, getScope: () => scope, fetcher: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input); calls.push({ path, method: init?.method });
        return Response.json(path.endsWith("/models") ? { items: [model] } : path.endsWith("/quote")
            ? { quote: { modelId: model.id, ...model.audioPricing, quotedUnits: 1, quoteFingerprint: "a".repeat(64) } } : view());
    }, { preconnect: fetch.preconnect }) });
    const intent = { modelId: model.id, input: { text: "合成朗读文字" }, parameters: { voice: "default", format: "wav" as const } };
    await client.models(); const quote = await client.quote(intent);
    expect(registrations).toEqual([]);
    const accepted = await client.submit(intent, quote, "audio:11111111-1111-4111-8111-111111111111");
    const saved = structuredClone(accepted); register(saved.task.id, saved);
    register(taskId, await client.get(taskId)); register(taskId, await client.recover("audio:11111111-1111-4111-8111-111111111111"));
    expect(registrations).toEqual([{ ...scope, taskId, projectId: null, nodeId: null, modelId: model.id,
        originRoute: "/audio", kindHint: "audio", executionStatus: "queued", deliveryStatus: "pending", billingStatus: "reserved" }]);
    expect(JSON.stringify(registrations)).not.toContain("合成朗读文字");
    expect(calls.filter(call => call.method === "POST" && call.path.endsWith("/tasks"))).toHaveLength(1);
});

test("audio cannot register an unconfirmed identity, a departed page, or a late previous-account response", () => {
    let current: AudioGenerationScope | null = scope, live = true;
    const registrations: GenerationTrackerRegistration[] = [];
    const register = createAudioTaskRegistration({ scope, getScope: () => current, isCurrent: () => live,
        tracker: { getState: () => ({ register: value => { registrations.push(value); }, reconcileAudioReceipt: () => false }) } });
    register("unconfirmed-receipt", view()); register(taskId, view({ id: "not-a-task-id" }));
    current = { ...scope, epoch: scope.epoch + 1 }; register(taskId, view());
    current = { ...scope, accountId: "other-owner" }; register(taskId, view());
    current = null; register(taskId, view()); current = scope;
    live = false; register(taskId, view());
    expect(registrations).toEqual([]);
    live = true; register(taskId, view({ executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" }));
    expect(registrations).toHaveLength(1);
});

test("leaving audio retains T4 tracking, emits one review notice, and stops unknown reads without deleting the task", async () => {
    let current: AudioGenerationScope | null = scope, live = true;
    const timers = new Map<number, () => void>(), notices: GenerationTrackerNotice[] = [];
    let nextTimer = 0, reads = 0;
    const tracker = createGenerationTracker({ getScope: () => current,
        setTimer: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimer: handle => { timers.delete(handle as number); },
        clientFactory: () => ({ read: async ids => { reads++; return { requestId: "synthetic-audio-status", missingTaskIds: [], items: ids.map(taskId => ({
            taskId, projectId: null, nodeId: null, modelId: "synthetic-audio", executionStatus: "unknown" as const,
            deliveryStatus: "unknown" as const, billingStatus: "pending_review" as const, updatedAt: "2026-10-27T00:00:00.000Z",
        })) }; } }) });
    const stop = tracker.getState().start({ notify: notice => { notices.push(notice); }, dismiss: () => {} });
    const register = createAudioTaskRegistration({ scope, getScope: () => current, isCurrent: () => live, tracker });
    register(taskId, view()); register(taskId, view()); live = false;
    expect(Object.values(tracker.getState().entries)).toHaveLength(1);
    const [timer, callback] = [...timers.entries()][0]; timers.delete(timer); callback();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(reads).toBe(1); expect(timers.size).toBe(0);
    expect(Object.values(tracker.getState().entries)).toMatchObject([{ originRoute: "/audio", kindHint: "audio",
        executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review", polling: false }]);
    expect(notices).toMatchObject([{ title: "平台音频：任务状态待核对", originRoute: "/audio", level: "warning" }]);
    expect(notices[0].description).toContain("已暂停自动查询"); expect(notices[0].isCurrent()).toBe(true);
    current = { ...scope, epoch: scope.epoch + 1 }; tracker.getState().syncAccount();
    expect(notices[0].isCurrent()).toBe(false); expect(Object.values(tracker.getState().entries)).toHaveLength(0); stop();
});

test("a recovered unknown audio task stays listed with no automatic T4 read or fresh-completion notice", () => {
    let timers = 0;
    const tracker = createGenerationTracker({ getScope: () => scope, setTimer: () => { timers++; return 0; }, clearTimer: () => {} });
    const notices: GenerationTrackerNotice[] = [], stop = tracker.getState().start({ notify: notice => { notices.push(notice); }, dismiss: () => {} });
    const register = createAudioTaskRegistration({ scope, getScope: () => scope, isCurrent: () => true, tracker });
    register(taskId, view({ executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" }));
    register(taskId, view({ executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" }));
    expect(timers).toBe(0); expect(notices).toEqual([]);
    expect(Object.values(tracker.getState().entries)).toMatchObject([{ taskId, polling: false, executionStatus: "unknown", billingStatus: "pending_review" }]); stop();
});

test("a fresh saved audio receipt reconciles the existing unknown entry without creating a second registration or notice", () => {
    const timers = new Map<number, () => void>(), notices: GenerationTrackerNotice[] = [];
    let nextTimer = 0;
    const tracker = createGenerationTracker({ getScope: () => scope,
        setTimer: callback => { const id = ++nextTimer; timers.set(id, callback); return id; }, clearTimer: handle => { timers.delete(handle as number); } });
    const stop = tracker.getState().start({ notify: notice => { notices.push(notice); }, dismiss: () => {} });
    const register = createAudioTaskRegistration({ scope, getScope: () => scope, isCurrent: () => true, tracker });
    register(taskId, view({ executionStatus: "unknown", deliveryStatus: "unknown", billingStatus: "pending_review" }));
    register(taskId, view()); register(taskId, view());
    expect(Object.values(tracker.getState().entries)).toMatchObject([{ taskId, polling: true, executionStatus: "queued" }]);
    expect(timers.size).toBe(1); expect(notices).toEqual([]);
    register(taskId, view({ executionStatus: "failed", deliveryStatus: "failed", billingStatus: "released" }));
    expect(Object.values(tracker.getState().entries)).toMatchObject([{ taskId, polling: false, executionStatus: "failed", billingStatus: "released" }]);
    expect(timers.size).toBe(0); expect(notices).toEqual([]); stop();
});
