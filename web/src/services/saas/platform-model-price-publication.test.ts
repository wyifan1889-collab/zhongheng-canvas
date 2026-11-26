import { expect, test } from "bun:test";
import { createAdminModelPricePublicationClient, PlatformServiceError, type AdminGenerationScope, type AdminModelPriceDraft, type AdminModelPricePublication, type ModelPricePublicationPreview } from "./platform";

const scope: AdminGenerationScope = { accountId: "synthetic-publisher", epoch: 3, role: "admin" };
const saved = (): AdminModelPriceDraft => ({ id: "11111111-1111-4111-8111-111111111111", modelId: "synthetic-image", version: 2,
    binding: { providerId: "synthetic-channel", providerModel: "synthetic-upstream", endpoint: "https://synthetic.example.invalid/v1", adapter: "openai-compatible", capability: "image" },
    bindingMatchesCurrent: true, rules: { schemaVersion: 1, cost: { template: "image_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "2", output_token: "4", image_input_token: null, image_output_token: "8" } }] }, sale: { template: "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } },
    priceNote: "private internal cost note", createdAt: "2026-10-23T00:00:00Z" });
const published = (patch: Partial<Extract<AdminModelPricePublication, { billingUnit: "request" }>> = {}): Extract<AdminModelPricePublication, { billingUnit: "request" }> => ({ id: "22222222-2222-4222-8222-222222222222", modelId: saved().modelId,
    draftId: saved().id, draftVersion: 2, priceVersion: 4, billingUnit: "request", creditsPerUnit: 7, publicPriceNote: "", rules: saved().rules, binding: saved().binding,
    bindingMatchesCurrent: true, createdAt: "2026-10-23T00:00:01Z", ...patch });
const preview = (patch: Partial<ModelPricePublicationPreview> = {}): ModelPricePublicationPreview => ({ modelId: saved().modelId, draft: saved(), latestPriceVersion: 3,
    currentPrice: { version: patch.latestPriceVersion ?? 3, billingUnit: "request", creditsPerUnit: patch.publication?.billingUnit === "request" ? patch.publication.creditsPerUnit : 5, enabled: true }, publication: null, unavailableReason: null, ...patch });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function fixture(run: (path: string, init?: RequestInit) => Promise<Response>) {
    let current: AdminGenerationScope | null = { ...scope };
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => { calls.push({ path: String(input), init }); return run(String(input), init); }, { preconnect: fetch.preconnect });
    const client = createAdminModelPricePublicationClient({ scope, getScope: () => current, fetcher });
    return { client, calls, change(next: AdminGenerationScope | null) { current = next; } };
}

test("IMG-04 checks a read-only trial against the exact saved version and rejects inconsistent totals", async () => {
    const parameters = { aspectRatio: "16:9", imageSize: "1K" } as const;
    const draft = saved();
    draft.binding = { ...draft.binding, endpoint: "https://provider.example.invalid/", providerModel: "gemini-3.1-flash-image-preview" };
    draft.rules = { schemaVersion: 1, cost: null, sale: { template: "image_count", currency: "credit", bands: [{ parameters, rates: { image: "7" } }] } };
    const source = preview({ draft, unavailableReason: "unsupported_price_rule" });
    const quote = { status: "trial_only", modelId: draft.modelId, draftVersion: 2, priceVersion: 3, parameters, budgetCredits: 17, creditsPerImage: 7, coveredImages: 2 };
    let receipt: unknown = quote;
    const f = fixture(async path => new URL(path, "https://canvas.invalid").searchParams.has("budgetCredits") ? Response.json({ quote: receipt }) : Response.json({ preview: source }));
    const view = (await f.client.load(draft.modelId))!;
    expect(await f.client.trialGeminiImagePrice(view, parameters, 17)).toEqual(quote);
    expect(new URL(f.calls[1].path, "https://canvas.invalid").searchParams.get("aspectRatio")).toBe("16:9");
    expect(f.calls[1].init).toMatchObject({ method: "GET", cache: "no-store" });
    await expect(f.client.trialGeminiImagePrice(view, parameters, 6)).rejects.toThrow("不足以覆盖一张");
    expect(f.calls).toHaveLength(2);
    for (const bad of [{ ...quote, coveredImages: 3 }, { ...quote, priceVersion: 4 }, { ...quote, quoteFingerprint: "unexpected" },
        { ...quote, parameters: { ...parameters, imageSize: "2K" } }]) {
        receipt = bad;
        await expect(f.client.trialGeminiImagePrice(view, parameters, 17)).rejects.toThrow("试算回执不一致");
    }
    await expect(f.client.publish(view, "")).rejects.toBeInstanceOf(PlatformServiceError);
    expect(f.calls.every(call => call.init?.method === "GET")).toBe(true);
    f.client.close();
});

