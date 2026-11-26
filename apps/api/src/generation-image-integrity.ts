import { createRequire } from "node:module";
import sharp from "sharp";
import { MAX_IMAGE_SPEC_PIXELS, MAX_IMAGE_SPEC_RGBA_BYTES } from "./generation-image-limits";

// These pinned pngjs interfaces scan structure/critical CRC without using its
// inflater. Keep this adapter covered when upgrading the dependency.
const require = createRequire(import.meta.url);
type PngMetadata = { width: number; height: number; depth: number; palette: boolean; color: boolean };
type Reader = { read: (...args: unknown[]) => void; process(): void };
const PngParser = require("pngjs/lib/parser.js") as new (options: { checkCRC: boolean }, callbacks: Record<string, unknown>) => {
    start(): void; _chunks: Record<number, (length: number) => unknown>;
    _skipChunk(data: Buffer): void; _parseChunkEnd(data: Buffer): void; _crc: { write(data: Buffer): void };
};
const PngReader = require("pngjs/lib/sync-reader.js") as new (data: Buffer) => Reader;
const chunks = require("pngjs/lib/constants.js") as Record<string, number>;
class PixelBudgetError extends Error {}
export type GenerationPngInspection = { status: "verified"; width: number; height: number } |
    { status: "unknown"; reason: "image_spec_png_invalid" | "image_spec_pixel_budget_exceeded" };

/** Bounded compressed input, critical-container checks, then actual RGBA8 decode. */
export async function inspectGenerationPng(bytes: Uint8Array, maxBytes: number): Promise<GenerationPngInspection> {
    if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || bytes.byteLength === 0 || bytes.byteLength > maxBytes) {
        return { status: "unknown", reason: "image_spec_png_invalid" };
    }
    try {
        const body = Buffer.from(bytes);
        const reader = new PngReader(body);
        let metadata: PngMetadata | null = null;
        let finished = false;
        const noop = () => {};
        const parser = new PngParser({ checkCRC: true }, {
            read: reader.read.bind(reader), error(error: Error) { throw error; },
            metadata(value: PngMetadata) {
                if (!Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width <= 0 || value.height <= 0) throw new Error("invalid PNG dimensions");
                const pixels = BigInt(value.width) * BigInt(value.height);
                if (pixels > BigInt(MAX_IMAGE_SPEC_PIXELS) || pixels * 4n > BigInt(MAX_IMAGE_SPEC_RGBA_BYTES)) throw new PixelBudgetError();
                metadata = { width: value.width, height: value.height, depth: value.depth, palette: value.palette, color: value.color };
            },
            gamma: noop, palette: noop, transColor: noop, simpleTransparency: noop,
            headersFinished: noop, inflateData: noop, finished() { finished = true; },
        });
        // pngjs otherwise skips unknown ancillary payload+CRC. Its dispatcher
        // has already seeded _crc with the type; reuse the normal CRC check
        // and continuation for the remaining data, rather than parsing PNG again.
        parser._skipChunk = function (data: Buffer) {
            if (data.length < 4) throw new Error("incomplete ancillary PNG chunk");
            this._crc.write(data.subarray(0, -4));
            this._parseChunkEnd(data.subarray(-4));
        };
        // Add policy/format guards at the mature parser's dispatch boundary,
        // before its PLTE handler builds an array. No input headers are parsed here.
        for (const name of ["acTL", "fcTL", "fdAT"]) parser._chunks[Buffer.from(name, "ascii").readUInt32BE(0)] = () => { throw new Error("animated PNG is not a single image"); };
        let seenPalette = false, dataStarted = false;
        const palette = parser._chunks[chunks.TYPE_PLTE]!;
        parser._chunks[chunks.TYPE_PLTE] = (length) => {
            const info = metadata;
            if (!info || !info.color || seenPalette || dataStarted || length === 0 || length % 3 !== 0 ||
                length > 3 * (info.palette ? Math.min(256, 2 ** info.depth) : 256)) throw new Error("invalid PNG palette");
            seenPalette = true;
            return palette(length);
        };
        const idat = parser._chunks[chunks.TYPE_IDAT]!;
        parser._chunks[chunks.TYPE_IDAT] = (length) => { dataStarted = true; return idat(length); };
        const iend = parser._chunks[chunks.TYPE_IEND]!;
        parser._chunks[chunks.TYPE_IEND] = (length) => { if (length !== 0) throw new Error("invalid PNG end"); return iend(length); };
        parser.start();
        // pngjs signals finished after queuing but before validating the IEND CRC. The
        // reader must fully complete before that signal can be trusted.
        reader.process();
        if (!metadata || !finished) throw new Error("incomplete PNG");
        const dimensions = metadata as PngMetadata;
        const decoded = await sharp(body, { limitInputPixels: MAX_IMAGE_SPEC_PIXELS, failOn: "warning" })
            .toColourspace("srgb").ensureAlpha().raw({ depth: "uchar" }).toBuffer({ resolveWithObject: true });
        if (decoded.info.width !== dimensions.width || decoded.info.height !== dimensions.height || decoded.info.channels !== 4 ||
            decoded.data.byteLength !== dimensions.width * dimensions.height * 4 || decoded.data.byteLength > MAX_IMAGE_SPEC_RGBA_BYTES) throw new Error("PNG decode mismatch");
        return { status: "verified", width: dimensions.width, height: dimensions.height };
    } catch (error) {
        return { status: "unknown", reason: error instanceof PixelBudgetError ? "image_spec_pixel_budget_exceeded" : "image_spec_png_invalid" };
    }
}
