import { expect, test } from "bun:test";
import { evaluateGenerationPreflight, type GenerationPreflightSnapshot } from "../src/generation-config-preflight";

const now = new Date("2026-10-19T00:00:00.000Z");
const ready: GenerationPreflightSnapshot = {
    providers: [{ id: "provider-1", enabled: true, adapter: "openai-compatible", credentialConfigured: true }],
    models: [{ id: "catalog-1", publicId: "text-demo", providerId: "provider-1", capability: "text", enabled: true }],
    pricing: [{ modelId: "catalog-1", version: 1, billingUnit: "request", creditsPerUnit: 2, effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null, enabled: true }],
    wallets: [{ userId: "test-user", unit: "credit", availableUnits: "10", reservedUnits: "0" }],
};

test("preflight reports a ready text path without opening dependencies", () => {
    expect(evaluateGenerationPreflight(ready, { testAccountId: "test-user", now })).toMatchObject({
        status: "ready",
        summary: { enabledProviderCount: 1, eligibleTextModelCount: 1, activeTextPricingCount: 1, testWalletReady: true },
    });
});

test("unrelated structured text and video prices do not grant legacy readiness or poison an image preflight", () => {
    const textPrice = { ...ready.pricing[0], version: 2, billingUnit: "text_tokens" as const, creditsPerUnit: null };
    const videoPrice = { ...textPrice, modelId: "catalog-video", billingUnit: "video_specs" as const };
    const video = { ...ready.models[0], id: "catalog-video", publicId: "video-example", capability: "video" as const };
    const result = evaluateGenerationPreflight({ ...ready, models: [...ready.models, video], pricing: [...ready.pricing, textPrice, videoPrice] }, { testAccountId: "test-user", now });
    expect(result.status).toBe("blocked");
    expect(result.summary.activeTextPricingCount).toBe(0);
    expect(result.checks.find((check) => check.code === "active_text_pricing")?.status).toBe("fail");
    const image = evaluateGenerationPreflight({ ...imageReady, models: [...imageReady.models, video], pricing: [...imageReady.pricing, textPrice, videoPrice] }, imageOptions);
    expect(image.status).toBe("ready");
    expect(image.summary.image).toMatchObject({ priceVersion: 2, creditsPerRequest: 7 });
    for (const scalar of [0, 1, "2"]) {
        expect(() => evaluateGenerationPreflight({ ...ready, pricing: [{ ...textPrice, creditsPerUnit: scalar } as any] }, { testAccountId: "test-user", now })).toThrow();
    }
    expect(() => evaluateGenerationPreflight({ ...ready, pricing: [{ ...ready.pricing[0], creditsPerUnit: null } as any] }, { testAccountId: "test-user", now })).toThrow();
});

test("preflight blocks missing credential, inactive price and dirty wallet", () => {
    const result = evaluateGenerationPreflight({
        ...ready,
        providers: [{ ...ready.providers[0], credentialConfigured: false }],
        pricing: [{ ...ready.pricing[0], effectiveTo: "2026-10-18T00:00:00.000Z" }],
        wallets: [{ ...ready.wallets[0], availableUnits: "0", reservedUnits: "1" }],
    }, { testAccountId: "test-user", now });
    expect(result.status).toBe("blocked");
    expect(result.checks.filter((check) => check.status === "fail").map((check) => check.code)).toEqual([
        "enabled_provider_with_credential", "enabled_openai_text_model", "active_text_pricing", "clean_test_account_wallet",
    ]);
});

test("preflight rejects malformed snapshots and never accepts a secret-shaped provider field", () => {
    expect(() => evaluateGenerationPreflight({ ...ready, providers: [{ ...ready.providers[0], apiKey: "secret" } as any] }, { testAccountId: "test-user", now })).toThrow();
    expect(() => evaluateGenerationPreflight({ ...ready, apiKey: "secret" } as any, { testAccountId: "test-user", now })).toThrow();
});

test("preflight requires enough wallet units for one active text request", () => {
    const result = evaluateGenerationPreflight({ ...ready, wallets: [{ ...ready.wallets[0], availableUnits: "1" }] }, { testAccountId: "test-user", now });
    expect(result.status).toBe("blocked");
    expect(result.checks.find((check) => check.code === "clean_test_account_wallet")?.status).toBe("fail");
});

const imageOptions = { testAccountId: "test-user", now, capability: "image" as const, publicModelId: "image-selected" };
const imageReady: GenerationPreflightSnapshot = {
    ...ready,
    models: [
        ...ready.models,
        { ...ready.models[0], id: "catalog-image", publicId: "image-selected", capability: "image" },
        { ...ready.models[0], id: "catalog-cheap", publicId: "image-cheap", capability: "image" },
    ],
    pricing: [
        ...ready.pricing,
        { ...ready.pricing[0], modelId: "catalog-image", creditsPerUnit: 1 },
        { ...ready.pricing[0], modelId: "catalog-image", version: 2, creditsPerUnit: 7 },
        { ...ready.pricing[0], modelId: "catalog-cheap", creditsPerUnit: 1 },
    ],
};

