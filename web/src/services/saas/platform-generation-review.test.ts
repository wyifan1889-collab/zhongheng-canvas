import { expect, test } from "bun:test";
import { normalizeResponsesUsage } from "../../../../packages/shared/src/text-usage";
import { createAdminGenerationTaskReader, createAdminTextUsageDraftReview, type AdminGenerationReviewState, type AdminGenerationScope, type AdminGenerationTaskDetail,
    type AdminModelPriceDraft, type AdminTextUsageDraftState, type TextUsageEvidence, type TaskPriceSnapshot } from "./platform";

const taskId = "11111111-1111-4111-8111-111111111111", otherTaskId = "22222222-2222-4222-8222-222222222222";
const scope: AdminGenerationScope = { accountId: "synthetic-admin", role: "admin", epoch: 4 };
const timestamp = "2026-01-01T00:00:00.000Z";
function detail(id = taskId): AdminGenerationTaskDetail {
    return {
        observedAt: timestamp,
        priceSnapshot: { status: "not_recorded" },
        task: { id, ownerId: "synthetic-user", projectId: "synthetic-project", nodeId: null, modelId: "synthetic-image", priceVersion: 1,
            quotedUnits: 7, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7, executionStatus: "unknown", deliveryStatus: "pending",
            billingStatus: "pending_review", unknownReason: "provider_response_unknown", createdAt: timestamp, updatedAt: timestamp, finishedAt: null },
        result: { status: "unknown", consumedUnits: null, textUsage: null, errorCode: null, unknownReason: "provider_response_unknown", createdAt: timestamp, updatedAt: timestamp },
        reservation: { linkStatus: "linked", details: { id: taskId, status: "pending", requestedUnits: "7", capturedUnits: "0", releasedUnits: "0",
            remainingUnits: "7", createdAt: timestamp, updatedAt: timestamp } },
        ledger: [{ id: taskId, kind: "reserve", deltaAvailableUnits: "-7", deltaReservedUnits: "7", createdAt: timestamp }],
    };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const fetcher = (run: (path: string, init?: RequestInit) => Promise<Response>): typeof fetch => Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => run(String(input), init), { preconnect: fetch.preconnect });
function fixture(read: (path: string, init?: RequestInit) => Promise<Response>) {
    let current: AdminGenerationScope | null = { ...scope };
    const states: AdminGenerationReviewState[] = [], calls: Array<{ path: string; init?: RequestInit }> = [];
    const reader = createAdminGenerationTaskReader({ scope, getScope: () => current, onState: (state) => states.push(state), fetcher: fetcher(async (path, init) => {
        calls.push({ path, init }); return read(path, init);
    }) });
    return { reader, states, calls, change(next: AdminGenerationScope | null) { current = next; }, latest: () => states.at(-1) };
}

