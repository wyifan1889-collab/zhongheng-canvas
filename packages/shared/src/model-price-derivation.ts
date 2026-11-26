import { normalizePriceAmount, parseModelPriceBinding, parseModelPriceRule, PRICE_METERS, PRICE_TEMPLATES,
    type ModelPriceBinding, type ModelPriceRule, type ModelPriceRules, type PriceMeter, type PricingCapability } from "./model-pricing-drafts";
import { parseOfficialPriceEntries, type OfficialPriceEntry, type OfficialPriceSourceId } from "./official-price-reference";

/** An immutable administrator derivation, not a live lookup performed by billing. */
export type ModelPriceDerivationV1 = {
    schemaVersion: 1; kind: "multiplier"; binding: ModelPriceBinding; basis: ModelPriceRule;
    costMultiplier: string | null; saleMultiplier: string; creditsPerCurrency: string;
    source: { kind: "custom" } | { kind: "saved_cost"; draftId: string; draftVersion: number } |
        { kind: "official"; application: "fixed_baseline"; sourceId: OfficialPriceSourceId; version: number; checkedAt: string; entry: OfficialPriceEntry; mapping: Record<string, PriceMeter> };
};
export type TextContextSelection = {
    metric: "total_tokens"; shortMaxTotalTokens: 272000;
    short: Record<string, PriceMeter>; long: Record<string, PriceMeter>;
};
export type ModelPriceDerivationV2 = Omit<ModelPriceDerivationV1, "schemaVersion" | "source"> & {
    schemaVersion: 2;
    source: { kind: "official"; application: "context_tiers"; sourceId: OfficialPriceSourceId; version: number;
        checkedAt: string; entry: OfficialPriceEntry; selection: TextContextSelection };
};
export type ModelPriceDerivation = ModelPriceDerivationV1 | ModelPriceDerivationV2;
export type TextContextTierRates = { inputCreditsPerMillion: string; cachedInputCreditsPerMillion: string; outputCreditsPerMillion: string };

/** Exact original labels; equal amounts never make a TTL write or another tier interchangeable. */
const CONTEXT_ROWS = {
    short: { "短上下文输入": "input_token", "短上下文缓存读取": "cached_input_token", "短上下文输出": "output_token" },
    long: { "长上下文输入": "input_token", "长上下文缓存读取": "cached_input_token", "长上下文输出": "output_token" },
} as const;
const CONTEXT_WRITE_ROWS = ["短上下文缓存写入（30 分钟）", "短上下文缓存写入（12 小时）", "长上下文缓存写入（30 分钟）", "长上下文缓存写入（12 小时）"];

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const positiveVersion = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const date = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const uuid = (value: unknown): value is string => typeof value === "string" && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);

