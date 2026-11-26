import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("production store actions preserve both versions and reject stale WebDAV replacement (isolated fake IndexedDB)", () => {
    const result = spawnSync(process.execPath, ["--no-env-file", fileURLToPath(new URL("./canvas-store.fixture.ts", import.meta.url))], { encoding: "utf8" });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
    expect(result.stdout).toContain("integration passed (9 assertions)");
});

for (const mode of ["success", "abort", "conflict"]) {
    test(`mount recovery waits for real store persistence: ${mode} (isolated fake IndexedDB)`, () => {
        const result = spawnSync(process.execPath, ["--no-env-file", fileURLToPath(new URL("./canvas-mount-recovery.fixture.ts", import.meta.url)), mode], { encoding: "utf8" });
        expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
        expect(result.stdout).toContain(`Mount recovery ${mode} passed`);
    });
}