test("admin task review sends one scoped no-store GET and retains only validated DTO fields", async () => {
    const original = detail();
    const f = fixture(async () => Response.json({ detail: { ...original, secret: "private-extra", task: { ...original.task, inputSnapshot: "private-extra" },
        result: { ...original.result, resultSnapshot: { base64: "private-extra" } }, ledger: original.ledger.map((row) => ({ ...row, metadata: "private-extra" })) }, requestId: "private-extra" }));
    expect(f.calls).toHaveLength(0);
    await f.reader.query(` ${taskId.toUpperCase()} `);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].path).toBe(`/api/v1/admin/generation/tasks/${taskId}`);
    expect(f.calls[0].init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error" });
    expect(new Headers(f.calls[0].init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
    expect(f.calls[0].init?.body).toBeUndefined();
    expect(f.latest()).toEqual({ status: "ready", detail: original });
    expect(JSON.stringify(f.latest())).not.toContain("private-extra");
    f.reader.close();
});

test("missing associations and null quote remain missing rather than becoming zero balances", async () => {
    const missing = detail();
    missing.task.quotedUnits = null; missing.task.priceVersion = null; missing.task.creditsPerUnitSnapshot = null; missing.task.billingUnitSnapshot = null;
    missing.reservation = { linkStatus: "missing", details: null }; missing.result = null; missing.ledger = [];
    const f = fixture(async () => Response.json({ detail: missing }));
    await f.reader.query(taskId);
    expect(f.latest()).toEqual({ status: "ready", detail: missing });
    expect(f.calls).toHaveLength(1);
    f.reader.close();
});

test("task monetary receipts preserve exact decimal reservation and signed ledger amounts", async () => {
    const original = detail();
    Object.assign(original.reservation.details!, { requestedUnits: "9007199254740993.000006", capturedUnits: "9007199254740993", releasedUnits: "0.000002", remainingUnits: "0.000004" });
    Object.assign(original.ledger[0], { deltaAvailableUnits: "-0.000004", deltaReservedUnits: "0.000004" });
    const f = fixture(async () => Response.json({ detail: original }));
    await f.reader.query(taskId);
    expect(f.latest()).toEqual({ status: "ready", detail: original }); expect(f.calls).toHaveLength(1);
    f.reader.close();
    for (const bad of [7, "7.0", "07", "7e0", "7\n", "-0", "-1"]) {
        const broken = detail();
        const invalid = fixture(async () => Response.json({ detail: { ...broken, reservation: { ...broken.reservation, details: { ...broken.reservation.details, requestedUnits: bad } } } }));
        await invalid.reader.query(taskId); expect(invalid.latest()?.status).toBe("error"); invalid.reader.close();
    }
    const broken = detail(); broken.reservation.details!.remainingUnits = "6.999999";
    const invalid = fixture(async () => Response.json({ detail: broken }));
    await invalid.reader.query(taskId); expect(invalid.latest()?.status).toBe("error"); invalid.reader.close();
});

test("invalid task identifiers never fetch and malformed or mismatched administrative DTOs never display", async () => {
    const f = fixture(async () => Response.json({ detail: detail() }));
    await f.reader.query("synthetic-request-key");
    expect(f.latest()?.status).toBe("error"); expect(f.calls).toHaveLength(0); f.reader.close();
    const original = detail();
    const cases: unknown[] = [
        undefined, { detail: { ...original, task: { ...original.task, id: otherTaskId } } },
        { detail: { ...original, task: { ...original.task, executionStatus: ["unknown"] } } },
        { detail: { ...original, task: { ...original.task, quotedUnits: "7" } } },
        { detail: { ...original, task: { ...original.task, updatedAt: "not-a-date" } } },
        { detail: { ...original, reservation: { linkStatus: "missing", details: original.reservation.details } } },
        { detail: { ...original, reservation: { linkStatus: "linked", details: null } } },
        { detail: { ...original, ledger: [{ ...original.ledger[0], deltaReservedUnits: Number.MAX_SAFE_INTEGER + 1 }] } },
        { detail: { ...original, ledger: [original.ledger[0], original.ledger[0]] } },
        { detail: { ...original, result: { ...original.result, consumedUnits: -1 } } },
    ];
    for (const body of cases) {
        const invalid = fixture(async () => Response.json(body ?? {}));
        await invalid.reader.query(taskId);
        expect(invalid.latest()).toMatchObject({ status: "error" });
        expect(invalid.states.some((state) => state.status === "ready")).toBe(false);
        expect(invalid.calls).toHaveLength(1); invalid.reader.close();
    }
});

test("HTTP failures show safe in-place errors without retrying or retaining an earlier task", async () => {
    for (const status of [401, 403, 404, 409, 429, 503]) {
        let fail = false;
        const f = fixture(async () => fail ? new Response("private-server-message", { status }) : Response.json({ detail: detail() }));
        await f.reader.query(taskId); expect(f.latest()?.status).toBe("ready"); fail = true;
        await f.reader.query(otherTaskId);
        expect(f.latest()?.status).toBe("error");
        expect(JSON.stringify(f.latest())).not.toContain("private-server-message");
        expect(f.calls).toHaveLength(2);
        if (status === 404) expect(f.latest()).toMatchObject({ message: expect.stringContaining("不代表可以重新生成或退款") });
        f.reader.close();
    }
});

for (const change of ["account", "epoch", "role"] as const) test(`admin task response body cannot arrive after ${change} invalidates its scope`, async () => {
    const body = deferred<unknown>(), started = deferred<void>();
    const f = fixture(async () => { const response = Response.json({}); response.json = () => { started.resolve(); return body.promise; }; return response; });
    const pending = f.reader.query(taskId); await started.promise;
    f.change(change === "role" ? null : { ...scope, ...(change === "account" ? { accountId: "other-admin" } : { epoch: scope.epoch + 1 }) });
    body.resolve({ detail: detail() }); await pending;
    expect(f.states.some((state) => state.status === "ready")).toBe(false);
    f.change({ ...scope }); await f.reader.query(taskId);
    expect(f.calls).toHaveLength(1);
    f.reader.close();
});

test("a second manual query replaces pending work and both late success and late errors cannot overwrite it", async () => {
    for (const lateFailure of [false, true]) {
        const body = deferred<unknown>(), started = deferred<void>();
        const f = fixture(async (path) => {
            if (path.endsWith(otherTaskId)) return Response.json({ detail: detail(otherTaskId) });
            const response = Response.json({}); response.json = async () => { started.resolve(); await body.promise; if (lateFailure) throw new Error("late-private-error"); return { detail: detail() }; }; return response;
        });
        const first = f.reader.query(taskId); await started.promise;
        await f.reader.query(otherTaskId); body.resolve(null); await first;
        expect(f.latest()).toEqual({ status: "ready", detail: detail(otherTaskId) });
        expect(f.calls[0].init?.signal?.aborted).toBe(true);
        expect(f.calls).toHaveLength(2); f.reader.close();
    }
});

test("clearing input or unmounting aborts pending reads and cannot revive task details", async () => {
    for (const action of ["clear", "close"] as const) {
        const body = deferred<unknown>(), started = deferred<void>();
        const f = fixture(async () => { const response = Response.json({}); response.json = () => { started.resolve(); return body.promise; }; return response; });
        const pending = f.reader.query(taskId); await started.promise;
        f.reader[action](); const count = f.states.length; body.resolve({ detail: detail() }); await pending;
        expect(f.states).toHaveLength(count);
        expect(f.states.some((state) => state.status === "ready")).toBe(false);
        expect(f.calls[0].init?.signal?.aborted).toBe(true);
        if (action === "clear") expect(f.latest()?.status).toBe("idle");
        f.reader.close();
    }
});

const completeUsage: TextUsageEvidence = { schemaVersion: 1, source: "chat_completions", status: "complete", inputTokens: 1000, outputTokens: 500,
    totalTokens: 1500, totalSource: "reported", cachedInputTokens: 400, reasoningOutputTokens: 200, reason: null };

test("text evidence is safely reconstructed, while absent legacy evidence remains unrecorded", async () => {
    for (const usage of [undefined, null, { ...completeUsage, providerSecret: "private-extra" }]) {
        const original = detail();
        const f = fixture(async () => Response.json({ detail: { ...original, result: { ...original.result, textUsage: usage } } }));
        await f.reader.query(taskId);
        expect(f.latest()).toEqual({ status: "ready", detail: { ...original, result: { ...original.result!, textUsage: usage == null ? null : completeUsage } } });
        expect(JSON.stringify(f.latest())).not.toContain("private-extra"); f.reader.close();
    }
});

test("Responses evidence keeps protocol and state through the client DTO while stripping private extras", async () => {
    for (const usage of [
        normalizeResponsesUsage({ input_tokens: 1000, output_tokens: 500, total_tokens: 1500,
            input_tokens_details: { cached_tokens: 400 }, output_tokens_details: { reasoning_tokens: 500 } }),
        normalizeResponsesUsage(null),
        normalizeResponsesUsage({ output_tokens: 2 }),
        normalizeResponsesUsage({ input_tokens: 2, output_tokens: 3, total_tokens: 9 }),
    ]) {
        const original = detail();
        const f = fixture(async () => Response.json({ detail: { ...original, result: { ...original.result, textUsage: { ...usage, providerSecret: "private-extra" } } } }));
        await f.reader.query(taskId);
        expect(f.latest()).toEqual({ status: "ready", detail: { ...original, result: { ...original.result!, textUsage: usage } } });
        expect(JSON.stringify(f.latest())).not.toContain("private-extra");
        expect(f.calls).toHaveLength(1);
        expect(f.calls[0].init?.method).toBe("GET");
        f.reader.close();
    }
});

test("task review retains explicit cache writes but never fills absent evidence with zero", async () => {
    for (const cacheWriteTokens of [undefined, 0, 2]) {
        const usage = { ...completeUsage, ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }) }, original = detail();
        const f = fixture(async () => Response.json({ detail: { ...original, result: { ...original.result, textUsage: { ...usage, providerSecret: "private-extra" } } } }));
        await f.reader.query(taskId);
        expect(f.latest()).toEqual({ status: "ready", detail: { ...original, result: { ...original.result!, textUsage: usage } } });
        expect(JSON.stringify(f.latest())).not.toContain("private-extra"); f.reader.close();
    }
    const invalid = fixture(async () => Response.json({ detail: { ...detail(), result: { ...detail().result, textUsage: { ...completeUsage, cacheWriteTokens: "0" } } } }));
    await invalid.reader.query(taskId); expect(invalid.latest()?.status).toBe("error"); invalid.reader.close();
});

