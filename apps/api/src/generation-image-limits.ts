import type { ImageSpecParameters } from "@infinite-canvas/shared";

export const MAX_IMAGE_SPEC_PIXELS = 16_777_216;
export const MAX_IMAGE_SPEC_RGBA_BYTES = 64 * 1024 * 1024;

/** An omitted size must be checked against the actual returned image later. */
export function imageSpecFitsPixelBudget(parameters: ImageSpecParameters): boolean {
    if (parameters.size === undefined) return true;
    if (typeof parameters.size !== "string" || !/^[1-9]\d*x[1-9]\d*$/.test(parameters.size)) return false;
    const [width, height] = parameters.size.split("x").map(BigInt);
    return width * height <= BigInt(MAX_IMAGE_SPEC_PIXELS);
}
