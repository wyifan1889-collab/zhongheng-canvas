import type { ModelPriceBinding } from "./model-pricing-drafts";

const commonRatios = ["1:1", "2:3", "3:2", "4:3", "3:4", "4:5", "5:4", "16:9", "9:16", "21:9"] as const;
const commonSizes = ["1K", "2K", "4K"] as const;
const flashRatios = [...commonRatios, "1:4", "4:1", "1:8", "8:1"] as const;
const flashSizes = ["512", ...commonSizes] as const;

export type GeminiImageSpecification = { aspectRatio: typeof flashRatios[number]; imageSize: typeof flashSizes[number] };
export type GeminiImageOptions = { aspectRatio: readonly GeminiImageSpecification["aspectRatio"][]; imageSize: readonly GeminiImageSpecification["imageSize"][] };

/** Exact combinations from the saved channel contract. A tier does not specify pixel dimensions. */
export function geminiImageOptions(providerModel: string): GeminiImageOptions | null {
    if (providerModel === "gemini-3.1-flash-image-preview") return { aspectRatio: flashRatios, imageSize: flashSizes };
    if (providerModel === "gemini-3-pro-image-preview") return { aspectRatio: commonRatios, imageSize: commonSizes };
    return null;
}

export function geminiImageBindingOptions(binding: ModelPriceBinding): GeminiImageOptions | null {
    if (binding.capability !== "image" || binding.adapter !== "openai-compatible") return null;
    if (!/^https:\/\/[^/?#@\s\\]+\/?$/i.test(binding.endpoint)) return null;
    try {
        const url = new URL(binding.endpoint);
        if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) return null;
    } catch { return null; }
    return geminiImageOptions(binding.providerModel);
}

export function parseGeminiImageSpecification(providerModel: string | undefined, value: unknown): GeminiImageSpecification | null {
    // Public projections omit the upstream model. Binding validation still requires its exact name.
    const options = providerModel === undefined ? { aspectRatio: flashRatios, imageSize: flashSizes } : geminiImageOptions(providerModel);
    if (!options || !value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2 ||
        !Object.hasOwn(value, "aspectRatio") || !Object.hasOwn(value, "imageSize")) return null;
    const { aspectRatio, imageSize } = value as GeminiImageSpecification;
    return options.aspectRatio.includes(aspectRatio) && options.imageSize.includes(imageSize) ? { aspectRatio, imageSize } : null;
}

export const GEMINI_IMAGE_PROTOCOL = "gemini-generate-content-v1" as const;
export const GEMINI_IMAGE_USAGE = "delivered_images" as const;
export type GeminiImageIntent = GeminiImageSpecification & { protocol: typeof GEMINI_IMAGE_PROTOCOL; budgetCredits: number };

/** The budget is a wallet authorization. Only the two native fields are sent upstream. */
export function parseGeminiImageIntent(value: unknown, providerModel?: string): GeminiImageIntent | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (Object.keys(row).length !== 4 || row.protocol !== GEMINI_IMAGE_PROTOCOL || typeof row.budgetCredits !== "number" ||
        !Number.isSafeInteger(row.budgetCredits) || row.budgetCredits <= 0) return null;
    const spec = parseGeminiImageSpecification(providerModel, { aspectRatio: row.aspectRatio, imageSize: row.imageSize });
    return spec ? { protocol: GEMINI_IMAGE_PROTOCOL, ...spec, budgetCredits: row.budgetCredits } : null;
}

/** Documented output dimensions provide a check on the actual decoded PNG. See IMG-04 evidence. */
const dimensions1K: Record<GeminiImageSpecification["aspectRatio"], [number, number]> = {
    "1:1": [1024, 1024], "1:4": [512, 2048], "4:1": [2048, 512], "1:8": [384, 3072], "8:1": [3072, 384],
    "2:3": [848, 1264], "3:2": [1264, 848], "3:4": [896, 1200], "4:3": [1200, 896], "4:5": [928, 1152],
    "5:4": [1152, 928], "9:16": [768, 1376], "16:9": [1376, 768], "21:9": [1584, 672],
};
export function geminiImageDimensions(spec: GeminiImageSpecification) {
    // The published 512 / 21:9 table entry conflicts with its aspect ratio. Await channel evidence.
    if (spec.imageSize === "512" && spec.aspectRatio === "21:9") return null;
    const [w, h] = dimensions1K[spec.aspectRatio];
    const scale = { "512": 0.5, "1K": 1, "2K": 2, "4K": 4 }[spec.imageSize];
    return { width: w * scale, height: h * scale };
}
