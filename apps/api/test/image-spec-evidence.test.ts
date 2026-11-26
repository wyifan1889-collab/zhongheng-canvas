import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import { inspectGenerationPng } from "../src/generation-image-integrity";
import { normalizeGenerationImageSpecification, verifyGenerationImageSpecification } from "../src/generation-image-specification";

const require = createRequire(import.meta.url);
const crc32 = require("pngjs/lib/crc.js").crc32 as (data: Buffer) => number;
const task: GenerationTaskView = { id: "synthetic-task", ownerId: "synthetic-owner", modelId: "synthetic-model",
    priceVersion: 1, quotedUnits: 7, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7, textQuoteSnapshot: null,
    pricePublicationId: "synthetic-publication", inputSnapshot: { prompt: "synthetic exact input" },
    parameterSnapshot: { size: "64x48", quality: "low", n: 1, output_format: "png" },
    idempotencyKey: "synthetic-key", requestId: "synthetic-request", reservationId: null, providerTaskId: null,
    spaceId: null, projectId: null, nodeId: null, executionStatus: "running", deliveryStatus: "pending", billingStatus: "reserved",
    unknownReason: null, finishedAt: null, createdAt: "2026-10-25T00:00:00Z", updatedAt: "2026-10-25T00:00:00Z" };
const source = { protocol: "openai-image-v1" as const, publicationId: "synthetic-publication", parameters: { size: "64x48", quality: "low" as const },
    binding: { providerId: "synthetic-provider", providerModel: "synthetic-upstream", adapter: "openai-compatible" as const,
        endpoint: "https://provider.invalid/v1", capability: "image" as const } };
async function png(progressive = false) {
    return sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } } })
        .png({ progressive }).toBuffer();
}
const payload = (body: Uint8Array) => ({ data: [{ b64_json: Buffer.from(body).toString("base64") }], quality: "low", size: "64x48", output_format: "png" });

test("IMG-03 evidence binds the explicit return format and preserves the old request digest", async () => {
    const body = await png();
    const inlineTask = { ...task, parameterSnapshot: { ...task.parameterSnapshot, response_format: "b64_json" } };
    const inlineSource = { ...source, responseFormat: "b64_json" as const };
    const old = await normalizeGenerationImageSpecification(payload(body), task, source, body.length);
    const inline = await normalizeGenerationImageSpecification(payload(body), inlineTask, inlineSource, body.length);
    if (old.status !== "verified" || inline.status !== "verified") throw new Error("Synthetic inline evidence missing");
    const oldDigest = createHash("sha256").update(JSON.stringify({ model: source.binding.providerModel, n: 1, output_format: "png",
        prompt: task.inputSnapshot.prompt, quality: "low", size: "64x48" })).digest("hex");
    expect(old.resultSnapshot.imageSpecEvidence.requestBodySha256).toBe(oldDigest);
    const inlineDigest = createHash("sha256").update(JSON.stringify({ model: source.binding.providerModel, n: 1, output_format: "png",
        prompt: task.inputSnapshot.prompt, quality: "low", response_format: "b64_json", size: "64x48" })).digest("hex");
    expect(inline.resultSnapshot.imageSpecEvidence.requestBodySha256).toBe(inlineDigest);
    expect(inlineDigest).not.toBe(oldDigest);
    expect((await verifyGenerationImageSpecification(inlineTask, inline.resultSnapshot, inlineSource, body.length)).status).toBe("verified");
    expect((await verifyGenerationImageSpecification(task, inline.resultSnapshot, source, body.length)).status).toBe("unknown");
    expect((await verifyGenerationImageSpecification(inlineTask, old.resultSnapshot, inlineSource, body.length)).status).toBe("unknown");
    expect((await normalizeGenerationImageSpecification(payload(body), task, inlineSource, body.length)).status).toBe("unknown");
    expect((await verifyGenerationImageSpecification(inlineTask, inline.resultSnapshot, source, body.length)).status).toBe("unknown");
});

