import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validate } from "./preflight.mjs";

const cwd = fileURLToPath(new URL("./", import.meta.url));
const pin = letter => `sha256:${letter.repeat(64)}`;
const synthetic = {
    CANVAS_WEB_IMAGE: `example.invalid/canvas/web:0.0.0@${pin("a")}`,
    CANVAS_API_IMAGE: `example.invalid/canvas/api:0.0.0@${pin("b")}`,
    CANVAS_DB_IMAGE: `postgres:16-alpine@${pin("c")}`,
    CANVAS_DB_PASSWORD: "0123456789abcdef".repeat(4),
    CANVAS_ACCOUNTS_ENABLED: "false", CANVAS_PORT: "3099",
    SAAS_PAYMENTS_ENABLED: "true", SAAS_GENERATION_IMAGE_ENABLED: "true",
};

function render(overrides = {}, migration = true) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|SystemRoot|WINDIR|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|TEMP|TMP|ProgramFiles(?:\(x86\))?|ProgramW6432|ProgramData)$/i.test(key)));
    const args = ["compose", "--env-file", ".env.example", "-f", "compose.yaml", ...(migration ? ["--profile", "migration"] : []), "config", "--format", "json"];
    const result = spawnSync("docker", args, { cwd, env: { ...env, ...synthetic, ...overrides }, encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return JSON.parse(result.stdout);
}

test("Compose validates with explicit images, keeps data internal, and ignores ambient paid flags", () => {
    const config = render();
    validate(config);
    assert.deepEqual(config.services.migrate.entrypoint, ["bun", "run", "--cwd", "apps/api", "db:migrate"]);
    assert.equal(config.services.api.depends_on.db.condition, "service_healthy");
    assert.equal(config.services.api.environment.SAAS_PAYMENTS_ENABLED, "false");
    assert.equal(config.services.api.environment.SAAS_GENERATION_IMAGE_ENABLED, "false");
    assert.deepEqual(Object.keys(render({}, false).services).sort(), ["api", "db", "web"]);
});

test("mutable app tag, wrong PostgreSQL major and malformed database password are rejected", () => {
    assert.throws(() => validate(render({ CANVAS_WEB_IMAGE: "example.invalid/canvas/web:latest" })), /SHA-256/);
    assert.throws(() => validate(render({ CANVAS_DB_IMAGE: `postgres:160-alpine@${pin("c")}` })), /PostgreSQL 16/);
    assert.throws(() => validate(render({ CANVAS_DB_PASSWORD: "not-a-hex-password" })), /hex value/);
});

test("account opt-in stops when its dependencies are not set", () => {
    assert.throws(() => validate(render({ CANVAS_ACCOUNTS_ENABLED: "true" })), /Accounts require/);
});

test("mismatched migrations, wrong database, missing data volume and broad binding are rejected", () => {
    const valid = render();
    for (const [update, message] of [
        [c => { c.services.migrate.image = c.services.web.image; }, /same image/],
        [c => { c.services.migrate.environment.SAAS_DATABASE_URL = "postgresql://other/other"; }, /target this instance/],
        [c => { c.services.db.volumes = []; }, /named data volume/],
        [c => { c.services.web.ports[0].host_ip = "0.0.0.0"; }, /Only Web/],
    ]) {
        const sample = structuredClone(valid);
        update(sample);
        assert.throws(() => validate(sample), message);
    }
});