const fixedPrice: Extract<TaskPriceSnapshot, { status: "recorded" }> = { status: "recorded", publicationId: otherTaskId, draftId: taskId,
    draftVersion: 2, priceVersion: 1, publicPriceNote: "合成公开说明", publishedAt: timestamp,
    binding: { providerId: "retired-channel", providerModel: "old-upstream", adapter: "openai-compatible", endpoint: "https://old.example.invalid/v1", capability: "image" },
    rules: { schemaVersion: 1, cost: { template: "image_request", currency: "USD", bands: [{ parameters: {}, rates: { request: "0.12" } }] },
        sale: { template: "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } } };

test("fixed task price is returned in the task GET without querying current catalog or rewriting its historical binding", async () => {
    for (const priceSnapshot of [fixedPrice, { status: "not_recorded" } as const, { status: "invalid" } as const]) {
        const f = fixture(async () => Response.json({ detail: { ...detail(), priceSnapshot } }));
        await f.reader.query(taskId);
        expect(f.latest()).toEqual({ status: "ready", detail: { ...detail(), priceSnapshot } });
        expect(f.calls).toHaveLength(1); expect(f.calls[0].path).toBe(`/api/v1/admin/generation/tasks/${taskId}`);
        f.reader.close();
    }
});

test("missing, malformed or mismatched historical prices reject the task DTO instead of filling current prices", async () => {
    const cases: unknown[] = [undefined, null, { status: "not_recorded", rules: fixedPrice.rules }, { ...fixedPrice, apiKey: "private-key" },
        { ...fixedPrice, priceVersion: 2 }, { ...fixedPrice, draftVersion: 0 }, { ...fixedPrice, publicationId: "not-a-uuid" },
        { ...fixedPrice, rules: { ...fixedPrice.rules, sale: { ...fixedPrice.rules.sale, currency: "USD" } } },
        { ...fixedPrice, binding: { ...fixedPrice.binding, endpoint: "https://user:private-key@old.example.invalid/v1" } }];
    for (const priceSnapshot of cases) {
        const f = fixture(async () => Response.json({ detail: { ...detail(), priceSnapshot } }));
        await f.reader.query(taskId);
        expect(f.latest()?.status).toBe("error"); expect(f.states.some((state) => state.status === "ready")).toBe(false);
        expect(f.calls).toHaveLength(1); expect(JSON.stringify(f.latest())).not.toContain("private-key"); f.reader.close();
    }
});

test("malformed or contradictory text evidence rejects the whole task DTO without exposing private content", async () => {
    const values: unknown[] = ["private-error", { ...completeUsage, inputTokens: "1000" }, { ...completeUsage, inputTokens: -1 },
        { ...completeUsage, totalTokens: 1501 }, { ...completeUsage, cachedInputTokens: 1001 },
        { ...completeUsage, reasoningOutputTokens: 501 }, { ...completeUsage, source: "browser_estimate" }, { ...completeUsage, reason: "private-error" }];
    for (const usage of values) {
        const original = detail();
        const f = fixture(async () => Response.json({ detail: { ...original, result: { ...original.result, textUsage: usage } } }));
        await f.reader.query(taskId);
        expect(f.latest()?.status).toBe("error"); expect(f.states.some((item) => item.status === "ready")).toBe(false);
        expect(JSON.stringify(f.latest())).not.toContain("private-error"); f.reader.close();
    }
});

function textDraft(modelId = "synthetic-text"): AdminModelPriceDraft {
    return { id: taskId, modelId, version: 2, binding: { providerId: "synthetic-channel", providerModel: "synthetic-upstream", adapter: "openai-compatible",
        endpoint: "https://synthetic.invalid/v1", capability: "text" }, bindingMatchesCurrent: true, priceNote: "private-note", createdAt: timestamp,
        rules: { schemaVersion: 1, cost: null, sale: { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "2", output_token: "4" } }] } } };
}
const catalogFor = (draft: AdminModelPriceDraft) => ({ models: [{ modelId: draft.modelId, displayName: "合成文本模型", providerDisplayName: "合成渠道", binding: draft.binding }], items: [draft] });

