/**
 * A cloud media reference is an account-scoped UUID, never an object key or a
 * provider URL.  The document preflight may record it, but cloud canvas save
 * must still verify ownership with the server before accepting the document.
 */
const cloudMediaIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isCloudMediaId(value: unknown): value is string {
    return typeof value === "string" && cloudMediaIdPattern.test(value);
}

export function normalizeCloudMediaId(value: unknown): string | null {
    return isCloudMediaId(value) ? value.toLowerCase() : null;
}
