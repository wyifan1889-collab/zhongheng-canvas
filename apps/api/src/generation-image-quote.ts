import { createHash } from "node:crypto";
import type { GenerationIntent } from "./generation-contract";
import { GenerationContractError } from "./generation-contract";
import type { GenerationQuote } from "./generation-dispatch";

export function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new GenerationContractError("invalid_input", "图片报价意图无效");
    return encoded;
}

/** Confirmation of one server quote, never an authorization token or a client amount. */
export function imageQuoteFingerprint(ownerId: string, intent: GenerationIntent, price: {
    pricePublicationId: string; priceVersion: number; creditsPerUnit: number; quotedUnits: number;
}): string {
    if (!ownerId || ownerId.trim() !== ownerId) throw new GenerationContractError("invalid_input", "图片报价需要有效账号");
    return createHash("sha256").update(canonicalJson({
        domain: "image-quote-v1", ownerId, modelId: intent.modelId,
        pricePublicationId: price.pricePublicationId, priceVersion: price.priceVersion,
        inputSnapshot: intent.inputSnapshot, parameterSnapshot: intent.parameterSnapshot,
        spaceId: intent.spaceId ?? null, projectId: intent.projectId ?? null, nodeId: intent.nodeId ?? null,
        billingUnit: "request", creditsPerUnit: price.creditsPerUnit, quotedUnits: price.quotedUnits,
    }), "utf8").digest("hex");
}

export function geminiQuoteFingerprint(ownerId: string, intent: GenerationIntent, priceVersion: number,
    contract: import("@infinite-canvas/database/model-price-publications").GeminiTaskSource): string {
    return createHash("sha256").update(canonicalJson({ domain: "gemini-image-quote-v1", ownerId, priceVersion,
        modelId: intent.modelId, input: intent.inputSnapshot, parameters: intent.parameterSnapshot,
        spaceId: intent.spaceId ?? null, projectId: intent.projectId ?? null, nodeId: intent.nodeId ?? null,
        billing: "delivered_images", publicationId: contract.publicationId, binding: contract.binding, creditsPerImage: contract.creditsPerImage,
    })).digest("hex");
}

/** Keep the publication identity used by the fingerprint on the server. */
export function publicImageQuote(quote: GenerationQuote) {
    if (quote.gemini) return { modelId: quote.modelId, priceVersion: quote.priceVersion, billingUnit: "image" as const,
        creditsPerUnit: quote.gemini.creditsPerImage, quotedUnits: quote.gemini.parameters.budgetCredits, usagePolicy: "delivered_images" as const,
        parameters: quote.gemini.parameters, quoteFingerprint: quote.quoteFingerprint, ...(quote.priceNote === undefined ? {} : { priceNote: quote.priceNote }) };
    return { modelId: quote.modelId, priceVersion: quote.priceVersion,
        billingUnit: quote.billingUnit, creditsPerUnit: quote.creditsPerUnit, quotedUnits: quote.quotedUnits,
        ...(quote.priceNote === undefined ? {} : { priceNote: quote.priceNote }),
        ...(quote.imageSpec ? { imageSpec: { protocol: quote.imageSpec.protocol, parameters: quote.imageSpec.parameters,
            ...(quote.imageSpec.maxImagesPerRequest === undefined ? {} : { maxImagesPerRequest: quote.imageSpec.maxImagesPerRequest }) }, quoteFingerprint: quote.quoteFingerprint } : {}),
    };
}
