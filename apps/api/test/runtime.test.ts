import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("the actual API entry point starts with account endpoints disabled", async () => {
    const child = Bun.spawn([process.execPath, "--no-env-file", fileURLToPath(new URL("../src/server.ts", import.meta.url))], {
        env: { ...process.env, SAAS_ACCOUNTS_ENABLED: "false", HOST: "127.0.0.1", PORT: "0" },
        stdout: "pipe", stderr: "pipe",
    });
    try {
        const reader = child.stdout.getReader();
        const { value } = await reader.read();
        reader.releaseLock();
        const output = new TextDecoder().decode(value);
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        expect(url).toBeDefined();
        const site = await (await fetch(`${url}/api/v1/site`)).json();
        expect(site.features.registration).toBe(false);
        expect((await fetch(`${url}/api/v1/canvases`, { method: "POST" })).status).toBe(404);
    } finally {
        child.kill();
        await child.exited;
    }
}, 30_000);
