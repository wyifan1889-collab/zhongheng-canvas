import { expect, test } from "bun:test";
import { createAdminModelPriceDraftClient, PlatformServiceError, type AdminModelPriceDraft, type AdminGenerationScope, type PriceDraftModel, type ModelPriceDraftWrite, type ModelPriceRules, type ModelPriceRule } from "./platform";
import { deriveModelPriceRules, type ModelPriceDerivation } from "../../../../packages/shared/src/model-price-derivation";

const scope: AdminGenerationScope = { accountId: "synthetic-pricing-admin", epoch: 3, role: "admin" };
const model: PriceDraftModel = { modelId: "synthetic-image", displayName: "合成图片", providerDisplayName: "合成渠道", binding: { providerId: "synthetic-provider", providerModel: "image-synthetic", adapter: "openai-compatible", endpoint: "https://synthetic.example.invalid/v1", capability: "image" } };
const rules = (): ModelPriceRules & { cost: ModelPriceRule } => ({ schemaVersion: 1, cost: { template: "image_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "2", output_token: "4", image_input_token: null, image_output_token: "8" } }] }, sale: { template: "image_count", currency: "credit", bands: [{ parameters: {}, rates: { image: "7" } }] } });
function draft(patch: Partial<AdminModelPriceDraft> = {}): AdminModelPriceDraft {
    return { id: "11111111-1111-4111-8111-111111111111", modelId: model.modelId, version: 1, priceNote: "合成草稿，不收费", binding: { ...model.binding }, bindingMatchesCurrent: true, createdAt: "2026-10-23T00:00:00.000Z", rules: rules(), ...patch };
}
const catalog = (item = draft()) => ({ models: [model], items: [item], requestId: "synthetic-request" });
const write = (patch: Partial<ModelPriceDraftWrite> = {}): ModelPriceDraftWrite => ({ modelId: model.modelId, expectedVersion: 0, binding: { ...model.binding }, rules: rules(), priceNote: "合成草稿，不收费", ...patch });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
const fetcher = (run: (path: string, init?: RequestInit) => Promise<Response>): typeof fetch => Object.assign(
    (input: RequestInfo | URL, init?: RequestInit) => run(String(input), init), { preconnect: fetch.preconnect });
function fixture(run: (path: string, init?: RequestInit) => Promise<Response>) {
    let current: AdminGenerationScope | null = { ...scope };
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const client = createAdminModelPriceDraftClient({ scope, getScope: () => current, fetcher: fetcher(async (path, init) => { calls.push({ path, init }); return run(path, init); }) });
    return { client, calls, change(next: AdminGenerationScope | null) { current = next; } };
}

test("derived draft receipts retain the complete private source even when returned selling rates are unchanged", async () => {
    const derivation: ModelPriceDerivation = { schemaVersion: 1, kind: "multiplier", binding: model.binding,
        basis: { template: "image_request", currency: "CNY", bands: [{ parameters: {}, rates: { request: "0.1" } }] },
        costMultiplier: "1", saleMultiplier: "2", creditsPerCurrency: "10", source: { kind: "custom" } };
    const derived = { ...deriveModelPriceRules(derivation)!, derivation };
    const accepted = fixture(async () => Response.json({ draft: draft({ rules: derived }) }));
    expect((await accepted.client.save(write({ rules: derived })))?.rules.derivation).toEqual(derivation);
    accepted.client.close();
    for (const variant of ["missing", "different-source"] as const) {
        const reply = structuredClone(derived);
        if (variant === "missing") delete (reply as ModelPriceRules).derivation;
        else reply.derivation.source = { kind: "saved_cost", draftId: "11111111-1111-4111-8111-111111111111", draftVersion: 1 };
        const changed = fixture(async () => Response.json({ draft: draft({ rules: reply }) }));
        await expect(changed.client.save(write({ rules: derived }))).rejects.toThrow("回执不一致");
        expect(changed.calls).toHaveLength(1); changed.client.close();
    }
});

test("model price draft reads only the private scoped no-store endpoint and projects its contract", async () => {
    const f = fixture(async () => Response.json({ ...catalog(), models: [{ ...model, privateKey: "discard" }], items: [{ ...draft(), privateKey: "discard", binding: { ...model.binding, privateKey: "discard" } }] }));
    const result = await f.client.load();
    expect(result).toEqual({ models: [model], items: [draft()] });
    expect(JSON.stringify(result)).not.toContain("discard");
    expect(f.calls).toHaveLength(1); expect(f.calls[0].path).toBe("/api/v1/admin/model-price-drafts");
    expect(f.calls[0].init).toMatchObject({ method: "GET", credentials: "same-origin", redirect: "error", cache: "no-store" });
    expect(new Headers(f.calls[0].init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
    expect(f.calls[0].init?.body).toBeUndefined(); f.client.close();
});

test("model price draft keeps independent currencies and templates, and normalizes strings without inventing unknown costs", async () => {
    for (const cost of [null, "0", "0.120"] as const) {
        const data = rules(); data.cost.bands[0].rates.image_input_token = cost;
        const input = write({ rules: data }); input.rules.sale.bands[0].rates.image = "7.000";
        const savedRules = structuredClone(input.rules); savedRules.sale.bands[0].rates.image = "7";
        savedRules.cost!.bands[0].rates.image_input_token = cost === "0.120" ? "0.12" : cost;
        const saved = draft({ rules: savedRules }), f = fixture(async () => Response.json({ draft: saved }));
        expect(await f.client.save(input)).toEqual(saved);
        expect(f.calls).toHaveLength(1); expect(f.calls[0].init?.method).toBe("POST");
        const body = JSON.parse(String(f.calls[0].init?.body));
        expect(body.rules).toEqual(savedRules); expect(body.rules.cost.currency).toBe("USD"); expect(body.rules.sale.currency).toBe("credit");
        expect(body.rules.cost.template).toBe("image_tokens"); expect(body.rules.sale.template).toBe("image_count");
        expect(body.creditsPerUnit).toBeUndefined(); expect(body.enabled).toBeUndefined(); f.client.close();
    }
    const noCost = draft({ rules: { ...rules(), cost: null } }), f = fixture(async () => Response.json({ draft: noCost }));
    expect((await f.client.save(write({ rules: noCost.rules })))?.rules.cost).toBeNull(); f.client.close();
});

test("model price draft validates the complete meter set, templates, currencies and parameter bands before POST", async () => {
    const f = fixture(async () => Response.json(catalog()));
    const invalidAmounts: unknown[] = [0.3, "1e-3", " 0.3", "0.3\n", "0.3\r\n", "-1", "", "01.2", ["0.3"], null];
    for (const amount of invalidAmounts) {
        const input = write(); input.rules.sale.bands[0].rates.image = amount as unknown as string;
        await expect(f.client.save(input)).rejects.toBeInstanceOf(PlatformServiceError);
    }
    const base = write();
    const invalidRules: unknown[] = [
        { ...base.rules, sale: { ...base.rules.sale, currency: "CNY" } },
        { ...base.rules, cost: { ...base.rules.cost!, currency: "credit" } },
        { ...base.rules, sale: { template: "video_second", currency: "credit", bands: [{ parameters: {}, rates: { second: "2" } }] } },
        { ...base.rules, sale: { ...base.rules.sale, bands: [{ parameters: {}, rates: {} }] } },
        { ...base.rules, sale: { ...base.rules.sale, bands: [{ parameters: {}, rates: { image: "1", request: "2" } }] } },
        { ...base.rules, sale: { ...base.rules.sale, bands: [{ parameters: {}, rates: { image: "1" } }, { parameters: { quality: "high" }, rates: { image: "2" } }] } },
        { ...base.rules, sale: { ...base.rules.sale, bands: [{ parameters: { unknown: "value" }, rates: { image: "2" } }] } },
    ];
    for (const value of invalidRules) await expect(f.client.save(write({ rules: value as ModelPriceDraftWrite["rules"] }))).rejects.toBeInstanceOf(PlatformServiceError);
    expect(f.calls).toHaveLength(0); f.client.close();
});

test("model price draft rejects malformed catalogues and the former CNY-only contract", async () => {
    const invalid: unknown[] = [
        { ...catalog(), models: [{ ...model, binding: { ...model.binding, capability: "audio" } }] },
        { ...catalog(), items: [draft(), draft()] }, catalog(draft({ version: 0 })),
        catalog(draft({ binding: { ...model.binding, endpoint: "https://changed.example.invalid/v1" } })),
        catalog({ ...draft(), rules: undefined, currency: "CNY", billingUnit: "request", costAmount: "0.12", saleAmount: "0.3", estimatedGrossMargin: "0.18" } as unknown as AdminModelPriceDraft),
        catalog(draft({ rules: { ...rules(), sale: { ...rules().sale, bands: [{ parameters: {}, rates: { image: 0.3 as unknown as string } }] } } })),
    ];
    for (const body of invalid) { const f = fixture(async () => Response.json(body)); await expect(f.client.load()).rejects.toBeInstanceOf(PlatformServiceError); expect(f.calls).toHaveLength(1); f.client.close(); }
});

test("model price draft retains stale bindings without filling unknown costs or exposing extra fields", async () => {
    const stale = draft({ rules: { ...rules(), cost: null }, bindingMatchesCurrent: false, binding: { ...model.binding, providerModel: "previous-image" } });
    const f = fixture(async () => Response.json(catalog(stale)));
    expect((await f.client.load())?.items).toEqual([stale]); f.client.close();
    const removed = fixture(async () => Response.json({ models: [], items: [stale] }));
    expect(await removed.client.load()).toEqual({ models: [], items: [stale] }); removed.client.close();
});

test("model price draft includes text and video definitions without claiming execution or charging", async () => {
    const textModel: PriceDraftModel = { ...model, modelId: "synthetic-text", binding: { ...model.binding, capability: "text" } };
    const videoModel: PriceDraftModel = { ...model, modelId: "synthetic-video", binding: { ...model.binding, capability: "video", adapter: "sub2api" } };
    const textDraft = draft({ modelId: textModel.modelId, binding: textModel.binding, rules: { schemaVersion: 1, cost: null, sale: { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "2", output_token: "4" } }] } } });
    const videoDraft = draft({ id: "22222222-2222-4222-8222-222222222222", modelId: videoModel.modelId, binding: videoModel.binding, rules: { schemaVersion: 1, cost: null, sale: { template: "video_second", currency: "credit", bands: [{ parameters: { resolution: "720p", durationSeconds: "5" }, rates: { second: "0.2" } }, { parameters: { resolution: "1080p", durationSeconds: "5" }, rates: { second: "0.4" } }] } } });
    const f = fixture(async () => Response.json({ models: [textModel, videoModel], items: [textDraft, videoDraft] }));
    expect(await f.client.load()).toEqual({ models: [textModel, videoModel], items: [textDraft, videoDraft] });
    expect(f.calls.map((call) => call.init?.method)).toEqual(["GET"]); f.client.close();
});

test("model price draft version conflict and unknown save outcome never retry, and manual reread remains separate", async () => {
    for (const status of [409, 429, 503]) {
        const f = fixture(async (_, init) => init?.method === "POST" ? new Response("private-server-detail", { status }) : Response.json(catalog()));
        const input = write(); const snapshot = JSON.stringify(input);
        let error: unknown;
        try { await f.client.save(input); } catch (failure) { error = failure; }
        expect(error).toBeInstanceOf(PlatformServiceError); expect((error as PlatformServiceError).status).toBe(status);
        expect((error as Error).message).not.toContain("private-server-detail"); expect(JSON.stringify(input)).toBe(snapshot);
        expect(f.calls).toHaveLength(1); expect(await f.client.load()).toEqual({ models: [model], items: [draft()] });
        expect(f.calls.map((call) => call.init?.method)).toEqual(["POST", "GET"]); f.client.close();
    }
});

test("model price draft acknowledged save remains a success when its later catalogue refresh fails", async () => {
    const f = fixture(async (_, init) => init?.method === "POST" ? Response.json({ draft: draft() }) : new Response("unavailable", { status: 503 }));
    const saved = await f.client.save(write()); expect(saved).toEqual(draft());
    await expect(f.client.load()).rejects.toBeInstanceOf(PlatformServiceError);
    expect(saved?.version).toBe(1); expect(f.calls.map((call) => call.init?.method)).toEqual(["POST", "GET"]); f.client.close();
});

test("model price draft rejects mismatched write receipts without automatic resubmission", async () => {
    for (const saved of [draft({ version: 2 }), draft({ bindingMatchesCurrent: false }), draft({ rules: { ...rules(), sale: { ...rules().sale, bands: [{ parameters: {}, rates: { image: "9" } }] } } }), draft({ binding: { ...model.binding, providerId: "other" } })]) {
        const f = fixture(async () => Response.json({ draft: saved }));
        await expect(f.client.save(write())).rejects.toBeInstanceOf(PlatformServiceError); expect(f.calls).toHaveLength(1); f.client.close();
    }
});

for (const mode of ["account", "epoch", "role", "close"] as const) test(`model price draft JSON arriving after ${mode} invalidation cannot restore read or save results`, async () => {
    for (const method of ["GET", "POST"] as const) {
        const body = deferred<unknown>(), started = deferred<void>();
        const f = fixture(async () => { const response = Response.json({}); response.json = () => { started.resolve(); return body.promise; }; return response; });
        const pending = method === "GET" ? f.client.load() : f.client.save(write()); await started.promise;
        if (mode === "close") f.client.close();
        else f.change(mode === "role" ? null : { ...scope, ...(mode === "account" ? { accountId: "other-admin" } : { epoch: scope.epoch + 1 }) });
        body.resolve(method === "GET" ? catalog() : { draft: draft() }); expect(await pending).toBeNull();
        expect(f.calls[0].init?.signal?.aborted).toBe(true);
        f.change({ ...scope }); expect(await f.client.load()).toBeNull(); expect(f.calls).toHaveLength(1); f.client.close();
    }
});

test("model price draft newer explicit read supersedes late bodies and late failures", async () => {
    for (const fail of [false, true]) {
        const gate = deferred<void>(), started = deferred<void>(); let count = 0;
        const f = fixture(async () => { if (++count > 1) return Response.json({ models: [], items: [] }); const response = Response.json({}); response.json = async () => { started.resolve(); await gate.promise; if (fail) throw new Error("late"); return catalog(); }; return response; });
        const first = f.client.load(); await started.promise;
        expect(await f.client.load()).toEqual({ models: [], items: [] }); gate.resolve(); expect(await first).toBeNull();
        expect(f.calls[0].init?.signal?.aborted).toBe(true); expect(f.calls).toHaveLength(2); f.client.close();
    }
});
