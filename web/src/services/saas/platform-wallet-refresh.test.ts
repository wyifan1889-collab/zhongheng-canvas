import { expect, test } from "bun:test";
import { createPlatformWalletReader, invalidatePlatformWallet } from "./platform-wallet-refresh";
import { createCanvasImageGenerationController, createGenerationReceiptStore } from "./canvas-image-generation";
import { createGenerationClient, type GenerationScope, type GenerationTaskView } from "./generation";
import type { PlatformWallet } from "./platform";
import { addCreditAmounts } from "../../../../packages/shared/src/credit-amounts";

const scope: GenerationScope = { accountId: "synthetic-wallet-owner", epoch: 4, projectId: "synthetic-canvas" };
const taskId = "11111111-1111-4111-8111-111111111111";
const quote = { modelId: "synthetic-image", priceVersion: 1, quotedUnits: 1, billingUnit: "request", creditsPerUnit: 1 };
const task: GenerationTaskView["task"] = { id: taskId, projectId: scope.projectId, modelId: quote.modelId, priceVersion: 1, quotedUnits: 1, executionStatus: "queued", deliveryStatus: "pending", billingStatus: "reserved" };
const finished: GenerationTaskView = { task: { ...task, executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured" }, result: { taskId, status: "succeeded", resultSnapshot: { kind: "image", media: { mediaId: taskId, kind: "image", contentType: "image/png", sizeBytes: 1, etag: "synthetic-etag" } } } };
const wallet = (available: number | string, reserved: number | string = "0"): PlatformWallet => {
    const availableUnits = String(available), reservedUnits = String(reserved);
    return { unit: "credit", availableUnits, reservedUnits, totalUnits: addCreditAmounts(availableUnits, reservedUnits), version: 1, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
};
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function generation(failSavedReceipt = false) {
    const data = new Map<string, unknown>(), calls: string[] = [];
    const client = createGenerationClient({ scope, getScope: () => scope, fetcher: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method} ${input}`);
        return Response.json(String(input).endsWith("/quote") ? { quote } : init?.method === "POST" ? { task, result: null } : finished);
    }, { preconnect: fetch.preconnect }) });
    const controller = createCanvasImageGenerationController({ client, getContext: () => scope, createIdempotencyKey: () => "synthetic-wallet-request", receiptStore: createGenerationReceiptStore({
        async keys() { return [...data.keys()]; },
        async getItem(key) { return data.get(key) ?? null; },
        async setItem(key, value) { if (failSavedReceipt && value.taskId) throw new Error("synthetic IDB failure"); data.set(key, value); return value; },
    }) });
    return { controller, calls };
}

test("confirmed generation reservation and settled readback refresh the wallet without changing its account scope", async () => {
    const f = generation(), states: unknown[] = [];
    let reads = 0;
    const reader = createPlatformWalletReader({ scope, getScope: () => scope, read: async () => wallet(1, ++reads === 1 ? 1 : 0), onState: (state) => states.push(state) });
    try {
        await f.controller.prepare({ modelId: quote.modelId, prompt: "synthetic" });
        expect(reads).toBe(0);
        await f.controller.confirm();
        expect(reads).toBe(1);
        expect(states.at(-1)).toEqual({ status: "ready", wallet: wallet(1, 1) });
        expect(f.controller.isCurrent()).toBe(true);
        await f.controller.refresh();
        expect(reads).toBe(2);
        expect(states.at(-1)).toEqual({ status: "ready", wallet: wallet(1) });
        expect(f.controller.getState().view).toEqual(finished);
        expect(f.calls.filter((call) => call === "POST /api/v1/generation/tasks")).toHaveLength(1);
        expect(scope.epoch).toBe(4);
    } finally { reader.close(); f.controller.close(); }
});

test("a confirmed task still refreshes the wallet when saving its local task ID fails", async () => {
    const f = generation(true), states: unknown[] = [];
    let reads = 0;
    const reader = createPlatformWalletReader({ scope, getScope: () => scope, read: async () => { reads++; return wallet(1, 1); }, onState: (state) => states.push(state) });
    try {
        await f.controller.prepare({ modelId: quote.modelId, prompt: "synthetic" });
        await f.controller.confirm();
        expect(f.controller.getState()).toMatchObject({ phase: "uncertain", error: { code: "receipt_storage" } });
        expect(reads).toBe(1);
        expect(states.at(-1)).toEqual({ status: "ready", wallet: wallet(1, 1) });
        expect(f.calls.filter((call) => call === "POST /api/v1/generation/tasks")).toHaveLength(1);
    } finally { reader.close(); f.controller.close(); }
});

for (const oldFails of [false, true]) test(`latest wallet read wins over an older ${oldFails ? "failure" : "success"}; current failure hides stale credits`, async () => {
    const old = deferred<PlatformWallet>(), states: unknown[] = [];
    let reads = 0;
    const reader = createPlatformWalletReader({ scope, getScope: () => scope, read: () => {
        reads++;
        return reads === 1 ? old.promise : reads === 2 ? Promise.resolve(wallet(1)) : Promise.reject(new Error("synthetic wallet outage"));
    }, onState: (state) => states.push(state) });
    try {
        const first = reader.refresh();
        invalidatePlatformWallet({ ...scope, accountId: "other-account" });
        invalidatePlatformWallet({ ...scope, epoch: 5 });
        expect(reads).toBe(1);
        await reader.refresh(); // The same action is used when the account menu opens.
        expect(states.at(-1)).toEqual({ status: "ready", wallet: wallet(1) });
        const before = states.length;
        if (oldFails) old.reject(new Error("synthetic late failure")); else old.resolve(wallet(2));
        await first;
        expect(states).toHaveLength(before);
        await reader.refresh();
        expect(states.at(-1)).toEqual({ status: "unavailable", wallet: null });
    } finally { reader.close(); }
});

for (const change of ["account", "epoch", "close"] as const) test(`late wallet replies and invalidations cannot update an obsolete reader: ${change}`, async () => {
    const response = deferred<PlatformWallet>(), states: unknown[] = [];
    let current = { ...scope }, reads = 0;
    const reader = createPlatformWalletReader({ scope, getScope: () => current, read: () => { reads++; return response.promise; }, onState: (state) => states.push(state) });
    try {
        const pending = reader.refresh();
        if (change === "close") reader.close();
        else current = { ...scope, ...(change === "account" ? { accountId: "other-account" } : { epoch: 5 }) };
        const before = states.length;
        response.resolve(wallet(2));
        await pending;
        invalidatePlatformWallet(scope);
        expect(states).toHaveLength(before);
        expect(reads).toBe(1);
    } finally { reader.close(); }
});

test("a broken wallet observer cannot turn a successful generation into an unknown outcome", async () => {
    const f = generation();
    const reader = createPlatformWalletReader({ scope, getScope: () => scope, read: async () => wallet(1), onState: () => { throw new Error("synthetic observer error"); } });
    try {
        await f.controller.prepare({ modelId: quote.modelId, prompt: "synthetic" });
        await f.controller.confirm();
        expect(f.controller.getState()).toMatchObject({ phase: "tracking", error: null, view: { task } });
    } finally { reader.close(); f.controller.close(); }
});
