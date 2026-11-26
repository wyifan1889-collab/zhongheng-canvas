/** Explicit platform video contract. A provider's transport adapter grants no video capability. */
export const VIDEO_PROTOCOL = "yunfei-grok-video-v1" as const;
export const VIDEO_USAGE_POLICY = "delivered_video" as const;
export type VideoParameters = {
    mode: "text" | "first_frame";
    resolution: "480p" | "720p" | "1080p";
    durationSeconds: number;
    generateAudio: boolean;
    aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4" | "3:2" | "2:3";
};
export type VideoPricePolicy = { schemaVersion: 1; protocol: typeof VIDEO_PROTOCOL; usagePolicy: typeof VIDEO_USAGE_POLICY };
export type VideoBinding = { protocol: typeof VIDEO_PROTOCOL; providerId: string; providerModel: string; endpoint: string };
export type VideoReferenceSnapshot = { mediaId: string; etag: string; contentType: string; sizeBytes: number };
export type VideoQuoteSnapshot = VideoPricePolicy & {
    publicationId: string; priceVersion: number;
    selectedBand: { parameters: VideoParameters; creditsPerVideo: number };
    quotedVideoUnits: 1; maxVideoUnits: 1; reservedCredits: number;
    referenceSnapshot?: VideoReferenceSnapshot;
};
export type VideoPhase = "ready" | "rejected" | "create_started" | "accepted" | "polling" | "completed" | "failed" | "unknown";
export type VideoGenerationModel = {
    id: string; displayName: string; capability: "video"; group: { id: string; name: string; order: number } | null;
    videoPricing: { priceVersion: number; billingUnit: "video_specs"; creditsPerUnit: null;
        protocol: typeof VIDEO_PROTOCOL; usagePolicy: typeof VIDEO_USAGE_POLICY;
        videoSpecs: { parameters: VideoParameters; creditsPerVideo: number }[]; priceNote?: string };
};
export type PublicVideoQuote = {
    modelId: string; priceVersion: number; parameters: VideoParameters; quotedVideoUnits: 1; maxVideoUnits: 1;
    reservedCredits: number; usagePolicy: typeof VIDEO_USAGE_POLICY; quoteFingerprint: string; priceNote?: string;
};
export type PublicVideoTask = { parameters: VideoParameters; usagePolicy: typeof VIDEO_USAGE_POLICY;
    quotedVideoUnits: 1; reservedCredits: number; phase: VideoPhase };

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (row: Record<string, unknown>, keys: string[]) => Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key));
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Protocol bounds only. Availability additionally requires an exact administrator-published band. */
export function parseVideoParameters(value: unknown): VideoParameters | null {
    if (!record(value) || typeof value.mode !== "string" || !["text", "first_frame"].includes(value.mode) ||
        !exact(value, ["mode", "resolution", "durationSeconds", "generateAudio", ...(value.mode === "text" ? ["aspectRatio"] : [])]) ||
        typeof value.resolution !== "string" || !["480p", "720p", "1080p"].includes(value.resolution) || !positive(value.durationSeconds) || value.durationSeconds > 15 ||
        typeof value.generateAudio !== "boolean" || value.mode === "text" && (typeof value.aspectRatio !== "string" ||
            !["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"].includes(value.aspectRatio))) return null;
    return { mode: value.mode as VideoParameters["mode"], resolution: value.resolution as VideoParameters["resolution"],
        durationSeconds: value.durationSeconds, generateAudio: value.generateAudio,
        ...(value.mode === "text" ? { aspectRatio: value.aspectRatio as VideoParameters["aspectRatio"] } : {}) };
}

export function parseVideoPricePolicy(value: unknown): VideoPricePolicy | null {
    return record(value) && exact(value, ["schemaVersion", "protocol", "usagePolicy"]) && value.schemaVersion === 1 &&
        value.protocol === VIDEO_PROTOCOL && value.usagePolicy === VIDEO_USAGE_POLICY
        ? { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY } : null;
}

/** Immutable historical product usage, never provider-billed seconds. */
export function parseVideoQuoteSnapshot(value: unknown): VideoQuoteSnapshot | null {
    if (!record(value) || !exact(value, ["schemaVersion", "protocol", "usagePolicy", "publicationId", "priceVersion", "selectedBand",
        "quotedVideoUnits", "maxVideoUnits", "reservedCredits", ...(Object.hasOwn(value, "referenceSnapshot") ? ["referenceSnapshot"] : [])]) ||
        value.schemaVersion !== 1 || value.protocol !== VIDEO_PROTOCOL || value.usagePolicy !== VIDEO_USAGE_POLICY || !uuid(value.publicationId) ||
        !positive(value.priceVersion) || !positive(value.reservedCredits) || value.quotedVideoUnits !== 1 || value.maxVideoUnits !== 1 ||
        !record(value.selectedBand) || !exact(value.selectedBand, ["parameters", "creditsPerVideo"]) ||
        !positive(value.selectedBand.creditsPerVideo) || value.selectedBand.creditsPerVideo !== value.reservedCredits) return null;
    const parameters = parseVideoParameters(value.selectedBand.parameters);
    if (!parameters || (parameters.mode === "first_frame") !== Object.hasOwn(value, "referenceSnapshot")) return null;
    let referenceSnapshot: VideoReferenceSnapshot | undefined;
    if (Object.hasOwn(value, "referenceSnapshot")) {
        const ref = value.referenceSnapshot;
        if (!record(ref) || !exact(ref, ["mediaId", "etag", "contentType", "sizeBytes"]) || !uuid(ref.mediaId) ||
            typeof ref.etag !== "string" || !/^[0-9a-f]{64}$/.test(ref.etag) || typeof ref.contentType !== "string" ||
            !/^image\/[a-z0-9.+-]+$/.test(ref.contentType) || !positive(ref.sizeBytes)) return null;
        referenceSnapshot = { mediaId: ref.mediaId, etag: ref.etag, contentType: ref.contentType, sizeBytes: ref.sizeBytes };
    }
    return { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY, publicationId: value.publicationId,
        priceVersion: value.priceVersion, selectedBand: { parameters, creditsPerVideo: value.selectedBand.creditsPerVideo },
        quotedVideoUnits: 1, maxVideoUnits: 1, reservedCredits: value.reservedCredits, ...(referenceSnapshot ? { referenceSnapshot } : {}) };
}

export function sameVideoParameters(left: VideoParameters, right: VideoParameters): boolean {
    return left.mode === right.mode && left.resolution === right.resolution && left.durationSeconds === right.durationSeconds &&
        left.generateAudio === right.generateAudio && left.aspectRatio === right.aspectRatio;
}