test("image evidence cannot normalize or recover a different protocol using OpenAI response semantics", async () => {
    const body = await png(), normalized = await normalizeGenerationImageSpecification(payload(body), task, source, body.length);
    if (normalized.status !== "verified") throw new Error("Synthetic image evidence missing");
    for (const protocol of [undefined, null, "gemini", "grok"]) {
        const unsupported = { ...source, protocol } as unknown as typeof source;
        expect((await normalizeGenerationImageSpecification(payload(body), task, unsupported, body.length)).status).toBe("unknown");
        expect((await verifyGenerationImageSpecification(task, normalized.resultSnapshot, unsupported, body.length)).status).toBe("unknown");
    }
});
function chunk(name: string, data: Buffer) {
    const result = Buffer.alloc(data.length + 12);
    result.writeUInt32BE(data.length, 0); result.write(name, 4, "ascii"); data.copy(result, 8);
    result.writeUInt32BE(crc32(result.subarray(4, data.length + 8)) >>> 0, data.length + 8);
    return result;
}

test("image specification integrity decodes ordinary and interlaced PNGs with the same actual dimensions", async () => {
    for (const progressive of [false, true]) {
        const body = await png(progressive);
        expect(await inspectGenerationPng(body, body.length)).toEqual({ status: "verified", width: 64, height: 48 });
    }
});

test("image specification integrity rejects truncation, critical CRC corruption and header-only output", async () => {
    const body = await png(), badCrc = Buffer.from(body);
    badCrc[badCrc.length - 1] ^= 1;
    for (const invalid of [body.subarray(0, body.length - 1), badCrc, body.subarray(0, 33), body.subarray(0, 8)]) {
        expect(await inspectGenerationPng(invalid, body.length)).toEqual({ status: "unknown", reason: "image_spec_png_invalid" });
    }
});

test("image specification integrity checks unknown ancillary type, payload and CRC without dropping valid ancillary data", async () => {
    const body = await png(), changedType = Buffer.from(body);
    changedType[40] ^= 1; // Preserve the exact root DB failure: pHYs becomes an unknown ancillary type.
    expect(await inspectGenerationPng(changedType, body.length)).toEqual({ status: "unknown", reason: "image_spec_png_invalid" });
    const text = chunk("tEXt", Buffer.from("synthetic\0ancillary control"));
    const withText = Buffer.concat([body.subarray(0, 33), text, body.subarray(33)]);
    expect(await inspectGenerationPng(withText, withText.length)).toEqual({ status: "verified", width: 64, height: 48 });
    const changedPayload = Buffer.from(withText), changedCrc = Buffer.from(withText);
    changedPayload[33 + 8] ^= 1;
    changedCrc[33 + text.length - 1] ^= 1;
    for (const invalid of [changedPayload, changedCrc]) {
        expect(await inspectGenerationPng(invalid, withText.length)).toEqual({ status: "unknown", reason: "image_spec_png_invalid" });
    }
});

test("image specification integrity refuses APNG markers even when the default frame is a decodable PNG", async () => {
    const body = await png(), animation = Buffer.alloc(8), frame = Buffer.alloc(26);
    animation.writeUInt32BE(1, 0); frame.writeUInt32BE(64, 4); frame.writeUInt32BE(48, 8);
    frame.writeUInt16BE(1, 20); frame.writeUInt16BE(10, 22);
    const apng = Buffer.concat([body.subarray(0, 33), chunk("acTL", animation), chunk("fcTL", frame), body.subarray(33)]);
    expect((await sharp(apng).raw().toBuffer({ resolveWithObject: true })).info).toMatchObject({ width: 64, height: 48 });
    expect(await inspectGenerationPng(apng, apng.length)).toEqual({ status: "unknown", reason: "image_spec_png_invalid" });
});

test("image specification palette lengths are checked before pngjs allocates palette entries", async () => {
    const body = await png();
    const prototype = require("pngjs/lib/parser.js").prototype;
    const original = prototype._parsePLTE;
    let allocations = 0;
    prototype._parsePLTE = function (this: unknown, data: Buffer) { allocations++; return original.call(this, data); };
    try {
        for (const length of [0, 1, 3 * 257]) {
            const malformed = Buffer.concat([body.subarray(0, 33), chunk("PLTE", Buffer.alloc(length)), body.subarray(33)]);
            expect(await inspectGenerationPng(malformed, malformed.length)).toEqual({ status: "unknown", reason: "image_spec_png_invalid" });
        }
        expect(allocations).toBe(0);
    } finally { prototype._parsePLTE = original; }
});

