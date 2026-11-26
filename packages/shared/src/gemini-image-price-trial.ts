import { GEMINI_IMAGE_PROTOCOL, GEMINI_IMAGE_USAGE, geminiImageBindingOptions, parseGeminiImageSpecification, type GeminiImageSpecification } from "./generation-gemini-image";
import { evaluatePriceRule, geminiImagePriceDraftMatchesBinding, parseModelPriceRules, type ModelPriceBinding, type AdminModelPriceDraft } from "./model-pricing-drafts";

export type GeminiImagePriceTrialInput = {
    draftVersion: number; priceVersion: number; parameters: GeminiImageSpecification; budgetCredits: number;
};
export type GeminiImagePriceTrial = GeminiImagePriceTrialInput & {
    modelId: string; creditsPerImage: number; coveredImages: number; status: "trial_only";
};

export function geminiImageDraftSpecs(draft: Pick<AdminModelPriceDraft, "binding" | "rules">) {
    const { binding, rules } = draft;
    if (!geminiImageBindingOptions(binding) || rules.image || rules.video || rules.sale.template !== "image_count" ||
        rules.sale.currency !== "credit" || !rules.sale.bands.length) return null;
    const specs = rules.sale.bands.map(({ parameters, rates }) => {
        const spec = parseGeminiImageSpecification(binding.providerModel, parameters), amount = rates.image;
        return spec && typeof amount === "string" && /^[1-9]\d*$/.test(amount) && Number.isSafeInteger(Number(amount))
            ? { parameters: spec, creditsPerImage: Number(amount) } : null;
    });
    return specs.every(spec => spec !== null) ? specs : null;
}

/** A saved-draft estimate: has no reservation, confirmation token or provider request. */
export function estimateGeminiImagePrice(draft: AdminModelPriceDraft, latestPriceVersion: number, input: GeminiImagePriceTrialInput):
    { status: "quoted"; quote: GeminiImagePriceTrial } |
    { status: "price_changed" | "model_binding_changed" | "unsupported_price_rule" | "invalid_input" | "budget_insufficient" } {
    if (input.draftVersion !== draft.version || input.priceVersion !== latestPriceVersion) return { status: "price_changed" };
    if (!draft.bindingMatchesCurrent) return { status: "model_binding_changed" };
    const parameters = parseGeminiImageSpecification(draft.binding.providerModel, input.parameters);
    if (!parameters || !Number.isSafeInteger(input.budgetCredits) || input.budgetCredits <= 0) return { status: "invalid_input" };
    const specs = geminiImageDraftSpecs(draft);
    const selected = specs?.filter(spec => spec.parameters.aspectRatio === parameters.aspectRatio && spec.parameters.imageSize === parameters.imageSize);
    if (selected?.length !== 1) return { status: "unsupported_price_rule" };
    const { creditsPerImage } = selected[0];
    const amount = evaluatePriceRule(draft.rules.sale, parameters, { image: "1" });
    if (amount.status !== "calculated" || amount.total !== String(creditsPerImage)) return { status: "unsupported_price_rule" };
    const coveredImages = Number(BigInt(input.budgetCredits) / BigInt(creditsPerImage));
    if (!coveredImages) return { status: "budget_insufficient" };
    return { status: "quoted", quote: { modelId: draft.modelId, draftVersion: input.draftVersion, priceVersion: latestPriceVersion,
        parameters, budgetCredits: input.budgetCredits, creditsPerImage, coveredImages, status: "trial_only" } };
}

export type PublishedGeminiImagePrice = {
    billingUnit: "image_specs"; creditsPerUnit: null; protocol: typeof GEMINI_IMAGE_PROTOCOL; usagePolicy: typeof GEMINI_IMAGE_USAGE;
    imageSpecs: { parameters: GeminiImageSpecification; creditsPerImage: number }[];
};

export function publishedGeminiImagePrice(binding: ModelPriceBinding, value: unknown): PublishedGeminiImagePrice | null {
    const rules = parseModelPriceRules(value, binding.capability);
    if (!rules || rules.derivation || !geminiImagePriceDraftMatchesBinding(binding, rules)) return null;
    const imageSpecs = geminiImageDraftSpecs({ binding, rules });
    return imageSpecs ? { billingUnit: "image_specs", creditsPerUnit: null, protocol: GEMINI_IMAGE_PROTOCOL, usagePolicy: GEMINI_IMAGE_USAGE, imageSpecs } : null;
}

export function selectGeminiImageBand(price: PublishedGeminiImagePrice, spec: GeminiImageSpecification) {
    const matches = price.imageSpecs.filter(item => item.parameters.aspectRatio === spec.aspectRatio && item.parameters.imageSize === spec.imageSize);
    return matches.length === 1 ? matches[0] : null;
}