test("publication uses a scoped server preview and submits only the saved identity, price CAS and explicit public note", async () => {
    const f = fixture(async (_, init) => init?.method === "POST" ? Response.json({ publication: published({ publicPriceNote: "one image" }) }) : Response.json({ preview: { ...preview(), secret: "discard" } }));
    const view = (await f.client.load(saved().modelId))!;
    expect(view).toEqual(preview());
    expect(f.calls[0].path).toBe("/api/v1/admin/model-price-publications?modelId=synthetic-image");
    expect(f.calls[0].init).toMatchObject({ method: "GET", credentials: "same-origin", redirect: "error", cache: "no-store" });
    expect(new Headers(f.calls[0].init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
    expect(await f.client.publish(view, "one image")).toEqual(published({ publicPriceNote: "one image" }));
    const body = JSON.parse(String(f.calls[1].init?.body));
    expect(body).toEqual({ modelId: saved().modelId, draftId: saved().id, expectedDraftVersion: 2, expectedPriceVersion: 3, binding: saved().binding, publicPriceNote: "one image" });
    expect(JSON.stringify(body)).not.toContain("private internal"); expect(body.rules).toBeUndefined(); expect(body.creditsPerUnit).toBeUndefined();
    await expect(f.client.publish(view, "one image")).rejects.toBeInstanceOf(PlatformServiceError);
    expect(f.calls.map((call) => call.init?.method)).toEqual(["GET", "POST"]); f.client.close();
});

test("publication cannot use an invented, superseded, cancelled or unsupported preview", async () => {
    const f = fixture(async () => Response.json({ preview: preview() }));
    await expect(f.client.publish(preview(), "")).rejects.toBeInstanceOf(PlatformServiceError);
    const first = (await f.client.load(saved().modelId))!, second = (await f.client.load(saved().modelId))!;
    await expect(f.client.publish(first, "")).rejects.toBeInstanceOf(PlatformServiceError); f.client.cancel();
    await expect(f.client.publish(second, "")).rejects.toBeInstanceOf(PlatformServiceError);
    expect(f.calls.map((call) => call.init?.method)).toEqual(["GET", "GET"]); f.client.close();
    for (const rate of ["0", "0.5", "9007199254740992"]) {
        const draft = saved(); draft.rules.sale.bands[0].rates.request = rate;
        const g = fixture(async () => Response.json({ preview: preview({ draft, unavailableReason: "unsupported_price_rule" }) }));
        const value = (await g.client.load(saved().modelId))!;
        await expect(g.client.publish(value, "")).rejects.toBeInstanceOf(PlatformServiceError); expect(g.calls).toHaveLength(1); g.client.close();
    }
});

test("publication preview rejects mismatched identities, malformed money and incoherent publication links", async () => {
    const bad: unknown[] = [preview({ modelId: "another-model" }), preview({ latestPriceVersion: -1 }), preview({ draft: null }), preview({ currentPrice: null }),
        preview({ currentPrice: { version: 2, billingUnit: "request", creditsPerUnit: 5, enabled: true } }), preview({ latestPriceVersion: 0 }),
        preview({ currentPrice: { version: 3, billingUnit: "request", creditsPerUnit: 0.5, enabled: true } }),
        preview({ latestPriceVersion: 4, publication: published({ draftId: "33333333-3333-4333-8333-333333333333" }) }),
        preview({ latestPriceVersion: 4, publication: published({ creditsPerUnit: 9 }) }), preview({ unavailableReason: "private-message" as never }),
        preview({ latestPriceVersion: 4, publication: published(), currentPrice: { version: 4, billingUnit: "request", creditsPerUnit: 5, enabled: true } })];
    for (const row of bad) { const f = fixture(async () => Response.json({ preview: row })); await expect(f.client.load(saved().modelId)).rejects.toBeInstanceOf(PlatformServiceError); expect(f.calls).toHaveLength(1); f.client.close(); }
});

test("unknown publication never reposts: GET missing or newer draft does not clear the original lock", async () => {
    let stage = 0;
    const f = fixture(async (_, init) => init?.method === "POST" ? new Response("upstream private data", { status: 503 }) : Response.json({ preview: stage === 0 ? preview() : stage === 1 ? preview({ draft: { ...saved(), id: "33333333-3333-4333-8333-333333333333", version: 3 } }) : preview({ latestPriceVersion: 4, publication: published() }) }));
    const value = (await f.client.load(saved().modelId))!;
    await expect(f.client.publish(value, "")).rejects.toThrow("发布结果未确认"); expect(f.client.hasUnconfirmed(saved().modelId)).toBe(true);
    const missing = (await f.client.load(saved().modelId))!; await expect(f.client.publish(missing, "")).rejects.toBeInstanceOf(PlatformServiceError);
    stage = 1; const changed = (await f.client.load(saved().modelId))!; await expect(f.client.publish(changed, "")).rejects.toBeInstanceOf(PlatformServiceError);
    expect(f.client.hasUnconfirmed(saved().modelId)).toBe(true);
    stage = 2; expect((await f.client.load(saved().modelId))?.publication).toEqual(published()); expect(f.client.hasUnconfirmed(saved().modelId)).toBe(false);
    expect(f.calls.filter((call) => call.init?.method === "POST")).toHaveLength(1); f.client.close();
});

test("only a complete recognized rejection allows manual preview and confirmation again", async () => {
    for (const [status, code, known] of [[409, "price_publication_conflict", true], [409, "unexpected_conflict", false], [404, "model_not_found", true], [404, "not_found", false]] as const) {
        const f = fixture(async (_, init) => init?.method === "POST" ? Response.json({ error: { code } }, { status }) : Response.json({ preview: preview() }));
        const value = (await f.client.load(saved().modelId))!; await expect(f.client.publish(value, "")).rejects.toBeInstanceOf(PlatformServiceError);
        expect(f.client.hasUnconfirmed(saved().modelId)).toBe(!known);
        await expect(f.client.publish(value, "")).rejects.toBeInstanceOf(PlatformServiceError); expect(f.calls).toHaveLength(2);
        const refreshed = (await f.client.load(saved().modelId))!;
        await expect(f.client.publish(refreshed, "")).rejects.toBeInstanceOf(PlatformServiceError);
        expect(f.calls.filter((call) => call.init?.method === "POST")).toHaveLength(known ? 2 : 1); f.client.close();
    }
});

test("an unpriced saved draft uses the explicit zero baseline with no current row", async () => {
    const f = fixture(async (_, init) => init?.method === "POST" ? Response.json({ publication: published({ priceVersion: 1 }) }) : Response.json({ preview: preview({ latestPriceVersion: 0, currentPrice: null }) }));
    expect((await f.client.publish((await f.client.load(saved().modelId))!, ""))?.priceVersion).toBe(1);
    expect(JSON.parse(String(f.calls[1].init?.body)).expectedPriceVersion).toBe(0); f.client.close();
});

test("published receipts are projected and cannot mismatch the confirmed saved rules or public note", async () => {
    for (const row of [published({ publicPriceNote: "private note" }), published({ draftVersion: 9 }), published({ binding: { ...saved().binding, providerModel: "other" } }), published({ rules: { ...saved().rules, cost: null } })]) {
        const f = fixture(async (_, init) => Response.json(init?.method === "POST" ? { publication: row } : { preview: preview() }));
        await expect(f.client.publish((await f.client.load(saved().modelId))!, "")).rejects.toBeInstanceOf(PlatformServiceError);
        expect(f.client.hasUnconfirmed(saved().modelId)).toBe(true); expect(f.calls).toHaveLength(2); f.client.close();
    }
});

test("an acknowledged publication survives a failed subsequent GET without a second POST", async () => {
    let reads = 0;
    const f = fixture(async (_, init) => init?.method === "POST" ? Response.json({ publication: { ...published(), credential: "discard" } }) : ++reads === 1 ? Response.json({ preview: preview() }) : new Response("unavailable", { status: 503 }));
    const receipt = await f.client.publish((await f.client.load(saved().modelId))!, ""); expect(receipt).toEqual(published());
    await expect(f.client.load(saved().modelId)).rejects.toBeInstanceOf(PlatformServiceError); expect(receipt?.priceVersion).toBe(4);
    expect(f.client.hasUnconfirmed(saved().modelId)).toBe(false); expect(f.calls.map((call) => call.init?.method)).toEqual(["GET", "POST", "GET"]); f.client.close();
});

for (const mode of ["account", "epoch", "role", "close"] as const) test(`publication late response after ${mode} cannot restore a preview or a publish receipt`, async () => {
    for (const writing of [false, true]) {
        const body = deferred<unknown>(), started = deferred<void>(); let count = 0;
        const f = fixture(async () => { if (writing && ++count === 1) return Response.json({ preview: preview() }); const response = Response.json({}); response.json = () => { started.resolve(); return body.promise; }; return response; });
        const pending = writing ? f.client.publish((await f.client.load(saved().modelId))!, "") : f.client.load(saved().modelId); await started.promise;
        if (mode === "close") f.client.close(); else f.change(mode === "role" ? null : { ...scope, ...(mode === "account" ? { accountId: "other" } : { epoch: 4 }) });
        body.resolve(writing ? { publication: published() } : { preview: preview() }); expect(await pending).toBeNull();
        expect(f.calls.at(-1)?.init?.signal?.aborted).toBe(true); f.change(scope); expect(await f.client.load(saved().modelId)).toBeNull(); f.client.close();
    }
});

test("closing a publish dialog rejects its late body, while reopening performs GET reconciliation only", async () => {
    const body = deferred<unknown>(), started = deferred<void>(); let reads = 0;
    const f = fixture(async (_, init) => {
        if (init?.method === "GET") return Response.json({ preview: ++reads === 1 ? preview() : preview({ latestPriceVersion: 4, publication: published() }) });
        const response = Response.json({}); response.json = () => { started.resolve(); return body.promise; }; return response;
    });
    const pending = f.client.publish((await f.client.load(saved().modelId))!, ""); await started.promise; f.client.cancel();
    expect(f.client.hasUnconfirmed(saved().modelId)).toBe(true); body.resolve({ publication: published() }); expect(await pending).toBeNull();
    const reopened = (await f.client.load(saved().modelId))!; expect(reopened.publication).toEqual(published());
    await expect(f.client.publish(reopened, "")).rejects.toBeInstanceOf(PlatformServiceError);
    expect(f.calls.map((call) => call.init?.method)).toEqual(["GET", "POST", "GET"]); f.client.close();
});

test("a newer model selection supersedes a pending preview even when its JSON later succeeds", async () => {
    const body = deferred<unknown>(), started = deferred<void>(); let reads = 0;
    const f = fixture(async () => { if (++reads > 1) return Response.json({ preview: preview({ modelId: "other-image", draft: { ...saved(), modelId: "other-image" } }) });
        const response = Response.json({}); response.json = () => { started.resolve(); return body.promise; }; return response; });
    const first = f.client.load(saved().modelId); await started.promise; const next = await f.client.load("other-image");
    body.resolve({ preview: preview() }); expect(await first).toBeNull(); expect(next?.modelId).toBe("other-image"); expect(f.calls[0].init?.signal?.aborted).toBe(true); f.client.close();
});

const textSaved = (): AdminModelPriceDraft => ({ ...saved(), modelId: "synthetic-text", binding: { ...saved().binding, capability: "text" },
    rules: { schemaVersion: 1, cost: { template: "text_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "0.1", output_token: null } }] },
        sale: { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "0.000004", output_token: "9007199254740993.000002" } }] } } });