test("image specification pixel budget rejects an oversized declaration before native decoding", async () => {
    const body = Buffer.from(await png());
    body.writeUInt32BE(4097, 16); body.writeUInt32BE(4097, 20);
    body.writeUInt32BE(crc32(body.subarray(12, 29)) >>> 0, 29);
    expect(await inspectGenerationPng(body, body.length)).toEqual({ status: "unknown", reason: "image_spec_pixel_budget_exceeded" });
});

test("image specification integrity accepts the approved 4096 square RGBA8 boundary", async () => {
    const body = await sharp({ create: { width: 4096, height: 4096, channels: 4, background: "white" } }).png().toBuffer();
    expect(body.length).toBeLessThan(10 * 1024 * 1024);
    expect(await inspectGenerationPng(body, 10 * 1024 * 1024)).toEqual({ status: "verified", width: 4096, height: 4096 });
}, 30_000);

test("image specification evidence persists same-response facts and revalidates after JSON roundtrip", async () => {
    const body = await png(), response = payload(body), selectedSource = structuredClone(source);
    const normalized = await normalizeGenerationImageSpecification(response, task, selectedSource, body.length);
    expect(normalized.status).toBe("verified");
    if (normalized.status !== "verified") throw new Error("Synthetic PNG did not normalize");
    selectedSource.binding.providerModel = "changed-after-normalization";
    expect(normalized.resultSnapshot.imageSpecEvidence.binding.providerModel).toBe("synthetic-upstream");
    const persisted = JSON.parse(JSON.stringify(normalized.resultSnapshot));
    expect(await verifyGenerationImageSpecification(task, persisted, source, body.length)).toMatchObject({ status: "verified" });
    persisted.imageSpecEvidence.response.quality = "high";
    expect(await verifyGenerationImageSpecification(task, persisted, source, body.length)).toEqual({ status: "unknown", reason: "image_spec_evidence_conflicting" });
});

test("batch evidence requires every member and the same complete source binding after persistence", async () => {
    const body = await png(), batchSource = { ...source, parameters: { ...source.parameters, n: 2 } };
    const batchTask = { ...task, parameterSnapshot: { ...task.parameterSnapshot, n: 2 }, quotedUnits: 14 };
    const response = { ...payload(body), data: [payload(body).data[0], payload(body).data[0]] };
    const normalized = await normalizeGenerationImageSpecification(response, batchTask, batchSource, body.length);
    if (normalized.status !== "verified") throw new Error("Synthetic batch did not normalize");
    const persisted = JSON.parse(JSON.stringify(normalized.resultSnapshot));
    expect(await verifyGenerationImageSpecification(batchTask, persisted, batchSource, body.length)).toMatchObject({ status: "verified", assets: expect.any(Array) });
    for (const field of ["providerId", "endpoint"] as const) {
        const changed = structuredClone(persisted);
        changed.images[1].imageSpecEvidence.binding[field] = field === "endpoint" ? "https://other.invalid/v1" : "other-provider";
        expect(await verifyGenerationImageSpecification(batchTask, changed, batchSource, body.length)).toEqual({ status: "unknown", reason: "image_spec_evidence_conflicting" });
    }
    persisted.images.pop();
    expect((await verifyGenerationImageSpecification(batchTask, persisted, batchSource, body.length)).status).toBe("unknown");
});

test("one broken image retains the verified members on both sides for private review", async () => {
    const body = await png(), batchSource = { ...source, parameters: { ...source.parameters, n: 3 } };
    const batchTask = { ...task, parameterSnapshot: { ...task.parameterSnapshot, n: 3 }, quotedUnits: 21 };
    const response = { ...payload(body), data: [payload(body).data[0], { b64_json: "broken", secret: "must-not-persist" }, payload(body).data[0]],
        authorization: "must-not-persist" };
    const normalized = await normalizeGenerationImageSpecification(response, batchTask, batchSource, body.length);
    expect(normalized).toMatchObject({ status: "unknown", reason: "image_spec_png_invalid", resultSnapshot: {
        kind: "image", imageResponseReview: { expectedImages: 3, receivedImages: 3, inspectedImages: 3,
            items: [{ index: 0, status: "verified", resultSnapshot: { image: { base64: body.toString("base64") } } },
                { index: 1, status: "unknown", reason: "image_spec_png_invalid" },
                { index: 2, status: "verified", resultSnapshot: { image: { base64: body.toString("base64") } } }] },
    } });
    expect(normalized.resultSnapshot).not.toHaveProperty("image");
    expect(JSON.stringify(normalized.resultSnapshot)).not.toMatch(/must-not-persist|authorization|secret/);
    expect((await verifyGenerationImageSpecification(batchTask, normalized.resultSnapshot, batchSource, body.length)).status).toBe("unknown");
});

