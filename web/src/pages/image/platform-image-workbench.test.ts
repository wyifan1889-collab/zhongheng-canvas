import { expect, test } from "bun:test";
import { createWorkbenchImageSession, IMAGE_WORKBENCH_PROJECT_ID, type PlatformImageInput } from "./platform-image-workbench";
import { createGenerationClient, type GenerationModel, type GenerationQuote, type GenerationScope } from "@/services/saas/generation";
import { createGenerationReceiptStore, type GenerationReceiptBacking } from "@/services/saas/canvas-image-generation";
import { createGenerationTracker, type GenerationTrackerNotice, type GenerationTrackerRegistration } from "@/stores/use-generation-tracker";

const scope: GenerationScope = { accountId: "synthetic-workbench-owner", epoch: 4, projectId: IMAGE_WORKBENCH_PROJECT_ID };
const id = "11111111-1111-4111-8111-111111111111";
const model: GenerationModel = { id: "synthetic-image", displayName: "Synthetic image", capability: "image", group: null };
const quote: GenerationQuote = { modelId: model.id, priceVersion: 3, quotedUnits: 7, billingUnit: "request", creditsPerUnit: 7 };
const task = { id, projectId: scope.projectId, modelId: model.id, priceVersion: 3, quotedUnits: 7,
    executionStatus: "queued", deliveryStatus: "pending", billingStatus: "reserved" };
const input = (): PlatformImageInput => ({ modelId: model.id, prompt: "synthetic prompt", parameters: {}, referenceCount: 0, count: "1", settingsReviewed: true });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(respond?: (path: string, init?: RequestInit) => Promise<Response>, backing?: GenerationReceiptBacking) {
    let context: GenerationScope | null = { ...scope }, currentInput = input();
    const data = new Map<string, unknown>(), registrations: GenerationTrackerRegistration[] = [], calls: { path: string; init?: RequestInit }[] = [];
    const receipts = createGenerationReceiptStore(backing ?? { async keys() { return [...data.keys()]; }, async getItem(key) { return data.get(key) ?? null; }, async setItem(key, value) { data.set(key, structuredClone(value)); return value; } });
    const getContext = () => context;
    const create = (tracker = { getState: () => ({ register: (value: GenerationTrackerRegistration) => { registrations.push(value); } }) }) => {
        const captured = { ...context! };
        const client = createGenerationClient({ scope: captured, getScope: getContext,
            fetcher: Object.assign(async (url: RequestInfo | URL, init?: RequestInit) => {
                const path = String(url); calls.push({ path, init });
                if (path.endsWith("/models")) return Response.json({ items: [model] });
                if (path.endsWith("/quote")) return Response.json({ quote });
                return respond ? respond(path, init) : Response.json({ task, result: null });
            }, { preconnect: fetch.preconnect }) });
        return createWorkbenchImageSession({ scope: captured, getContext, getInput: () => currentInput, client, receipts, tracker });
    };
    return { create, calls, data, receipts, registrations, getContext,
        changeScope(next: GenerationScope | null) { context = next; }, changeInput(next: PlatformImageInput) { currentInput = next; }, input: () => currentInput };
}

test("workbench rejects unreviewed personal settings, references and multiple images before even quoting", async () => {
    const f = fixture(), page = f.create();
    for (const patch of [{ settingsReviewed: false }, { referenceCount: 1 }, { count: "2" }, { parameters: { size: "1024x1024" } }, { modelId: "personal-channel::model" }]) {
        const draft = { ...input(), ...patch } as PlatformImageInput;
        await expect(page.prepare(draft, [model])).rejects.toThrow();
        expect(draft).toEqual({ ...input(), ...patch });
    }
    expect(f.calls).toEqual([]); expect(await page.listReceipts()).toEqual([]);
});

test("viewing a workbench quote never submits or records a charge; repeated confirmation creates exactly one task", async () => {
    const f = fixture(), page = f.create();
    await page.prepare(f.input(), [model]);
    expect(f.calls.map(call => call.path)).toEqual(["/api/v1/generation/quote"]);
    expect(await page.listReceipts()).toEqual([]); expect(f.registrations).toEqual([]);
    await Promise.all([page.confirm(), page.confirm()]); await page.confirm();
    expect(f.calls.filter(call => call.path.endsWith("/tasks"))).toHaveLength(1);
    expect(JSON.parse(f.calls.at(-1)!.init!.body as string)).toMatchObject({ projectId: IMAGE_WORKBENCH_PROJECT_ID, parameters: {}, confirmedPriceVersion: 3 });
    expect(page.getState().view?.task.billingStatus).toBe("reserved");
    expect(f.registrations).toMatchObject([{ originRoute: "/image", projectId: IMAGE_WORKBENCH_PROJECT_ID, kindHint: "image", taskId: id }]);
    expect(JSON.stringify([...f.data.values()])).not.toContain("synthetic prompt");
});

test("changed references or prompt cannot use a prior quote even before a React effect invalidates it", async () => {
    for (const patch of [{ prompt: "edited prompt" }, { referenceCount: 1 }, { count: "2" }]) {
        const f = fixture(), page = f.create();
        await page.prepare(f.input(), [model]); f.changeInput({ ...input(), ...patch }); await page.confirm();
        expect(f.calls).toHaveLength(1); expect(page.getState().phase).toBe("failed");
        expect(await page.listReceipts()).toEqual([]);
    }
});

