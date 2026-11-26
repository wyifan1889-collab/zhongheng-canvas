import { parseImagePricePolicy, type ImagePricePolicy } from "./generation-image-protocol";

export type ImageRequestPolicy = ImagePricePolicy & { maxImagesPerRequest: number };

export function parseImageRequestPolicy(value: unknown): ImageRequestPolicy | null {
    const policy = parseImagePricePolicy(value);
    return policy?.maxImagesPerRequest === undefined ? null : { ...policy, maxImagesPerRequest: policy.maxImagesPerRequest };
}

/** The complete plan is decided before any supplier call, never inferred from an error. */
export function imageRequestCounts(total: number, perRequest: number): number[] {
    if (![total, perRequest].every(value => Number.isSafeInteger(value) && value >= 1 && value <= 10)) throw new Error("Invalid image request counts");
    return Array.from({ length: Math.ceil(total / perRequest) }, (_, index) => Math.min(perRequest, total - index * perRequest));
}
