import { parseModelPriceBinding, parseModelPriceRules, sameModelPriceBinding, type ModelPriceBinding, type ModelPriceRules } from "./model-pricing-drafts";

/** Administrator-only projection of the immutable publication linked at task acceptance.
 * It records configured prices, not a supplier invoice, profit or settled charge.
 */
export type TaskPriceSnapshot =
    | { status: "not_recorded" | "invalid" }
    | {
        status: "recorded";
        publicationId: string;
        draftId: string;
        draftVersion: number;
        priceVersion: number;
        publicPriceNote: string;
        binding: ModelPriceBinding;
        rules: ModelPriceRules;
        publishedAt: string;
    };

const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;

/** Strict contract: neither incomplete/corrupt history nor unknown fields become a price. */
export function parseTaskPriceSnapshot(value: unknown): TaskPriceSnapshot | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (row.status === "not_recorded" || row.status === "invalid") {
        return Object.keys(row).length === 1 ? { status: row.status } : null;
    }
    const fields = ["status", "publicationId", "draftId", "draftVersion", "priceVersion", "publicPriceNote", "binding", "rules", "publishedAt"];
    if (row.status !== "recorded" || Object.keys(row).length !== fields.length || !fields.every((key) => Object.hasOwn(row, key)) ||
        !uuid(row.publicationId) || !uuid(row.draftId) || !positiveInteger(row.draftVersion) || !positiveInteger(row.priceVersion) ||
        typeof row.publicPriceNote !== "string" || typeof row.publishedAt !== "string" || !Number.isFinite(Date.parse(row.publishedAt))) return null;
    const binding = parseModelPriceBinding(row.binding);
    const rules = binding && parseModelPriceRules(row.rules, binding.capability);
    return binding && rules && (!rules.derivation || sameModelPriceBinding(rules.derivation.binding, binding)) ? {
        status: "recorded", publicationId: row.publicationId, draftId: row.draftId, draftVersion: row.draftVersion,
        priceVersion: row.priceVersion, publicPriceNote: row.publicPriceNote, binding, rules, publishedAt: row.publishedAt,
    } : null;
}