test("input changes while the recovery receipt commits still prevent POST", async () => {
    const entered = deferred<void>(), release = deferred<void>(), data = new Map<string, unknown>();
    const f = fixture(undefined, { async keys() { return [...data.keys()]; }, async getItem(key) { return data.get(key) ?? null; },
        async setItem(key, value) { entered.resolve(); await release.promise; data.set(key, value); return value; } });
    const page = f.create(); await page.prepare(f.input(), [model]); const pending = page.confirm(); await entered.promise;
    f.changeInput({ ...input(), referenceCount: 1 }); page.invalidateQuote(); release.resolve(); await pending;
    expect(f.calls).toHaveLength(1); expect(await page.listReceipts()).toHaveLength(1);
    expect(f.registrations).toEqual([]);
});

test("an unknown workbench POST keeps its receipt across a new epoch; 404 lookup never unlocks resubmission", async () => {
    let accepted = false;
    const f = fixture(async (_path, init) => {
        if (init?.method === "POST") throw new Error("synthetic transport lost");
        return accepted ? Response.json({ task, result: null }) : Response.json({ error: { code: "not_found" } }, { status: 404 });
    });
    const first = f.create(); await first.prepare(f.input(), [model]); await first.confirm();
    expect(first.getState()).toMatchObject({ phase: "uncertain", receipt: { priceVersion: 3 } });
    first.close(); f.changeScope({ ...scope, epoch: 5 });
    const reopened = f.create(), [receipt] = await reopened.listReceipts();
    await reopened.restoreReceipt(receipt); await reopened.confirm();
    expect(reopened.getState()).toMatchObject({ phase: "uncertain", receipt: { idempotencyKey: receipt.idempotencyKey } });
    expect(f.calls.filter(call => call.path.endsWith("/tasks"))).toHaveLength(1);
    expect(f.calls.at(-1)!.path).toBe(`/api/v1/generation/tasks/by-key/${receipt.idempotencyKey}`);
    accepted = true; await reopened.refresh();
    expect(reopened.getState().view?.task.id).toBe(id);
    expect(f.registrations.at(-1)).toMatchObject({ epoch: 5, taskId: id, originRoute: "/image" });
});

test("a late POST after an account change cannot display a task or register it for the new account", async () => {
    const entered = deferred<void>(), response = deferred<Response>();
    const f = fixture(async () => { entered.resolve(); return response.promise; }), page = f.create();
    await page.prepare(f.input(), [model]); const pending = page.confirm(); await entered.promise;
    f.changeScope({ ...scope, accountId: "other-owner", epoch: 5 }); response.resolve(Response.json({ task, result: null })); await pending;
    expect(page.getState()).toMatchObject({ phase: "closed", view: null }); expect(f.registrations).toEqual([]);
    expect(await f.receipts.list(scope.accountId, scope.projectId)).toHaveLength(1);
    expect(await f.receipts.list("other-owner", scope.projectId)).toEqual([]);
});

test("closing the image page leaves its accepted task in the global T4 tracker until completion", async () => {
    const f = fixture(), timers: (() => void)[] = [], notices: GenerationTrackerNotice[] = [];
    const tracker = createGenerationTracker({ getScope: f.getContext,
        setTimer: callback => { timers.push(callback); return callback; }, clearTimer: () => {},
        clientFactory: () => ({ read: async () => ({ requestId: "synthetic-tracking", missingTaskIds: [], items: [{ taskId: id, projectId: IMAGE_WORKBENCH_PROJECT_ID,
            nodeId: null, modelId: model.id, executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured", updatedAt: "2026-10-27T00:00:00.000Z" }] }) }) });
    const stop = tracker.getState().start({ notify: notice => { notices.push(notice); }, dismiss: () => {} });
    const page = f.create(tracker); await page.prepare(f.input(), [model]); await page.confirm(); page.close();
    expect(Object.values(tracker.getState().entries)).toHaveLength(1);
    timers.shift()!(); for (let i = 0; i < 10; ++i) await Promise.resolve();
    expect(notices).toMatchObject([{ originRoute: "/image", kindHint: "image", level: "success", taskId: id }]);
    expect(page.getState().phase).toBe("closed");
    f.changeScope({ ...scope, epoch: 5 }); expect(notices[0].isCurrent()).toBe(false); stop();
});

test("two workbench controllers reuse the page's published-spec client and preserve exact quotes for the next image", async () => {
    const parameters = { size: "1536x1024", quality: "high" as const }, paths: string[] = [];
    const specModel: GenerationModel = { ...model, imagePricing: { priceVersion: 3, billingUnit: "image_specs", creditsPerUnit: null, protocol: "openai-image-v1",
        imageSpecs: [{ parameters, creditsPerRequest: 7 }] } };
    const specQuote = { ...quote, imageSpec: { protocol: "openai-image-v1", parameters }, quoteFingerprint: "a".repeat(64) };
    const client = createGenerationClient({ scope, getScope: () => scope, fetcher: Object.assign(async (url: RequestInfo | URL) => {
        const path = String(url); paths.push(path);
        return Response.json(path.endsWith("/models") ? { items: [specModel] } : { quote: specQuote });
    }, { preconnect: fetch.preconnect }) });
    const first = createWorkbenchImageSession({ scope, getContext: () => scope, client });
    const models = await first.models(); await first.prepare({ ...input(), parameters }, models);
    expect(first.getState().quote).toEqual(specQuote); first.close();
    const next = createWorkbenchImageSession({ scope, getContext: () => scope, client });
    await next.prepare({ ...input(), parameters, prompt: "another image" }, models);
    expect(next.getState().phase).toBe("ready"); expect(next.getState().quote?.imageSpec?.parameters).toEqual(parameters);
    expect(paths).toEqual(["/api/v1/generation/models", "/api/v1/generation/quote", "/api/v1/generation/quote"]);
});
