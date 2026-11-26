/** Browser-safe contracts only: no database, provider credentials or auth tokens. */
export type { InspirationItem, InspirationCatalog, InspirationWrite } from "./inspiration";
export type { AdminGenerationTaskDetail } from "./admin-generation";
export type { CnyModelBinding, CnyDraftModel, AdminCnyPriceDraft, CnyPriceDraftWrite } from "./model-cny-pricing";
export { normalizeCnyAmount } from "./model-cny-pricing";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type PublicSiteConfig = {
    schemaVersion: 1;
    brand: { name: string; tagline: string; logoPath: string | null };
    theme: {
        light: { accent: string; background: string; surface: string; text: string };
        dark: { accent: string; background: string; surface: string; text: string };
    };
    features: {
        registration: boolean;
        cloudCanvas: boolean;
        cloudMedia: boolean;
        recharge: boolean;
        generation: { text: boolean; image: boolean; video: boolean; audio: boolean };
    };
    authentication?: {
        method: "email-password";
        captcha: { provider: "turnstile"; siteKey: string; action: "account" };
    };
};

/**
 * Safe projection of the current session. `email` is the account identifier
 * shown to the signed-in user; no session token, credential or internal user
 * fields are included. It stays optional for local preview principals.
 */
export type SessionPrincipal = { id: string; name: string; email?: string; role: "user" | "admin" };
export type ApiFailure = { error: { code: string; message: string }; requestId: string; currentRevision?: number };

export type CanvasSaveState = "local-only" | "dirty" | "saving" | "synced" | "conflict" | "error";

/** A draft document is not an asset upload, execution request or billing record. */
export type CanvasDraft = {
    id: string;
    title: string;
    revision: number;
    documentVersion: 1;
    document: JsonObject;
    createdAt: string;
    updatedAt: string;
};

export * from "./model-pricing-drafts";
export * from "./node-model-groups";
export * from "./model-mapping-drafts";
export * from "./model-mapping-publications";
export * from "./model-price-publications";
export * from "./text-usage";
export * from "./text-billing";
export * from "./text-usage-review";
export * from "./task-price-snapshot";
export * from "./credit-amounts";
export * from "./official-price-reference";
export * from "./model-price-derivation";
export * from "./generation-video";
export * from "./payment-platform";

export type SaveDraftResult =
    | { status: "saved"; draft: CanvasDraft }
    | { status: "conflict"; currentRevision: number }
    | { status: "not_found" };
