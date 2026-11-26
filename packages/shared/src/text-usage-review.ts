import { evaluatePriceRule, parseModelPriceBinding, parseModelPriceRules, type AdminModelPriceDraft, type PriceSampleResult } from "./model-pricing-drafts";
import { parseTextUsageEvidence, type TextUsageEvidence } from "./text-usage";
import { textUsagePriceQuantities } from "./text-billing";

export type TextUsageDraftReview =
    | { status: "blocked"; reason: "missing_usage" | "invalid_usage" | "unsupported_usage" | "model_mismatch" | "binding_changed" | "invalid_draft" }
    | { status: "calculated"; mode: "draft_simulation"; draftId: string; draftVersion: number; cost: PriceSampleResult | null; sale: PriceSampleResult };

/** Read-only what-if using an explicitly selected saved draft. This is neither a
 * task's accepted price snapshot nor a provider invoice or wallet instruction.
 * text_tokens counts ALL input; text_cached_tokens separates cached reads.
 * Each cost/sale side retains its own template; output includes reasoning once.
 */
export function evaluateTextUsageDraft(modelId: string, usage: TextUsageEvidence | null, draft: AdminModelPriceDraft): TextUsageDraftReview {
    if (usage === null) return { status: "blocked", reason: "missing_usage" };
    const safeUsage = parseTextUsageEvidence(usage);
    if (!safeUsage || safeUsage.status === "invalid") return { status: "blocked", reason: "invalid_usage" };
    if (safeUsage.status !== "complete") return { status: "blocked", reason: "missing_usage" };
    if (draft.modelId !== modelId) return { status: "blocked", reason: "model_mismatch" };
    if (!draft.bindingMatchesCurrent) return { status: "blocked", reason: "binding_changed" };
    const binding = parseModelPriceBinding(draft.binding), rules = parseModelPriceRules(draft.rules, "text");
    if (!binding || binding.capability !== "text" || !rules || typeof draft.id !== "string" || !draft.id
        || !Number.isSafeInteger(draft.version) || draft.version < 1) return { status: "blocked", reason: "invalid_draft" };
    if ((rules.sale.template === "text_cached_tokens" || rules.cost?.template === "text_cached_tokens") && safeUsage.cacheWriteTokens === undefined) {
        return { status: "blocked", reason: "missing_usage" };
    }
    const saleCounts = textUsagePriceQuantities(rules.sale.template, safeUsage);
    const costCounts = rules.cost === null ? null : textUsagePriceQuantities(rules.cost.template, safeUsage);
    if (!saleCounts || rules.cost !== null && !costCounts) return { status: "blocked", reason: "unsupported_usage" };
    return { status: "calculated", mode: "draft_simulation", draftId: draft.id, draftVersion: draft.version,
        cost: rules.cost === null ? null : evaluatePriceRule(rules.cost, {}, costCounts!), sale: evaluatePriceRule(rules.sale, {}, saleCounts) };
}
