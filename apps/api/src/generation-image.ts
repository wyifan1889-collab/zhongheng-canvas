import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { inspectGenerationPng } from "./generation-image-integrity";

export function generationImageMediaId(taskId: string, index: number): string {
    if (index === 0) return taskId;
    const bytes = createHash("sha1").update(Buffer.from(taskId.replaceAll("-", ""), "hex")).update(`image:${index}`).digest().subarray(0, 16);
    bytes[6] = (bytes[6]! & 15) | 80;
    bytes[8] = (bytes[8]! & 63) | 128;
    const value = bytes.toString("hex");
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

/** Private, server-normalized result; the public task query omits image bytes. */
export type GenerationImageSnapshot = {
    kind: "image";
    image: { contentType: "image/png"; base64: string };
};

export type GenerationImageAsset = {
    kind: "image";
    contentType: "image/png";
    body: Uint8Array;
};

const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A contradictory success/error envelope is not proof of completed generation. */
export function generationImageResponseData(payload: unknown): unknown[] | null {
    const value = record(payload);
    return value && value.error == null && value.success !== false && Array.isArray(value.data) ? value.data : null;
}

export function decodeGenerationPng(value: unknown, maxBytes: number): Uint8Array | null {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || typeof value !== "string" || value.length === 0) return null;
    // Reject over-limit encodings before allocating their decoded buffer.
    if (value.length > 4 * Math.ceil(maxBytes / 3) || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
    const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
    if (value.length / 4 * 3 - padding > maxBytes) return null;
    const bytes = Buffer.from(value, "base64");
    if (bytes.length < pngSignature.length || bytes.length > maxBytes || bytes.toString("base64") !== value) return null;
    // This identifies the PNG signature only; it is not a full image decode.
    if (!pngSignature.every((byte, index) => bytes[index] === byte)) return null;
    return bytes;
}

/** Accept exactly one Base64 PNG; discard all other provider fields. */
export function normalizeGenerationImage(payload: unknown, maxBytes: number): GenerationImageSnapshot | null {
    const data = generationImageResponseData(payload);
    if (!data || data.length !== 1) return null;
    const item = record(data[0]);
    if (!item || item.error != null || item.success === false) return null;
    const base64 = item.b64_json;
    if (!decodeGenerationPng(base64, maxBytes)) return null;
    return { kind: "image", image: { contentType: "image/png", base64: base64 as string } };
}

/** Revalidate the private persisted snapshot before media delivery or replay. */
export function resolveGenerationImage(snapshot: unknown, maxBytes: number): GenerationImageAsset | null {
    const value = record(snapshot);
    const image = record(value?.image);
    if (value?.kind !== "image" || image?.contentType !== "image/png") return null;
    const body = decodeGenerationPng(image.base64, maxBytes);
    return body ? { kind: "image", contentType: "image/png", body } : null;
}

/** A legacy snapshot also needs a full decode before delivery or recovery. */
export async function resolveVerifiedGenerationImage(snapshot: unknown, maxBytes: number): Promise<GenerationImageAsset | null> {
    const asset = resolveGenerationImage(snapshot, maxBytes);
    return asset && (await inspectGenerationPng(asset.body, maxBytes)).status === "verified" ? asset : null;
}