test("wrong image counts preserve only the requested inspection budget and never become deliverable", async () => {
    const body = await png(), batchSource = { ...source, parameters: { ...source.parameters, n: 2 } };
    const batchTask = { ...task, parameterSnapshot: { ...task.parameterSnapshot, n: 2 }, quotedUnits: 14 };
    for (const receivedImages of [1, 3]) {
        const normalized = await normalizeGenerationImageSpecification({ ...payload(body), data: Array.from({ length: receivedImages }, () => payload(body).data[0]) }, batchTask, batchSource, body.length);
        expect(normalized).toMatchObject({ status: "unknown", reason: "image_spec_evidence_conflicting", resultSnapshot: {
            imageResponseReview: { expectedImages: 2, receivedImages, inspectedImages: Math.min(2, receivedImages) },
        } });
        expect(normalized.resultSnapshot).not.toHaveProperty("image");
        expect((await verifyGenerationImageSpecification(batchTask, normalized.resultSnapshot, batchSource, body.length)).status).toBe("unknown");
    }
});

test("batch evidence binds each image to its original response position", async () => {
    const body = await png(), batchSource = { ...source, parameters: { ...source.parameters, n: 3 } };
    const batchTask = { ...task, parameterSnapshot: { ...task.parameterSnapshot, n: 3 }, quotedUnits: 21 };
    const normalized = await normalizeGenerationImageSpecification({ ...payload(body), data: Array.from({ length: 3 }, () => payload(body).data[0]) }, batchTask, batchSource, body.length);
    if (normalized.status !== "verified") throw new Error("Synthetic batch did not normalize");
    for (const mutate of [
        (images: Record<string, unknown>[]) => { [images[1], images[2]] = [images[2], images[1]]; },
        (images: Record<string, unknown>[]) => { images[2] = structuredClone(images[1]); },
    ]) {
        const changed = JSON.parse(JSON.stringify(normalized.resultSnapshot));
        mutate(changed.images);
        expect((await verifyGenerationImageSpecification(batchTask, changed, batchSource, body.length)).status).toBe("unknown");
    }
    expect((await verifyGenerationImageSpecification(batchTask, normalized.resultSnapshot, batchSource, body.length)).status).toBe("verified");
});

test("provider error markers cannot supply successful image specification evidence", async () => {
    const body = await png();
    for (const response of [{ ...payload(body), error: { message: "private upstream error" } }, { ...payload(body), success: false }]) {
        const normalized = await normalizeGenerationImageSpecification(response, task, source, body.length);
        expect(normalized.status).toBe("unknown");
        expect(JSON.stringify(normalized)).not.toContain("private upstream error");
    }
});

test("image specification quality cannot come from bytes, a nested echo or a malformed optional field", async () => {
    const body = await png();
    for (const response of [
        { data: payload(body).data }, { data: [{ ...payload(body).data[0], quality: "low" }] },
        { ...payload(body), quality: "auto" }, { ...payload(body), quality: "high" },
        { ...payload(body), size: 123 }, { ...payload(body), output_format: {} },
    ]) expect((await normalizeGenerationImageSpecification(response, task, source, body.length)).status).toBe("unknown");
    // Actual decoded pixels/format are sufficient when optional metadata is absent.
    expect((await normalizeGenerationImageSpecification({ data: payload(body).data, quality: "low" }, task, source, body.length)).status).toBe("verified");
});

test("image specification evidence rejects another task and missing or forged stored proof", async () => {
    const body = await png(), normalized = await normalizeGenerationImageSpecification(payload(body), task, source, body.length);
    if (normalized.status !== "verified") throw new Error("Synthetic PNG did not normalize");
    expect((await verifyGenerationImageSpecification({ ...task, id: "another-task" }, normalized.resultSnapshot, source, body.length)).status).toBe("unknown");
    for (const imageSpecEvidence of [undefined, { status: "verified" }, { ...normalized.resultSnapshot.imageSpecEvidence, schemaVersion: 1 }]) {
        expect((await verifyGenerationImageSpecification(task, { ...normalized.resultSnapshot, imageSpecEvidence }, source, body.length)).status).toBe("unknown");
    }
});