const textPublished = (): Extract<AdminModelPricePublication, { billingUnit: "text_tokens" }> => ({ ...published(), modelId: textSaved().modelId,
    binding: textSaved().binding, rules: textSaved().rules, billingUnit: "text_tokens", creditsPerUnit: null,
    inputCreditsPerMillion: "0.000004", outputCreditsPerMillion: "9007199254740993.000002" });
const textPreview = (publication: AdminModelPricePublication | null = null): ModelPricePublicationPreview => ({ modelId: textSaved().modelId, draft: textSaved(),
    latestPriceVersion: publication ? 4 : 3, currentPrice: { version: publication ? 4 : 3, billingUnit: "text_tokens", creditsPerUnit: null,
        inputCreditsPerMillion: publication ? "0.000004" : "2", outputCreditsPerMillion: publication ? "9007199254740993.000002" : "4", enabled: true }, publication, unavailableReason: null });

test("text publication keeps two exact rates in one saved version and sends no submitted prices or private cost", async () => {
    const f = fixture(async (_, init) => Response.json(init?.method === "POST" ? { publication: { ...textPublished(), credential: "discard" } } : { preview: textPreview() }));
    const value = (await f.client.load(textSaved().modelId))!;
    expect(value).toEqual(textPreview()); expect(await f.client.publish(value, "")).toEqual(textPublished());
    const body = JSON.parse(String(f.calls[1].init?.body));
    expect(body).toEqual({ modelId: textSaved().modelId, draftId: textSaved().id, expectedDraftVersion: 2, expectedPriceVersion: 3, binding: textSaved().binding, publicPriceNote: "" });
    expect(body.rules).toBeUndefined(); expect(body.inputCreditsPerMillion).toBeUndefined(); expect(body.priceNote).toBeUndefined();
    expect(f.calls.map(call => call.init?.method)).toEqual(["GET", "POST"]); f.client.close();
});

