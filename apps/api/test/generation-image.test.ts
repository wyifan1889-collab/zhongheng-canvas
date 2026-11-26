import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { normalizeGenerationImage, resolveGenerationImage } from "../src/generation-image";

// Existing synthetic 64x48 PNG fixture, copied as bytes so API tests need no web files.
const png = "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAr0lEQVR4nNXOsU0DARQE0bmRC3DmiAhzRViiAERCD9RBN66D7DpwcpYbsGjCuUmQfCc0L/xa7f7hMo6s6fC1X7Vf4iRO4iRO4iRO4iRO4iRO4iRO4iRO4iRO4jbL1j3P893l+iuzO74vuChxEidxEidxm7fXacG68x8yp+33gosSJ3ESJ3ESN7x8/qw6MH08rdovcRIncRIncRIncRIncRIncRIncRIncRIncRLnfz/wqBtAQwyWJp82cQAAAABJRU5ErkJggg==";
const bytes = Buffer.from(png, "base64");
const response = (b64_json: unknown) => ({ data: [{ b64_json }] });

describe("private single PNG generation snapshot", () => {
    test("normalizes a real PNG and reopens its serialized snapshot without upstream fields", () => {
        const snapshot = normalizeGenerationImage({
            id: "upstream-private-id", apiKey: "must-not-persist", usage: { total_tokens: 999 },
            data: [{ b64_json: png, url: "https://private.example.test/image", revised_prompt: "private rewrite" }],
        }, bytes.length);
        expect(snapshot).toEqual({ kind: "image", image: { contentType: "image/png", base64: png } });
        const asset = resolveGenerationImage(JSON.parse(JSON.stringify(snapshot)), bytes.length);
        expect(asset).toMatchObject({ kind: "image", contentType: "image/png" });
        expect(asset?.body).toEqual(bytes);
        expect(JSON.stringify(snapshot)).not.toMatch(/upstream-private-id|must-not-persist|private\.example|revised_prompt|total_tokens/);
    });

    test("rejects missing, URL-only, multiple or non-object image responses", () => {
        for (const payload of [null, [], {}, { data: [] }, { data: [png] }, { data: [{ url: "https://example.test/image" }] }, { data: [{ b64_json: png }, { b64_json: png }] }]) {
            expect(normalizeGenerationImage(payload, bytes.length)).toBeNull();
        }
    });

    test("rejects contradictory error envelopes even when they contain decodable image bytes", () => {
        for (const payload of [
            { ...response(png), error: { message: "private upstream error" } },
            { ...response(png), success: false },
            { data: [{ b64_json: png, error: "private upstream error" }] },
            { data: [{ b64_json: png, success: false }] },
        ]) expect(normalizeGenerationImage(payload, bytes.length)).toBeNull();
        expect(normalizeGenerationImage({ ...response(png), error: null, success: true }, bytes.length)).not.toBeNull();
    });

    test("rejects non-canonical Base64, incorrect signatures and byte overflow before delivery", () => {
        const nonCanonicalPadBits = png.slice(0, -3) + "h==";
        expect(Buffer.from(nonCanonicalPadBits, "base64")).toEqual(bytes);
        const wrongSignature = Buffer.from(bytes);
        wrongSignature[0] = 0;
        for (const invalid of ["", 123, " " + png, png + "\n", png.slice(0, -2), png.replace("+", "-"), nonCanonicalPadBits, "data:image/png;base64," + png, wrongSignature.toString("base64")]) {
            expect(normalizeGenerationImage(response(invalid), bytes.length)).toBeNull();
            expect(resolveGenerationImage({ kind: "image", image: { contentType: "image/png", base64: invalid } }, bytes.length)).toBeNull();
        }
        expect(normalizeGenerationImage(response(png), bytes.length - 1)).toBeNull();
        expect(resolveGenerationImage({ kind: "image", image: { contentType: "image/png", base64: png } }, bytes.length - 1)).toBeNull();
    });

    test("requires an image PNG snapshot and a valid configured storage limit", () => {
        for (const snapshot of [null, {}, { kind: "text", image: { contentType: "image/png", base64: png } }, { kind: "image", image: { contentType: "image/jpeg", base64: png } }]) {
            expect(resolveGenerationImage(snapshot, bytes.length)).toBeNull();
        }
        for (const limit of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(normalizeGenerationImage(response(png), limit)).toBeNull();
            expect(resolveGenerationImage({ kind: "image", image: { contentType: "image/png", base64: png } }, limit)).toBeNull();
        }
    });
});