test("saved text draft is fetched only manually and its explicit simulation performs no additional requests", async () => {
    const states: AdminTextUsageDraftState[] = [], calls: RequestInit[] = [];
    const controller = createAdminTextUsageDraftReview({ scope, getScope: () => scope, modelId: "synthetic-text", usage: completeUsage,
        onState: (state) => states.push(state), fetcher: fetcher(async (path, init) => { expect(path).toBe("/api/v1/admin/model-price-drafts"); calls.push(init!); return Response.json(catalogFor(textDraft())); }) });
    controller.calculate(); expect(calls).toHaveLength(0); expect(states).toHaveLength(0);
    await controller.read(); expect(states.at(-1)).toMatchObject({ status: "ready", calculation: null, draft: { version: 2 } });
    expect(calls).toHaveLength(1); expect(calls[0]).toMatchObject({ method: "GET", cache: "no-store", redirect: "error" });
    expect(new Headers(calls[0].headers).get("x-canvas-account-id")).toBe(scope.accountId); expect(calls[0].body).toBeUndefined();
    controller.calculate();
    expect(states.at(-1)).toMatchObject({ status: "ready", calculation: { status: "calculated", mode: "draft_simulation", draftId: taskId, draftVersion: 2, cost: null, sale: { total: "0.004" } } });
    expect(calls).toHaveLength(1); controller.close();
});