test("text publication rejects malformed dual rates and a contradictory same-version current price", async () => {
    const bad = [
        ...[0, "0", "0.0000040", "1e-6", "-1", "1\n", null, undefined].map(inputCreditsPerMillion => ({ ...textPublished(), inputCreditsPerMillion })),
        { ...textPublished(), creditsPerUnit: 0 }, { ...textPublished(), outputCreditsPerMillion: "4" },
        { ...textPublished(), binding: { ...textSaved().binding, capability: "image" } },
    ];
    for (const publication of bad) {
        const f = fixture(async (_, init) => Response.json(init?.method === "POST" ? { publication } : { preview: textPreview() }));
        await expect(f.client.publish((await f.client.load(textSaved().modelId))!, "")).rejects.toBeInstanceOf(PlatformServiceError);
        expect(f.client.hasUnconfirmed(textSaved().modelId)).toBe(true); expect(f.calls).toHaveLength(2); f.client.close();
    }
    const row = textPreview(textPublished()); row.currentPrice = { version: 4, billingUnit: "text_tokens", creditsPerUnit: null, inputCreditsPerMillion: "2", outputCreditsPerMillion: "4", enabled: true };
    const f = fixture(async () => Response.json({ preview: row }));
    await expect(f.client.load(textSaved().modelId)).rejects.toBeInstanceOf(PlatformServiceError); f.client.close();
});

