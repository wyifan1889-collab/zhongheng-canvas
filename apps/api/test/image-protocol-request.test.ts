import { expect, test } from "bun:test";
import { parseGenerationImageRequest } from "../src/generation-image-request";
import { canonicalImageSpecTaskParameters } from "@infinite-canvas/shared";

test("image task protocol is validated locally and never sent to the supplier", () => {
    const parameters = canonicalImageSpecTaskParameters({ size: "1024x1024", quality: "high", n: 4 });
    expect(parseGenerationImageRequest({ prompt: "Synthetic protocol request" }, parameters)).toEqual({ body: {
        prompt: "Synthetic protocol request", size: "1024x1024", quality: "high", n: 4, output_format: "png",
    } });
    for (const protocol of ["gemini", "grok", null, 1, {}]) {
        expect(parseGenerationImageRequest({ prompt: "Synthetic" }, { ...parameters, protocol })).toEqual({ errorCode: "invalid_generation_parameters" });
    }
    const { protocol: _protocol, ...historical } = parameters;
    expect(parseGenerationImageRequest({ prompt: "Synthetic" }, historical)).toHaveProperty("body");
});
