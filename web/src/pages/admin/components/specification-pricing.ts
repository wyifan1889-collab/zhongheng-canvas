import { evaluatePriceRule, PRICE_TEMPLATES, type ModelPriceRule, type ModelPriceRules, type PriceTemplate } from "@/services/saas/platform";

const parameterKey = (parameters: Record<string, string>) => JSON.stringify(Object.entries(parameters).sort(([a], [b]) => a.localeCompare(b)));

/** Pair only exact matching specifications; never flatten a different supplier cost rule. */
export function pairSpecificationCosts(rules: ModelPriceRules): ModelPriceRule | null | undefined {
    if (!["image_request", "image_count", "video_second", "video_count"].includes(rules.sale.template)) return undefined;
    if (!rules.cost) return null;
    if (!["image_request", "image_count", "video_second", "video_count"].includes(rules.cost.template) || rules.cost.bands.length !== rules.sale.bands.length) return undefined;
    const used = new Set<number>();
    const bands = rules.sale.bands.map(sale => {
        const index = rules.cost!.bands.findIndex((cost, i) => !used.has(i) && parameterKey(cost.parameters) === parameterKey(sale.parameters));
        if (index < 0) return null;
        used.add(index); return rules.cost!.bands[index];
    });
    return bands.some(band => !band) ? undefined : { ...rules.cost, bands: bands as ModelPriceRule["bands"] };
}

export function replaceSpecificationUnit(rule: ModelPriceRule, template: PriceTemplate, currency = rule.currency): ModelPriceRule {
    return { template, currency, bands: rule.bands.map(band => ({ parameters: { ...band.parameters },
        rates: Object.fromEntries(PRICE_TEMPLATES[template].meters.map(meter => [meter, currency === "credit" ? "" : null])) })) };
}

/** Single-output planning example only; this does not authorize a generation or charge. */
export function specificationSample(rule: ModelPriceRule, index: number) {
    const band = rule.bands[index];
    if (!band) return null;
    return evaluatePriceRule(rule, band.parameters, { request: "1", image: "1", video: "1", ...(band.parameters.durationSeconds ? { second: band.parameters.durationSeconds } : {}) });
}