test("draft lookup never substitutes another model and a changed binding blocks simulation", async () => {
    for (const mode of ["other-model", "changed-binding"] as const) {
        const saved = textDraft(mode === "other-model" ? "another-model" : "synthetic-text");
        if (mode === "changed-binding") saved.bindingMatchesCurrent = false;
        const states: AdminTextUsageDraftState[] = [];
        const controller = createAdminTextUsageDraftReview({ scope, getScope: () => scope, modelId: "synthetic-text", usage: completeUsage,
            onState: (state) => states.push(state), fetcher: fetcher(async () => Response.json(catalogFor(saved))) });
        await controller.read(); controller.calculate();
        expect(states.at(-1)).toMatchObject(mode === "other-model" ? { status: "error" } : { status: "ready", calculation: { status: "blocked", reason: "binding_changed" } });
        controller.close();
    }
});

test("pending draft bodies cannot return after account, epoch, role or displayed-task invalidation", async () => {
    for (const change of ["account", "epoch", "role", "close"] as const) {
        let current: AdminGenerationScope | null = { ...scope };
        const states: AdminTextUsageDraftState[] = [], body = deferred<unknown>(), started = deferred<void>();
        let signal: AbortSignal | null | undefined;
        const controller = createAdminTextUsageDraftReview({ scope, getScope: () => current, modelId: "synthetic-text", usage: completeUsage,
            onState: (state) => states.push(state), fetcher: fetcher(async (_, init) => { signal = init?.signal; const response = Response.json({}); response.json = () => { started.resolve(); return body.promise; }; return response; }) });
        const pending = controller.read(); await started.promise;
        if (change === "close") controller.close();
        else current = change === "role" ? null : { ...scope, ...(change === "account" ? { accountId: "other-admin" } : { epoch: 5 }) };
        body.resolve(catalogFor(textDraft())); await pending;
        expect(states.some((state) => state.status === "ready")).toBe(false); expect(signal?.aborted).toBe(true);
        current = scope; controller.calculate(); expect(states.some((state) => state.status === "ready")).toBe(false); controller.close();
    }
});

test("new manual draft reads clear a previous calculation and ignore late older bodies", async () => {
    const body = deferred<unknown>(), started = deferred<void>(), states: AdminTextUsageDraftState[] = [];
    let requests = 0;
    const controller = createAdminTextUsageDraftReview({ scope, getScope: () => scope, modelId: "synthetic-text", usage: completeUsage, onState: (state) => states.push(state),
        fetcher: fetcher(async () => {
            if (++requests === 2) { const response = Response.json({}); response.json = () => { started.resolve(); return body.promise; }; return response; }
            return Response.json(catalogFor({ ...textDraft(), version: requests }));
        }) });
    await controller.read(); controller.calculate(); expect(states.at(-1)).toMatchObject({ calculation: { draftVersion: 1 } });
    const late = controller.read(); await started.promise; expect(states.at(-1)).toEqual({ status: "loading" });
    await controller.read(); body.resolve(catalogFor({ ...textDraft(), version: 2 })); await late;
    expect(states.at(-1)).toMatchObject({ status: "ready", draft: { version: 3 }, calculation: null });
    expect(requests).toBe(3); controller.close();
});