/** Parsing verifies shape, explicit mapping and arithmetic compatibility. The DB verifies source authenticity. */
export function parseModelPriceDerivation(value: unknown, capability: PricingCapability): ModelPriceDerivation | null {
    if (!object(value) || !keys(value, ["schemaVersion", "kind", "binding", "basis", "costMultiplier", "saleMultiplier", "creditsPerCurrency", "source"]) || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || value.kind !== "multiplier") return null;
    const binding = parseModelPriceBinding(value.binding), basis = parseModelPriceRule(value.basis, capability, "cost");
    const costMultiplier = value.costMultiplier === null ? null : normalizePriceAmount(value.costMultiplier);
    const saleMultiplier = normalizePriceAmount(value.saleMultiplier), creditsPerCurrency = normalizePriceAmount(value.creditsPerCurrency);
    if (!binding || binding.capability !== capability || !basis || (value.costMultiplier !== null && costMultiplier === null) || saleMultiplier === null || saleMultiplier === "0" || creditsPerCurrency === null || creditsPerCurrency === "0" || !object(value.source)) return null;
    // Every source price contributes to the sale. Unknown cannot become zero or disappear from a target template.
    if (basis.bands.some(band => PRICE_TEMPLATES[basis.template].meters.some(meter => band.rates[meter] === null))) return null;
    const input = value.source;
    if (value.schemaVersion === 2) {
        if (!keys(input, ["kind", "application", "sourceId", "version", "checkedAt", "entry", "selection"]) || input.kind !== "official" ||
            input.application !== "context_tiers" || (input.sourceId !== "openai" && input.sourceId !== "anthropic") ||
            !positiveVersion(input.version) || !date(input.checkedAt) || !object(input.selection) ||
            !keys(input.selection, ["metric", "shortMaxTotalTokens", "short", "long"]) || input.selection.metric !== "total_tokens" || input.selection.shortMaxTotalTokens !== 272000 ||
            binding.capability !== "text" || basis.template !== "text_cached_tokens" || basis.currency !== "USD" || creditsPerCurrency !== "100" ||
            basis.bands.length !== 1 || Object.keys(basis.bands[0].parameters).length) return null;
        const entry = parseOfficialPriceEntries([input.entry], input.sourceId)?.[0];
        const labels = [...Object.keys(CONTEXT_ROWS.short), ...Object.keys(CONTEXT_ROWS.long), ...CONTEXT_WRITE_ROWS];
        if (!object(input.entry) || !keys(input.entry, ["id", "modelName", "context", "rates"]) || !Array.isArray(input.entry.rates) ||
            input.entry.rates.some(rate => !object(rate) || !keys(rate, ["label", "usdPerMillion"])) ||
            !entry || entry.rates.length !== 10 || entry.rates.some(rate => !labels.includes(rate.label) || rate.usdPerMillion === null)) return null;
        const selection: TextContextSelection = { metric: "total_tokens", shortMaxTotalTokens: 272000, short: {}, long: {} };
        for (const tier of ["short", "long"] as const) {
            const mapping = input.selection[tier], expected = CONTEXT_ROWS[tier];
            if (!object(mapping) || !keys(mapping, Object.keys(expected))) return null;
            for (const [label, meter] of Object.entries(expected)) {
                const rate = entry.rates.find(item => item.label === label)!;
                if (mapping[label] !== meter || (tier === "short" && rate.usdPerMillion !== basis.bands[0].rates[meter])) return null;
                selection[tier][label] = meter;
            }
        }
        return { schemaVersion: 2, kind: "multiplier", binding, basis, costMultiplier, saleMultiplier, creditsPerCurrency,
            source: { kind: "official", application: "context_tiers", sourceId: input.sourceId, version: input.version, checkedAt: input.checkedAt, entry, selection } };
    }
    let source: ModelPriceDerivationV1["source"];
    if (input.kind === "custom") {
        if (!keys(input, ["kind"])) return null;
        source = { kind: "custom" };
    } else if (input.kind === "saved_cost") {
        if (!keys(input, ["kind", "draftId", "draftVersion"]) || !uuid(input.draftId) || !positiveVersion(input.draftVersion)) return null;
        source = { kind: "saved_cost", draftId: input.draftId, draftVersion: input.draftVersion };
    } else if (input.kind === "official") {
        if (!keys(input, ["kind", "application", "sourceId", "version", "checkedAt", "entry", "mapping"]) || input.application !== "fixed_baseline" || (input.sourceId !== "openai" && input.sourceId !== "anthropic") || !positiveVersion(input.version) || !date(input.checkedAt) || !object(input.mapping)) return null;
        const entry = parseOfficialPriceEntries([input.entry], input.sourceId)?.[0];
        const meters = PRICE_TEMPLATES[basis.template].meters;
        if (!entry || binding.capability !== "text" || !["text_tokens", "text_cached_tokens"].includes(basis.template) || basis.currency !== "USD" || basis.bands.length !== 1 || Object.keys(basis.bands[0].parameters).length || entry.rates.length !== meters.length || Object.keys(input.mapping).length !== entry.rates.length) return null;
        const mapped: [string, PriceMeter][] = [], seen = new Set<PriceMeter>();
        for (const rate of entry.rates) {
            if (!Object.hasOwn(input.mapping, rate.label)) return null;
            const meter = input.mapping[rate.label];
            if (typeof meter !== "string" || !Object.hasOwn(PRICE_METERS, meter) || !meters.includes(meter as PriceMeter) || seen.has(meter as PriceMeter) || PRICE_METERS[meter as PriceMeter].base !== 1_000_000 || rate.usdPerMillion === null || rate.usdPerMillion !== basis.bands[0].rates[meter as PriceMeter]) return null;
            seen.add(meter as PriceMeter); mapped.push([rate.label, meter as PriceMeter]);
        }
        source = { kind: "official", application: "fixed_baseline", sourceId: input.sourceId, version: input.version, checkedAt: input.checkedAt, entry, mapping: Object.fromEntries(mapped) };
    } else return null;
    return { schemaVersion: 1, kind: "multiplier", binding, basis, costMultiplier, saleMultiplier, creditsPerCurrency, source };
}