test("unknown text publication remains GET-only until the saved dual-rate publication is found", async () => {
    let found = false;
    const f = fixture(async (_, init) => init?.method === "POST" ? new Response("unavailable", { status: 503 }) : Response.json({ preview: textPreview(found ? textPublished() : null) }));
    await expect(f.client.publish((await f.client.load(textSaved().modelId))!, "")).rejects.toThrow("发布结果未确认");
    expect(f.client.hasUnconfirmed(textSaved().modelId)).toBe(true);
    await expect(f.client.publish((await f.client.load(textSaved().modelId))!, "")).rejects.toBeInstanceOf(PlatformServiceError);
    found = true; expect((await f.client.load(textSaved().modelId))?.publication).toEqual(textPublished());
    expect(f.client.hasUnconfirmed(textSaved().modelId)).toBe(false); expect(f.calls.filter(call => call.init?.method === "POST")).toHaveLength(1); f.client.close();
});

test("cached-input publication preserves the third rate through draft, publish, and same-version verification", async () => {
    const draft = textSaved();
    draft.rules.sale = { template: "text_cached_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "0.000004", cached_input_token: "0.000001", output_token: "9007199254740993.000002" } }] };
    const publication = { ...textPublished(), rules: draft.rules, cachedInputCreditsPerMillion: "0.000001" };
    const before: ModelPricePublicationPreview = { ...textPreview(), draft };
    const f = fixture(async (_, init) => Response.json(init?.method === "POST" ? { publication } : { preview: before }));
    expect(await f.client.publish((await f.client.load(draft.modelId))!, "")).toEqual(publication);
    const body = JSON.parse(String(f.calls[1].init?.body));
    expect(body.cachedInputCreditsPerMillion).toBeUndefined(); expect(body.rules).toBeUndefined(); f.client.close();
    for (const cachedInputCreditsPerMillion of [undefined, "0.000002"]) {
        const after = { ...before, latestPriceVersion: 4, publication,
            currentPrice: { version: 4, billingUnit: "text_tokens" as const, creditsPerUnit: null, inputCreditsPerMillion: publication.inputCreditsPerMillion,
                outputCreditsPerMillion: publication.outputCreditsPerMillion, enabled: true, ...(cachedInputCreditsPerMillion === undefined ? {} : { cachedInputCreditsPerMillion }) } };
        const invalid = fixture(async () => Response.json({ preview: after }));
        await expect(invalid.client.load(draft.modelId)).rejects.toBeInstanceOf(PlatformServiceError); invalid.client.close();
    }
});