test("image preflight selects the exact public model and latest effective request quote", () => {
    const result = evaluateGenerationPreflight(imageReady, imageOptions);
    expect(result).toMatchObject({
        status: "ready",
        summary: {
            eligibleTextModelCount: 0, activeTextPricingCount: 0, testWalletReady: true,
            image: { publicModelId: "image-selected", eligibleModelCount: 1, priceVersion: 2, billingUnit: "request", creditsPerRequest: 7, requiredWalletUnits: 7 },
        },
    });
    expect(result.checks.every((check) => check.status === "pass")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("test-user");
    expect(JSON.stringify(result)).not.toContain("provider-1");
});

test("image preflight cannot use a text model, an absent model, or a different model's price", () => {
    for (const publicModelId of ["text-demo", "missing-model"]) {
        const result = evaluateGenerationPreflight(imageReady, { ...imageOptions, publicModelId });
        expect(result.status).toBe("blocked");
        expect(result.summary.image?.eligibleModelCount).toBe(0);
    }
    const unpriced = evaluateGenerationPreflight({
        ...imageReady, pricing: imageReady.pricing.filter((price) => price.modelId !== "catalog-image"),
    }, imageOptions);
    expect(unpriced.status).toBe("blocked");
    expect(unpriced.summary.image?.priceVersion).toBeNull();
});

test("image preflight requires its own enabled supported channel and credential", () => {
    for (const change of [{ enabled: false }, { credentialConfigured: false }, { adapter: "sub2api" as const }]) {
        const result = evaluateGenerationPreflight({
            ...imageReady,
            providers: [
                { ...ready.providers[0], ...change },
                { ...ready.providers[0], id: "unrelated-enabled-provider" },
            ],
        }, imageOptions);
        expect(result.status).toBe("blocked");
        expect(result.summary.image?.eligibleModelCount).toBe(0);
    }
    expect(evaluateGenerationPreflight({
        ...imageReady,
        models: imageReady.models.map((model) => model.id === "catalog-image" ? { ...model, enabled: false } : model),
    }, imageOptions).status).toBe("blocked");
});

test("image preflight never falls back to an older request price when the latest price is unsupported", () => {
    const result = evaluateGenerationPreflight({
        ...imageReady,
        pricing: [...imageReady.pricing, { ...ready.pricing[0], modelId: "catalog-image", version: 3, billingUnit: "megapixel" }],
    }, imageOptions);
    expect(result.status).toBe("blocked");
    expect(result.summary.image).toMatchObject({ priceVersion: 3, billingUnit: "megapixel", creditsPerRequest: null });
    expect(result.checks.find((check) => check.code === "selected_latest_request_pricing")?.status).toBe("fail");
});

test("image wallet check cannot be reduced by an old price, a cheap model, or a caller override", () => {
    const input: GenerationPreflightSnapshot = {
        ...imageReady,
        pricing: [...imageReady.pricing, { ...ready.pricing[0], modelId: "catalog-image", version: 3, creditsPerUnit: 12 }],
    };
    const result = evaluateGenerationPreflight(input, { ...imageOptions, minimumWalletUnits: 1 });
    expect(result.status).toBe("blocked");
    expect(result.summary.image).toMatchObject({ priceVersion: 3, creditsPerRequest: 12, requiredWalletUnits: 12 });
    expect(result.summary.testWalletReady).toBe(false);
    const raised = evaluateGenerationPreflight({ ...input, wallets: [{ ...ready.wallets[0], availableUnits: "25" }] }, { ...imageOptions, minimumWalletUnits: 20 });
    expect(raised.status).toBe("ready");
    expect(raised.summary.image?.requiredWalletUnits).toBe(20);
});

test("image price eligibility uses production effective interval and enabled-version rules", () => {
    const result = evaluateGenerationPreflight({
        ...imageReady,
        pricing: [
            ...imageReady.pricing.map((price) => price.modelId === "catalog-image" && price.version === 2 ? { ...price, effectiveFrom: now } : price),
            { ...ready.pricing[0], modelId: "catalog-image", version: 3, effectiveTo: now },
            { ...ready.pricing[0], modelId: "catalog-image", version: 4, effectiveFrom: new Date(now.getTime() + 1) },
            { ...ready.pricing[0], modelId: "catalog-image", version: 5, enabled: false },
        ],
        wallets: [{ ...ready.wallets[0], availableUnits: "7" }],
    }, imageOptions);
    expect(result.status).toBe("ready");
    expect(result.summary.image).toMatchObject({ priceVersion: 2, creditsPerRequest: 7, requiredWalletUnits: 7 });
});

test("image preflight uses only the selected test wallet and still rejects reserved balance", () => {
    for (const change of [{ availableUnits: "6" }, { reservedUnits: "1" }]) {
        const result = evaluateGenerationPreflight({
            ...imageReady,
            wallets: [{ ...ready.wallets[0], ...change }, { ...ready.wallets[0], userId: "other-user", availableUnits: "1000" }],
        }, imageOptions);
        expect(result.status).toBe("blocked");
        expect(result.summary.testWalletReady).toBe(false);
    }
});

test("image capability and target must be explicitly paired", () => {
    for (const selection of [{ capability: "image" }, { capability: "image", publicModelId: " " }, { publicModelId: "image-selected" }, { capability: "video" }]) {
        expect(() => evaluateGenerationPreflight(imageReady, { testAccountId: "test-user", now, ...selection } as any)).toThrow();
    }
});

test("decimal wallets compare exactly at the integer request threshold and retain tiny reservations", () => {
    const evaluate = (availableUnits: string, reservedUnits = "0") => evaluateGenerationPreflight({
        ...imageReady, wallets: [{ ...ready.wallets[0], availableUnits, reservedUnits }],
    }, imageOptions);
    expect(evaluate("6.999999999999999999999999999999999999").summary.testWalletReady).toBe(false);
    expect(evaluate("7").summary.testWalletReady).toBe(true);
    expect(evaluate("7.000000000000000000000000000000000001").summary.testWalletReady).toBe(true);
    expect(evaluate("7", "0.000000000000000000000000000000000001").summary.testWalletReady).toBe(false);
    expect(evaluate("9007199254740993.000000000000000001").summary.testWalletReady).toBe(true);
    for (const availableUnits of ["NaN", "Infinity", "-Infinity", "-0.1", "1e3"]) {
        expect(() => evaluate(availableUnits)).toThrow();
    }
});
