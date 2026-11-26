import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const mode of ["selection", "foreign", "release", "abort", "dispose"]) {
    test(`native mount persistence gate: ${mode} (isolated subprocess)`, () => {
        // Test-only deadline; no HTTP listener, browser or application timeout is introduced.
        const result = spawnSync(process.execPath, ["--no-env-file", fileURLToPath(new URL("./mount-persistence-gate.fixture.ts", import.meta.url)), mode], {
            encoding: "utf8", timeout: 10000,
        });
        expect({ status: result.status, error: result.error?.message, stderr: result.stderr }).toEqual({ status: 0, error: undefined, stderr: "" });
        expect(result.stdout).toContain(`Native mount persistence gate ${mode} passed`);
    });
}
