import { z } from "zod/v4";
import { mappingExecutionKey, parseMappingExecution, type MappingExecution } from "../../../../packages/shared/src/model-mapping-execution";
import { validMappingSpecification } from "../../../../packages/shared/src/model-mapping-drafts";

export type MappingCatalogCombination = { specification: string; execution: MappingExecution; credits: number } &
    ({ available: true; nodeModelId: string; priceVersion: number } | { available: false });
export type MappingCatalogModel = { id: string; displayName: string; capability: "image" | "video"; group: string;
    specifications: string[]; combinations: MappingCatalogCombination[] };
export type PublishedMappingCatalog = { version: number; models: MappingCatalogModel[] };
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/);
const name = z.string().min(1).max(120).refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value));
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const common = { specification: z.string(), execution: z.unknown(), credits: positive };
const schema = z.object({ version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), models: z.array(z.object({
    id, displayName: name, capability: z.enum(["image", "video"]), group: z.union([z.literal(""), name]), specifications: z.array(z.string()),
    combinations: z.array(z.discriminatedUnion("available", [
        z.object({ ...common, available: z.literal(true), nodeModelId: id, priceVersion: positive }).strict(),
        z.object({ ...common, available: z.literal(false) }).strict(),
    ])),
}).strict()) }).strict();

/** Public fields only; labels never synthesize execution parameters or a fallback source. */
export function parsePublishedMappingCatalog(value: unknown): PublishedMappingCatalog | null {
    const parsed = schema.safeParse(value);
    if (!parsed.success || parsed.data.version === 0 && parsed.data.models.length) return null;
    const ids = new Set<string>(), routes = new Set<string>(), models: MappingCatalogModel[] = [];
    for (const model of parsed.data.models) {
        if (ids.has(model.id) || new Set(model.specifications).size !== model.specifications.length ||
            model.specifications.some(spec => !validMappingSpecification(spec, model.capability))) return null;
        ids.add(model.id);
        const keys = new Set<string>(), combinations: MappingCatalogCombination[] = [];
        for (const item of model.combinations) {
            const execution = parseMappingExecution(item.execution, model.capability, item.specification);
            if (!execution || !model.specifications.includes(item.specification)) return null;
            const key = JSON.stringify([item.specification, mappingExecutionKey(execution)]);
            if (keys.has(key)) return null;
            keys.add(key);
            if (item.available) {
                const route = JSON.stringify([item.nodeModelId, mappingExecutionKey(execution)]);
                if (routes.has(route)) return null;
                routes.add(route);
            }
            combinations.push({ ...item, execution });
        }
        models.push({ ...model, combinations });
    }
    return { version: parsed.data.version, models };
}
