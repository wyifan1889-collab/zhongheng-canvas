import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const mode of ["image-read", "media-read", "image-anonymous-aba", "media-anonymous-aba", "image-write", "media-write",
    "image-upload-cleanup", "media-upload-cleanup", "preview-read", "preview-queue", "preview-write", "image-cleanup", "media-cleanup", "same-account"]) {
    test(`local media account lifetime: ${mode} (isolated subprocess)`, () => {
        const result = spawnSync(process.execPath, ["--no-env-file", fileURLToPath(new URL("./local-media-scope.fixture.ts", import.meta.url)), mode], {
            encoding: "utf8", timeout: 10000,
        });
        expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: "" });
        expect(result.stdout).toContain(`Local media scope ${mode} passed`);
    });
}
