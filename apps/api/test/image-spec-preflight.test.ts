import { expect, test } from "bun:test";
import { OPENAI_IMAGE_PROTOCOL, type ImageSpecParameters, type PublishedImageSpecPrice } from "@infinite-canvas/shared";
import { evaluateGenerationPreflight, generationPreflightSnapshotSchema, type GenerationPreflightSnapshot } from "../src/generation-config-preflight";
import { imageSpecFitsPixelBudget, MAX_IMAGE_SPEC_PIXELS, MAX_IMAGE_SPEC_RGBA_BYTES } from "../src/generation-image-limits";

// Synthetic prices and specifications only; these are not supplier capabilities or approved charges.
const now = new Date("2026-10-25T00:00:00.000Z");
const low = { size: "640x480", quality: "low" } as const;
const high = { size: "1280x960", quality: "high" } as const;
const imageSpecs: PublishedImageSpecPrice["imageSpecs"] = [
    { parameters: low, creditsPerRequest: 7 },
    { parameters: high, creditsPerRequest: 11 },
];
const options = { testAccountId: "synthetic-preflight-wallet", now, capability: "image" as const,
    publicModelId: "synthetic-preflight-image", imageSpec: high };
const specPrice = { modelId: "synthetic-preflight-model", version: 2, billingUnit: "image_specs" as const, creditsPerUnit: null, protocol: OPENAI_IMAGE_PROTOCOL, imageSpecs,
    effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null, enabled: true };
const snapshot: GenerationPreflightSnapshot = {
    providers: [{ id: "synthetic-preflight-provider", enabled: true, adapter: "openai-compatible", credentialConfigured: true }],
    models: [{ id: "synthetic-preflight-model", publicId: options.publicModelId, providerId: "synthetic-preflight-provider", capability: "image", enabled: true }],
    pricing: [specPrice],
    wallets: [{ userId: options.testAccountId, unit: "credit", availableUnits: "11", reservedUnits: "0" }],
};

function withSpecs(value: unknown): GenerationPreflightSnapshot {
    return { ...snapshot, pricing: [{ ...specPrice, imageSpecs: value } as any] };
}

test("image-spec preflight requires the exact selected request amount, never the cheapest band", () => {
    expect(evaluateGenerationPreflight(snapshot, options)).toMatchObject({ status: "ready", summary: {
        image: { priceVersion: 2, billingUnit: "image_specs", creditsPerRequest: 11, requiredWalletUnits: 11 }, testWalletReady: true,
    } });
    const insufficient = evaluateGenerationPreflight({ ...snapshot, wallets: [{ ...snapshot.wallets[0]!, availableUnits: "10" }] }, options);
    expect(insufficient.status).toBe("blocked");
    expect(insufficient.summary.image?.requiredWalletUnits).toBe(11);
    expect(evaluateGenerationPreflight({ ...snapshot, wallets: [{ ...snapshot.wallets[0]!, availableUnits: "7" }] }, { ...options, imageSpec: low }).status).toBe("ready");
});

test("image-spec wallet overrides can raise the selected amount and cannot lower it", () => {
    expect(evaluateGenerationPreflight(snapshot, { ...options, minimumWalletUnits: 1 }).summary.image?.requiredWalletUnits).toBe(11);
    const raised = evaluateGenerationPreflight(snapshot, { ...options, minimumWalletUnits: 20 });
    expect(raised.status).toBe("blocked");
    expect(raised.summary.image?.requiredWalletUnits).toBe(20);
    expect(evaluateGenerationPreflight({ ...snapshot, wallets: [{ ...snapshot.wallets[0]!, availableUnits: "20" }] }, { ...options, minimumWalletUnits: 20 }).status).toBe("ready");
});

test("missing image-spec selection or source stays blocked without falling back to an older scalar price", () => {
    const older = { ...specPrice, version: 1, billingUnit: "request" as const, creditsPerUnit: 1 };
    const { imageSpecs: _specs, protocol: _protocol, ...olderScalar } = older;
    const { imageSpec: _selection, ...noSelection } = options;
    const { imageSpecs: _source, protocol: _sourceProtocol, ...noSource } = specPrice;
    for (const [pricing, selected] of [
        [[olderScalar, specPrice], noSelection],
        [[olderScalar, noSource], options],
    ] as const) {
        const result = evaluateGenerationPreflight({ ...snapshot, pricing: [...pricing] }, selected);
        expect(result.status).toBe("blocked");
        expect(result.summary.image).toMatchObject({ priceVersion: 2, billingUnit: "image_specs", creditsPerRequest: null, requiredWalletUnits: null });
        expect(result.summary.testWalletReady).toBe(false);
        expect(result.checks).toContainEqual({ code: "image_spec_execution_unavailable", status: "fail" });
    }
});

test("image-spec selection has exact keys and values without partial or Cartesian matching", () => {
    for (const imageSpec of [{ size: high.size }, { quality: high.quality }, { size: low.size, quality: high.quality }]) {
        const result = evaluateGenerationPreflight(snapshot, { ...options, imageSpec });
        expect(result.status).toBe("blocked");
        expect(result.summary.image?.creditsPerRequest).toBeNull();
        expect(result.summary.image?.requiredWalletUnits).toBeNull();
    }
    for (const imageSpec of [{}, { size: "auto" }, { quality: "auto" }, { ...high, background: "opaque" }, { ...high, n: 1 }]) {
        expect(() => evaluateGenerationPreflight(snapshot, { ...options, imageSpec: imageSpec as ImageSpecParameters })).toThrow();
    }
});

