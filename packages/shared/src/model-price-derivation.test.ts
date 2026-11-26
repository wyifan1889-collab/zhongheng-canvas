import { describe, expect, test } from "bun:test";
import { contextTierRates, deriveModelPriceRules, parseModelPriceDerivation, priceRuleSnapshotSignature, sameDerivedPriceRules, type ModelPriceDerivation, type ModelPriceDerivationV1, type ModelPriceDerivationV2 } from "./model-price-derivation";
import { parseModelPriceDraftWrite, parseModelPriceRules, type ModelPriceRule, type ModelPriceRules } from "./model-pricing-drafts";
import { composeTextContextTierNote, newTextPriceEligibility, parseTextPriceDerivationMetadata, publishedDraftPrice, publishedTextDraftRates, textContextTierNote, validTextContextTierNote } from "./model-price-publications";
import { evaluateTextCharge } from "./text-billing";
import { normalizeResponsesUsage } from "./text-usage";
import { parseTaskPriceSnapshot } from "./task-price-snapshot";

const custom = (): ModelPriceDerivationV1 => ({ schemaVersion: 1, kind: "multiplier",
    binding: { providerId: "channel-a", providerModel: "example-text", adapter: "openai-compatible", endpoint: "https://provider.example.invalid/v1", capability: "text" },
    basis: { template: "text_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "2.5", output_token: "10" } }] },
    costMultiplier: "0.3", saleMultiplier: "0.6", creditsPerCurrency: "70", source: { kind: "custom" },
});
const official = (): ModelPriceDerivationV1 => ({ ...custom(), source: { kind: "official", application: "fixed_baseline", sourceId: "openai", version: 3, checkedAt: "2026-10-25T00:00:00.000Z",
    entry: { id: "openai:example-text", modelName: "Example Text", context: "Explicit two-rate Standard reference", rates: [{ label: "Input", usdPerMillion: "2.5" }, { label: "Output", usdPerMillion: "10" }] },
    mapping: { Input: "input_token", Output: "output_token" },
} });

const threeBucket = (): ModelPriceDerivationV1 => ({ ...custom(), costMultiplier: null, saleMultiplier: "0.36", creditsPerCurrency: "100",
    basis: { template: "text_cached_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "2", cached_input_token: "0.2", output_token: "10" } }] },
    source: { kind: "official", application: "fixed_baseline", sourceId: "openai", version: 4, checkedAt: "2026-10-25T00:00:00.000Z",
        entry: { id: "openai:example-three", modelName: "Synthetic three bucket", context: "Synthetic standard", rates: [{ label: "Input", usdPerMillion: "2" }, { label: "Cache", usdPerMillion: "0.2" }, { label: "Output", usdPerMillion: "10" }] },
        mapping: { Input: "input_token", Cache: "cached_input_token", Output: "output_token" } } });
const withDerivation = (derivation: ModelPriceDerivation): ModelPriceRules => ({ ...deriveModelPriceRules(derivation)!, derivation });

const contextTiers = (): ModelPriceDerivationV2 => ({ ...threeBucket(), schemaVersion: 2,
    basis: { template: "text_cached_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "2", cached_input_token: "0.1", output_token: "10" } }] },
    source: { kind: "official", application: "context_tiers", sourceId: "openai", version: 2, checkedAt: "2026-10-29T07:29:08.289Z",
        entry: { id: "openai:gpt-6.1-sol", modelName: "gpt-6.1-sol", context: "官方输入 ≤272K / >272K；平台总量规则单列", rates: [
            { label: "短上下文输入", usdPerMillion: "2" }, { label: "短上下文输出", usdPerMillion: "10" }, { label: "短上下文缓存读取", usdPerMillion: "0.1" },
            { label: "短上下文缓存写入（30 分钟）", usdPerMillion: "2.5" }, { label: "短上下文缓存写入（12 小时）", usdPerMillion: "5" },
            { label: "长上下文输入", usdPerMillion: "4" }, { label: "长上下文输出", usdPerMillion: "15" }, { label: "长上下文缓存读取", usdPerMillion: "0.2" },
            { label: "长上下文缓存写入（30 分钟）", usdPerMillion: "5" }, { label: "长上下文缓存写入（12 小时）", usdPerMillion: "10" },
        ] },
        selection: { metric: "total_tokens", shortMaxTotalTokens: 272000,
            short: { "短上下文输入": "input_token", "短上下文缓存读取": "cached_input_token", "短上下文输出": "output_token" },
            long: { "长上下文输入": "input_token", "长上下文缓存读取": "cached_input_token", "长上下文输出": "output_token" } } },
});

test("context v2 freezes all ten original rows and derives six selected rates with one multiplier", () => {
    const origin = contextTiers(), before = structuredClone(origin), rules = withDerivation(origin);
    expect(parseModelPriceDerivation(origin, "text")).toEqual(origin);
    expect(parseModelPriceRules(rules, "text")).toEqual(rules);
    expect(rules.sale.bands).toEqual([{ parameters: {}, rates: { input_token: "72", cached_input_token: "3.6", output_token: "360" } }]);
    expect(contextTierRates(origin)).toEqual({ short: { inputCreditsPerMillion: "72", cachedInputCreditsPerMillion: "3.6", outputCreditsPerMillion: "360" },
        long: { inputCreditsPerMillion: "144", cachedInputCreditsPerMillion: "7.2", outputCreditsPerMillion: "540" } });
    expect(newTextPriceEligibility(origin.binding, rules, 1).status).toBe("available");
    expect(origin).toEqual(before);
    expect(origin.source.entry.context).toBe(before.source.entry.context);
    expect(parseTextPriceDerivationMetadata(newTextPriceEligibility(origin.binding, rules, 1).status === "available" ?
        (newTextPriceEligibility(origin.binding, rules, 1) as any).metadata : null, 1)?.officialPrices).toEqual({ input: "2", cachedInput: "0.1", output: "10" });
});

test("context v2 rejects omitted, repeated, cross-tier and TTL-write selections instead of guessing by price", () => {
    for (const mutate of [
        (v: any) => { delete v.source.selection.long["长上下文输出"]; },
        (v: any) => { v.source.selection.long["长上下文输出"] = "input_token"; },
        (v: any) => { v.source.selection.long = structuredClone(v.source.selection.short); },
        (v: any) => { delete v.source.selection.long["长上下文输入"]; v.source.selection.long["长上下文缓存写入（30 分钟）"] = "input_token"; },
        (v: any) => { v.source.selection.short["短上下文输出"] = "cached_input_token"; },
        (v: any) => { v.source.selection.long.Other = "output_token"; },
        (v: any) => { v.source.selection.shortMaxTotalTokens = 278528; },
        (v: any) => { v.source.selection.metric = "input_tokens"; },
        (v: any) => { v.source.entry.rates.pop(); },
        (v: any) => { v.source.entry.rates[9].label = v.source.entry.rates[8].label; },
        (v: any) => { v.source.entry.rates[5].usdPerMillion = null; },
        (v: any) => { v.source.entry.rates[0].usdPerMillion = "3"; },
        (v: any) => { v.source.entry.private = "no-extra-fields"; },
        (v: any) => { v.source.entry.rates[0].private = "no-extra-fields"; },
    ]) {
        const origin = contextTiers(); mutate(origin);
        expect(parseModelPriceDerivation(origin, "text")).toBeNull();
        expect(contextTierRates(origin)).toBeNull();
    }
});

test("context version is explicit and cannot degrade into a legacy fixed price", () => {
    const origin = contextTiers();
    for (const version of [undefined, 0, 1, 3, "2"]) expect(parseModelPriceDerivation({ ...origin, schemaVersion: version }, "text")).toBeNull();
    expect(parseModelPriceDerivation({ ...origin, source: { ...origin.source, mapping: {} } }, "text")).toBeNull();
    expect(parseModelPriceDerivation({ ...threeBucket(), schemaVersion: 2 }, "text")).toBeNull();
    expect(contextTierRates(threeBucket())).toBeNull();
    expect(contextTierRates(null)).toBeNull();
    expect(contextTierRates({ ...origin, creditsPerCurrency: "1" })).toBeNull();
});

test("zero long prices stay draft-only and long arithmetic beyond integer precision remains exact", () => {
    const origin = contextTiers(); origin.source.entry.rates[5].usdPerMillion = "0";
    expect(parseModelPriceDerivation(origin, "text")).not.toBeNull();
    expect(contextTierRates(origin)).toBeNull();
    expect(publishedDraftPrice(origin.binding, withDerivation(origin))).toBeNull();
    expect(newTextPriceEligibility(origin.binding, withDerivation(origin), 1)).toEqual({ status: "unavailable", reason: "zero_rate_unsupported" });
    origin.source.entry.rates[5].usdPerMillion = "9007199254740993";
    origin.saleMultiplier = "0.0000000000000001";
    expect(contextTierRates(origin)?.long.inputCreditsPerMillion).toBe("90.07199254740993");
});

test("mandatory note is deterministic, version-bound and identical on initial publish and replay", () => {
    const origin = contextTiers(), rules = withDerivation(origin), note = textContextTierNote(rules, origin.binding)!;
    expect(note).toContain("超过272K按长档计价");
    expect(note).toContain("T=I+O");
    expect(note).toContain("272000");
    expect(note).toContain("非缓存输入 144、缓存读取 7.2、输出 540");
    expect(note).not.toContain(origin.binding.endpoint);
    const final = composeTextContextTierNote(rules, origin.binding, "管理员备注")!;
    expect(final).toBe(note + "\n\n管理员备注");
    expect(composeTextContextTierNote(rules, origin.binding, final)).toBe(final);
    expect(validTextContextTierNote(rules, origin.binding, final)).toBe(true);
    expect(validTextContextTierNote(rules, origin.binding, note)).toBe(true);
    for (const invalid of ["", note.slice(1), note + "无分隔备注", note + "\n\n ", null]) expect(validTextContextTierNote(rules, origin.binding, invalid)).toBe(false);
    const changed = structuredClone(origin); changed.saleMultiplier = "1";
    expect(validTextContextTierNote(withDerivation(changed), changed.binding, note)).toBe(false);
    expect(textContextTierNote(rules, { ...origin.binding, providerModel: "changed" })).toBeNull();
    expect(textContextTierNote(withDerivation(threeBucket()), origin.binding)).toBeNull();
});

test("new three-bucket admissions use one sale multiplier, exact credits and a safe frozen-version explanation", () => {
    const origin = threeBucket(), rules = withDerivation(origin), eligible = newTextPriceEligibility(origin.binding, rules, 7);
    expect(eligible.status).toBe("available");
    if (eligible.status !== "available") throw new Error("fixture");
    expect(eligible.rates).toMatchObject({ inputCreditsPerMillion: "72", cachedInputCreditsPerMillion: "7.2", outputCreditsPerMillion: "360" });
    const quote = { schemaVersion: 1 as const, budgetCredits: "1", usageSource: "responses" as const, inputCreditsPerMillion: "72", cachedInputCreditsPerMillion: "7.2", outputCreditsPerMillion: "360" };
    expect(evaluateTextCharge(quote, normalizeResponsesUsage({ input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 400, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 20 } }))).toBe("0.06408");
    for (const costMultiplier of [null, "0.18", "10"]) {
        const altered = withDerivation({ ...origin, costMultiplier });
        const result = newTextPriceEligibility(origin.binding, altered, 7);
        expect(result.status === "available" && result.rates).toEqual(eligible.rates);
    }
    const safe = parseTextPriceDerivationMetadata({ ...eligible.metadata, endpoint: "private", costMultiplier: "private", credential: "private" }, 7);
    expect(safe).toEqual(eligible.metadata);
    expect(JSON.stringify(safe)).not.toContain("private");
    expect(parseTextPriceDerivationMetadata(eligible.metadata, 8)).toBeNull();
    expect(newTextPriceEligibility({ ...origin.binding, providerModel: "changed" }, rules, 7).status).toBe("unavailable");
});

test("missing official prices, multiplier, units, complete mapping and arithmetic never acquire defaults; old rates remain readable", () => {
    const origin = threeBucket(), rules = withDerivation(origin);
    for (const mutate of [
        (row: any) => delete row.derivation,
        (row: any) => delete row.derivation.saleMultiplier,
        (row: any) => { row.derivation.saleMultiplier = "0"; },
        (row: any) => { row.derivation.creditsPerCurrency = "1"; },
        (row: any) => { row.derivation.source = { kind: "custom" }; },
        (row: any) => { row.derivation.basis.bands[0].rates.cached_input_token = null; },
        (row: any) => { row.derivation.source.entry.rates.pop(); },
        (row: any) => { row.sale.bands[0].rates.input_token = "73"; },
    ]) { const copy = structuredClone(rules); mutate(copy); expect(newTextPriceEligibility(origin.binding, copy, 1).status).toBe("unavailable"); }
    const zero = threeBucket(); zero.basis.bands[0].rates.cached_input_token = "0";
    if (zero.source.kind === "official") zero.source.entry.rates[1].usdPerMillion = "0";
    expect(newTextPriceEligibility(zero.binding, withDerivation(zero), 1)).toEqual({ status: "unavailable", reason: "zero_rate_unsupported" });
    const { derivation: _origin, ...legacy } = rules;
    expect(publishedTextDraftRates(origin.binding, legacy)).not.toBeNull();
    expect(newTextPriceEligibility(origin.binding, legacy, 1).status).toBe("unavailable");
});

test("derived publication and historical snapshots require their complete bound channel identity", () => {
    const derivation = custom(), rules = { ...deriveModelPriceRules(derivation)!, derivation };
    expect(publishedDraftPrice(derivation.binding, rules)?.billingUnit).toBe("text_tokens");
    const otherBinding = { ...derivation.binding, providerModel: "another-upstream-model" };
    expect(publishedDraftPrice(otherBinding, rules)).toBeNull();
    const snapshot = { status: "recorded", publicationId: "11111111-1111-4111-8111-111111111111", draftId: "22222222-2222-4222-8222-222222222222", draftVersion: 1, priceVersion: 1,
        publicPriceNote: "fixed version", publishedAt: "2026-10-25T00:00:00.000Z", binding: derivation.binding, rules };
    expect(parseTaskPriceSnapshot(snapshot)).toEqual(snapshot);
    expect(parseTaskPriceSnapshot({ ...snapshot, binding: otherBinding })).toBeNull();
});

describe("immutable multiplier price derivation", () => {
    test("materializes independent procurement and credit sale rules exactly without mutating the source", () => {
        const value = custom(), original = structuredClone(value), result = deriveModelPriceRules(value);
        expect(result).toEqual({ schemaVersion: 1,
            cost: { template: "text_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "0.75", output_token: "3" } }] },
            sale: { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { input_token: "105", output_token: "420" } }] },
        });
        expect(result && sameDerivedPriceRules(result, value)).toBe(true);
        expect(value).toEqual(original);
        expect(result && "derivation" in result).toBe(false);
    });

    test("keeps unknown procurement distinct from a confirmed zero procurement multiplier", () => {
        const value = custom(); value.costMultiplier = null;
        const unknown = deriveModelPriceRules(value)!;
        expect(unknown.cost).toBeNull();
        expect(unknown.sale.bands[0].rates).toEqual({ input_token: "105", output_token: "420" });
        value.costMultiplier = "0";
        expect(deriveModelPriceRules(value)?.cost?.bands[0].rates).toEqual({ input_token: "0", output_token: "0" });
        expect(parseModelPriceDerivation({ ...value, costMultiplier: "" }, "text")).toBeNull();
    });

    test("requires explicit positive selling and quote factors and a nonnegative cost factor", () => {
        for (const factor of ["", "0", "-1", "1e-3", " 1", "1.", "NaN"]) {
            expect(parseModelPriceDerivation({ ...custom(), saleMultiplier: factor }, "text")).toBeNull();
            expect(parseModelPriceDerivation({ ...custom(), creditsPerCurrency: factor }, "text")).toBeNull();
        }
        expect(parseModelPriceDerivation({ ...custom(), costMultiplier: "-1" }, "text")).toBeNull();
        expect(parseModelPriceDerivation({ ...custom(), saleMultiplier: "0.600", costMultiplier: "0.300", creditsPerCurrency: "70.00" }, "text")).toMatchObject({ saleMultiplier: "0.6", costMultiplier: "0.3", creditsPerCurrency: "70" });
    });

    test("preserves every saved source specification instead of replacing a multi-band price with one preview band", () => {
        const value: ModelPriceDerivation = { ...custom(), binding: { ...custom().binding, capability: "image" },
            basis: { template: "image_count", currency: "CNY", bands: [
                { parameters: { size: "1K", quality: "standard" }, rates: { image: "0.2" } },
                { parameters: { size: "2K", quality: "standard" }, rates: { image: "0.4" } },
                { parameters: { size: "4K", quality: "standard" }, rates: { image: "0.8" } },
            ] }, costMultiplier: "1", saleMultiplier: "2", creditsPerCurrency: "10",
            source: { kind: "saved_cost", draftId: "11111111-1111-4111-8111-111111111111", draftVersion: 2 },
        };
        const result = deriveModelPriceRules(value)!;
        expect(result.sale.bands.map(band => [band.parameters, band.rates.image])).toEqual([
            [{ size: "1K", quality: "standard" }, "4"], [{ size: "2K", quality: "standard" }, "8"], [{ size: "4K", quality: "standard" }, "16"],
        ]);
        expect(result.cost?.bands.length).toBe(3);
        const dropped = structuredClone(result); dropped.sale.bands.splice(1);
        expect(sameDerivedPriceRules(dropped, value)).toBe(false);
    });

    test("retains video per-second resolution and duration conditions without turning them into per-video units", () => {
        const value: ModelPriceDerivation = { ...custom(), binding: { ...custom().binding, capability: "video" }, costMultiplier: "1", saleMultiplier: "2", creditsPerCurrency: "10",
            basis: { template: "video_second", currency: "CNY", bands: [
                { parameters: { resolution: "720p", durationSeconds: "5" }, rates: { second: "0.1" } },
                { parameters: { resolution: "1080p", durationSeconds: "10" }, rates: { second: "0.2" } },
            ] },
        };
        expect(deriveModelPriceRules(value)?.sale).toEqual({ template: "video_second", currency: "credit", bands: [
            { parameters: { resolution: "720p", durationSeconds: "5" }, rates: { second: "2" } },
            { parameters: { resolution: "1080p", durationSeconds: "10" }, rates: { second: "4" } },
        ] });
    });

    test("accepts only explicit complete bijective official labels mapped to the supported template", () => {
        const value = official(), parsed = parseModelPriceDerivation(value, "text");
        expect(parsed).toEqual(value);
        expect(deriveModelPriceRules(value)?.sale.bands[0].rates).toEqual({ input_token: "105", output_token: "420" });
        for (const mapping of [{}, { Input: "input_token" }, { Input: "input_token", Output: "input_token" }, { Input: "input_token", Output: "second" }, { Input: "input_token", Output: "output_token", Other: "image" }]) {
            expect(parseModelPriceDerivation({ ...value, source: { ...value.source, mapping } }, "text")).toBeNull();
        }
        const swapped = structuredClone(value);
        if (swapped.source.kind === "official") swapped.source.mapping = { Input: "output_token", Output: "input_token" };
        expect(parseModelPriceDerivation(swapped, "text")).toBeNull();
    });

    test("rejects a full official price containing unsupported cache rows instead of dropping or merging them", () => {
        const value = official();
        if (value.source.kind !== "official") throw new Error("test source");
        value.source.entry.rates.push({ label: "Cache read", usdPerMillion: "0.25" });
        expect(parseModelPriceDerivation(value, "text")).toBeNull();
        value.source.mapping["Cache read"] = "input_token";
        expect(parseModelPriceDerivation(value, "text")).toBeNull();
        expect(deriveModelPriceRules(value)).toBeNull();
    });

    test("requires explicit fixed-baseline application while preserving all official context conditions", () => {
        const value = official();
        if (value.source.kind !== "official") throw new Error("test source");
        value.source.entry.context = "Standard, context >200K; selected as a platform fixed baseline, no automatic tier switching";
        expect(parseModelPriceDerivation(value, "text")?.source).toMatchObject({ application: "fixed_baseline", entry: { context: value.source.entry.context } });
        const { application: _removed, ...withoutApplication } = value.source;
        expect(parseModelPriceDerivation({ ...value, source: withoutApplication }, "text")).toBeNull();
        expect(parseModelPriceDerivation({ ...value, source: { ...value.source, application: "follow_provider_tiers" } }, "text")).toBeNull();
    });

    test("does not use an unknown source price even when other source rows and factors are valid", () => {
        const value = official();
        if (value.source.kind !== "official") throw new Error("test source");
        value.source.entry.rates[0].usdPerMillion = null;
        expect(deriveModelPriceRules(value)).toBeNull();
        const unknown = custom(); unknown.basis.bands[0].rates.input_token = null;
        expect(deriveModelPriceRules(unknown)).toBeNull();
    });

    test("checks source version identities, source key sets and the complete bound capability", () => {
        const value = official();
        if (value.source.kind !== "official") throw new Error("test source");
        for (const version of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(parseModelPriceDerivation({ ...value, source: { ...value.source, version } }, "text")).toBeNull();
        expect(parseModelPriceDerivation({ ...value, source: { ...value.source, checkedAt: "not-a-date" } }, "text")).toBeNull();
        expect(parseModelPriceDerivation({ ...custom(), source: { kind: "saved_cost", draftId: "not-a-uuid", draftVersion: 2 } }, "text")).toBeNull();
        expect(parseModelPriceDerivation({ ...custom(), source: { kind: "saved_cost", draftId: "11111111-1111-4111-8111-111111111111", draftVersion: 0 } }, "text")).toBeNull();
        expect(parseModelPriceDerivation({ ...custom(), source: { kind: "custom", unexpected: true } }, "text")).toBeNull();
        expect(parseModelPriceDerivation({ ...custom(), unexpected: true }, "text")).toBeNull();
        expect(parseModelPriceDerivation(custom(), "image")).toBeNull();
        expect(parseModelPriceDerivation({ ...custom(), binding: { ...custom().binding, endpoint: "http://insecure.example.invalid" } }, "text")).toBeNull();
    });

    test("detects tampered generated rates, units or specification conditions but canonicalizes object-key order", () => {
        const value = custom(), generated = deriveModelPriceRules(value)!;
        const tampered = structuredClone(generated); tampered.sale.bands[0].rates.input_token = "104";
        expect(sameDerivedPriceRules(tampered, value)).toBe(false);
        tampered.sale.bands[0].rates.input_token = "105.00";
        expect(sameDerivedPriceRules(tampered, value)).toBe(true);
        const reordered: ModelPriceRule = { template: "text_tokens", currency: "credit", bands: [{ parameters: {}, rates: { output_token: "420", input_token: "105" } }] };
        expect(priceRuleSnapshotSignature(reordered)).toBe(priceRuleSnapshotSignature(generated.sale));
        const noCost = { ...generated, cost: null } satisfies ModelPriceRules;
        expect(sameDerivedPriceRules(noCost, value)).toBe(false);
        const wrongUnits = structuredClone(generated); wrongUnits.sale.template = "image_count";
        expect(sameDerivedPriceRules(wrongUnits, value)).toBe(false);
    });

    test("keeps tiny factors and amounts beyond safe integers exact without fixed precision rounding", () => {
        const value = custom(); value.costMultiplier = "0.1"; value.saleMultiplier = "0.0000000000000001"; value.creditsPerCurrency = "0.0000000000000001";
        value.basis.bands[0].rates = { input_token: "9007199254740993", output_token: "0.0000000000000001" };
        const result = deriveModelPriceRules(value)!;
        expect(result.cost?.bands[0].rates.input_token).toBe("900719925474099.3");
        expect(result.sale.bands[0].rates.input_token).toBe("0.00000000000000009007199254740993");
        expect(result.sale.bands[0].rates.output_token).toBe("0.000000000000000000000000000000000000000000000001");
    });

    test("round-trips provenance through the existing rule/write parsers without recursive parsing or breaking legacy drafts", () => {
        const derivation = custom(), plain = deriveModelPriceRules(derivation)!;
        expect(parseModelPriceRules(plain, "text")).toEqual(plain);
        const derived = { ...plain, derivation };
        expect(parseModelPriceRules(derived, "text")).toEqual(derived);
        const write = { modelId: "platform-text", expectedVersion: 0, binding: derivation.binding, rules: derived, priceNote: "explicit multiplier derivation" };
        expect(parseModelPriceDraftWrite(write)).toEqual(write);
        const tampered = structuredClone(write); tampered.rules.sale.bands[0].rates.input_token = "104";
        expect(parseModelPriceDraftWrite(tampered)).toBeNull();
        expect(parseModelPriceRules({ ...plain, derivation: null }, "text")).toBeNull();
        expect(parseModelPriceDraftWrite({ ...write, binding: { ...write.binding, providerModel: "different-upstream-model" } })).toBeNull();
    });
});
