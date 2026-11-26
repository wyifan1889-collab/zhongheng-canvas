import { selectImageSpecPrice } from "../../../../packages/shared/src/model-price-publications";
import type { GenerationModel } from "@/services/saas/generation";
import type { PersonalMediaParameters } from "@/stores/use-creation-media-launch";

type DefaultGuard = { fresh: boolean; current: boolean; ready: boolean; loading: boolean; unchanged: boolean; busy: boolean; pending: boolean; error: boolean };

/** This only chooses data. Callers recheck the live draft before a guarded write. */
export function firstPlatformDefault<T>(models: readonly T[], guard: DefaultGuard): T | undefined {
    return guard.fresh && guard.current && guard.ready && !guard.loading && guard.unchanged && !guard.busy && !guard.pending && !guard.error ? models[0] : undefined;
}

export function initialPlatformImageParameters(model: GenerationModel): PersonalMediaParameters {
    return { model: model.id, imageModel: model.id, ...(model.imagePricing?.protocol !== "gemini-generate-content-v1" ? model.imagePricing?.imageSpecs[0]?.parameters : {}) };
}

/** Catalog reference price is independent of the explicit review/quote gate. */
export function platformImageReferencePrice(models: readonly GenerationModel[], parameters: PersonalMediaParameters): number | undefined {
    const model = models.find(item => item.id === parameters.imageModel);
    if (!model?.imagePricing || model.imagePricing.protocol === "gemini-generate-content-v1") return undefined;
    const selected = Object.fromEntries(["size", "quality"].filter(key => parameters[key as "size" | "quality"] !== undefined).map(key => [key, parameters[key as "size" | "quality"]]));
    return selectImageSpecPrice(model.imagePricing, selected)?.creditsPerRequest;
}