test("the complete image-spec price array must be valid even when a malformed band is not selected", () => {
    const invalid = [
        [],
        [...imageSpecs, { parameters: { size: "256x256" }, creditsPerRequest: 0 }],
        [...imageSpecs, { parameters: { size: "256x256" }, creditsPerRequest: 0.5 }],
        [...imageSpecs, { parameters: { size: "256x256" }, creditsPerRequest: Number.MAX_SAFE_INTEGER + 1 }],
        [...imageSpecs, { parameters: { size: "auto" }, creditsPerRequest: 3 }],
        [...imageSpecs, { parameters: {}, creditsPerRequest: 3 }],
        [...imageSpecs, { parameters: { size: "256x256", mode: "image" }, creditsPerRequest: 3 }],
        [...imageSpecs, { parameters: { size: "256x256" }, creditsPerRequest: 3, cost: "private" }],
        [...imageSpecs, { ...imageSpecs[0]! }],
        [...imageSpecs, { parameters: { size: low.size }, creditsPerRequest: 3 }],
    ];
    for (const value of invalid) expect(() => evaluateGenerationPreflight(withSpecs(value), options)).toThrow();
    expect(() => generationPreflightSnapshotSchema.parse({ ...snapshot, pricing: [{ ...snapshot.pricing[0]!, binding: {} }] })).toThrow();
});

test("image-spec readiness honors the latest eligible price, provider and selected wallet", () => {
    const { imageSpecs: _specifications, protocol: _protocol, ...latestWithoutSource } = { ...specPrice, version: 3 };
    expect(evaluateGenerationPreflight({ ...snapshot, pricing: [...snapshot.pricing, latestWithoutSource] }, options).status).toBe("blocked");
    for (const change of [{ enabled: false }, { credentialConfigured: false }, { adapter: "sub2api" as const }]) {
        expect(evaluateGenerationPreflight({ ...snapshot, providers: [{ ...snapshot.providers[0]!, ...change }] }, options).status).toBe("blocked");
    }
    expect(evaluateGenerationPreflight({ ...snapshot, wallets: [{ ...snapshot.wallets[0]!, reservedUnits: "0.000000000000000001" }] }, options).status).toBe("blocked");
    expect(evaluateGenerationPreflight({ ...snapshot, wallets: [{ ...snapshot.wallets[0]!, userId: "other-synthetic-wallet", availableUnits: "1000" }] }, options).status).toBe("blocked");
});

test("structured image prices require their matching protocol and never reinterpret Gemini as OpenAI", () => {
    for (const pricing of [{ ...specPrice, protocol: undefined }, { ...specPrice, protocol: "gemini-generate-content-v1" }, { ...specPrice, imageSpecs: undefined }]) {
        expect(generationPreflightSnapshotSchema.safeParse({ ...snapshot, pricing: [pricing] }).success).toBe(false);
    }
    expect(evaluateGenerationPreflight(snapshot, options).status).toBe("ready");
});

test("image-spec selection is forbidden with the text preflight capability", () => {
    for (const capability of [undefined, "text"]) {
        expect(() => evaluateGenerationPreflight(snapshot, { testAccountId: options.testAccountId, now, capability, imageSpec: high } as any)).toThrow();
    }
});

test("image-spec pixel budgets accept the approved boundary without guessing missing dimensions", () => {
    expect(MAX_IMAGE_SPEC_PIXELS).toBe(16_777_216);
    expect(MAX_IMAGE_SPEC_RGBA_BYTES).toBe(64 * 1024 * 1024);
    for (const size of ["4096x4096", "8192x2048", "2048x8192"]) {
        expect(imageSpecFitsPixelBudget({ size })).toBe(true);
        const result = evaluateGenerationPreflight(withSpecs([{ parameters: { size }, creditsPerRequest: 11 }]), { ...options, imageSpec: { size } });
        expect(result.status).toBe("ready");
        expect(result.checks).toContainEqual({ code: "image_spec_pixel_budget", status: "pass" });
    }
    for (const size of ["4097x4097", "8192x2049", "0x4096", "4096x0", "auto"]) expect(imageSpecFitsPixelBudget({ size })).toBe(false);
    const oversized = { size: "4097x4097", quality: "high" } as const;
    const blocked = evaluateGenerationPreflight(withSpecs([{ parameters: oversized, creditsPerRequest: 11 }]), { ...options, imageSpec: oversized });
    expect(blocked.status).toBe("blocked");
    expect(blocked.summary.image).toMatchObject({ creditsPerRequest: 11, requiredWalletUnits: 11 });
    expect(blocked.checks).toContainEqual({ code: "image_spec_pixel_budget", status: "fail" });
    expect(imageSpecFitsPixelBudget({ quality: "high" })).toBe(true);
    const qualityOnly = evaluateGenerationPreflight(withSpecs([{ parameters: { quality: "high" }, creditsPerRequest: 11 }]), { ...options, imageSpec: { quality: "high" } });
    expect(qualityOnly.status).toBe("ready");
    expect(qualityOnly.checks).toContainEqual({ code: "image_spec_pixel_budget", status: "pass" });
});