function multiply(values: string[]): string {
    const factors = values.map(value => { const [whole, fraction = ""] = value.split("."); return { coefficient: BigInt(whole + fraction), scale: fraction.length }; });
    const scale = factors.reduce((total, factor) => total + factor.scale, 0);
    const digits = factors.reduce((product, factor) => product * factor.coefficient, BigInt(1)).toString().padStart(scale + 1, "0");
    const value = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
    return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}

/** Both tiers are derived only from one complete, immutable, authenticated source. */
export function contextTierRates(value: unknown): { short: TextContextTierRates; long: TextContextTierRates } | null {
    const parsed = parseModelPriceDerivation(value, "text");
    if (!parsed || parsed.schemaVersion !== 2) return null;
    const result = {} as { short: TextContextTierRates; long: TextContextTierRates };
    for (const tier of ["short", "long"] as const) {
        const rates: Record<string, string> = {};
        for (const [label, meter] of Object.entries(parsed.source.selection[tier])) {
            const base = parsed.source.entry.rates.find(rate => rate.label === label)!.usdPerMillion!;
            const amount = normalizePriceAmount(multiply([base, parsed.saleMultiplier, parsed.creditsPerCurrency]));
            if (amount === null || amount === "0") return null;
            rates[meter] = amount;
        }
        result[tier] = { inputCreditsPerMillion: rates.input_token, cachedInputCreditsPerMillion: rates.cached_input_token, outputCreditsPerMillion: rates.output_token };
    }
    return result;
}

/** Materialize every band exactly once; no rates are read from a mutable source during execution. */
export function deriveModelPriceRules(derivation: ModelPriceDerivation): ModelPriceRules | null {
    const parsed = parseModelPriceDerivation(derivation, derivation.binding?.capability);
    if (!parsed) return null;
    const { basis, costMultiplier, saleMultiplier, creditsPerCurrency } = parsed;
    const materialize = (factors: string[], currency: ModelPriceRule["currency"]): ModelPriceRule => ({
        template: basis.template, currency, bands: basis.bands.map(band => ({ parameters: { ...band.parameters },
            rates: Object.fromEntries(PRICE_TEMPLATES[basis.template].meters.map(meter => [meter, multiply([band.rates[meter]!, ...factors])])) })),
    });
    const cost = costMultiplier === null ? null : parseModelPriceRule(materialize([costMultiplier], basis.currency), parsed.binding.capability, "cost");
    const sale = parseModelPriceRule(materialize([saleMultiplier, creditsPerCurrency], "credit"), parsed.binding.capability, "sale");
    return sale && (costMultiplier === null || cost) ? { schemaVersion: 1, cost, sale } : null;
}

/** Stable object-key order; band order and all specification conditions remain significant. */
export function priceRuleSnapshotSignature(rule: ModelPriceRule | null): string {
    return JSON.stringify(rule === null ? null : { template: rule.template, currency: rule.currency, bands: rule.bands.map(band => ({
        parameters: Object.fromEntries(Object.entries(band.parameters).sort(([a], [b]) => a.localeCompare(b))),
        rates: Object.fromEntries(Object.entries(band.rates).sort(([a], [b]) => a.localeCompare(b))),
    })) });
}

export function sameDerivedPriceRules(rules: Pick<ModelPriceRules, "schemaVersion" | "cost" | "sale">, derivation: ModelPriceDerivation): boolean {
    const expected = deriveModelPriceRules(derivation);
    if (!expected || rules.schemaVersion !== 1) return false;
    const cost = rules.cost === null ? null : parseModelPriceRule(rules.cost, derivation.binding.capability, "cost");
    const sale = parseModelPriceRule(rules.sale, derivation.binding.capability, "sale");
    return !!sale && (rules.cost === null || cost !== null) && priceRuleSnapshotSignature(cost) === priceRuleSnapshotSignature(expected.cost) && priceRuleSnapshotSignature(sale) === priceRuleSnapshotSignature(expected.sale);
}
