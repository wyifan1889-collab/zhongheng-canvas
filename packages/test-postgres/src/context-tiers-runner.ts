import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";

// This entry creates its own cluster. It never accepts a database URL or an existing cluster.
const forbidden = ["DATABASE_URL", "SAAS_TEST_DATABASE_URL", "SAAS_CONTEXT_PG_URL", "SAAS_CONTEXT_PG_RUN", "SAAS_CONTEXT_SOURCE_ROOT"];
if (forbidden.some(name => process.env[name])) throw new Error("Context-tier runner refuses pre-existing database/source environment");
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("This isolated native PostgreSQL harness is verified only on Windows x64");
const args = process.argv.slice(2), options = new Map<string, string>();
for (let i = 0; i < args.length; i += 2) {
    if (!["--source-root", "--label", "--api-test", "--native-root"].includes(args[i]) || !args[i + 1] || options.has(args[i])) throw new Error("Expected --source-root <absolute repo> --label main|narrow [--api-test <relative test>] [--native-root <absolute PostgreSQL installation>]");
    options.set(args[i], args[i + 1]);
}
const requestedRoot = options.get("--source-root"), label = options.get("--label");
if (!requestedRoot || !isAbsolute(requestedRoot) || (label !== "main" && label !== "narrow")) throw new Error("Explicit local source root and main|narrow label required");
const sourceRoot = await realpath(requestedRoot);
const apiTest = options.get("--api-test");
if (apiTest && (isAbsolute(apiTest) || !/^apps[\\/]api[\\/]test[\\/][\w.-]+\.test\.ts$/.test(apiTest))) throw new Error("API test must be a relative apps/api/test file");
const ownRoot = fileURLToPath(new URL("../../../", import.meta.url));
const nativeTest = resolve(ownRoot, "packages/test-postgres/test/context-tiers.test.ts");
const requestedNative = options.get("--native-root");
if (requestedNative && !isAbsolute(requestedNative)) throw new Error("Native root must be an absolute local PostgreSQL installation directory");
const nativeRoot = requestedNative ? await realpath(requestedNative) : null;
const { initdb, pg_ctl } = nativeRoot
    ? { initdb: await realpath(join(nativeRoot, "bin", "initdb.exe")), pg_ctl: await realpath(join(nativeRoot, "bin", "pg_ctl.exe")) }
    : await import("@embedded-postgres/windows-x64");
const runs = join(tmpdir(), "infinite-canvas-context-tiers");
await mkdir(runs, { recursive: true });
const runDir = await mkdtemp(join(runs, `run-${label}-`)), dataDir = join(runDir, "data"), logFile = join(runDir, "postgres.log");
let init = initdb, control = pg_ctl;
if (/[^\x00-\x7f]/.test(initdb + pg_ctl)) {
    const native = join(runDir, "native");
    await cp(dirname(dirname(initdb)), native, { recursive: true });
    init = join(native, "bin", basename(initdb)); control = join(native, "bin", basename(pg_ctl));
}
const probe = createServer();
const port = await new Promise<number>((done, fail) => {
    probe.once("error", fail); probe.listen(0, "127.0.0.1", () => {
        const address = probe.address();
        if (!address || typeof address === "string") return fail(new Error("No loopback port"));
        probe.close(error => error ? fail(error) : done(address.port));
    });
});
const adminPassword = crypto.randomUUID() + crypto.randomUUID(), appPassword = crypto.randomUUID() + crypto.randomUUID();
let startAttempted = false;
async function command(executable: string, commandArgs: string[], env = process.env, cwd = runDir) {
    await new Promise<void>((done, fail) => {
        const child = spawn(executable, commandArgs, { cwd, env, windowsHide: true, stdio: ["ignore", "inherit", "inherit"], shell: false });
        child.once("error", fail); child.once("exit", code => code === 0 ? done() : fail(new Error(`Isolated subprocess exited ${code}`)));
    });
}
console.log(JSON.stringify({ kind: "context-tiers-native-start", label, sourceRoot, runDir, nativeRoot: nativeRoot ?? "embedded" }));
try {
    const passwordFile = join(runDir, ".init-password");
    await writeFile(passwordFile, adminPassword + "\n", { flag: "wx", mode: 0o600 });
    try {
        await command(init, ["-D", dataDir, "--username=context_test_admin", "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C", `--pwfile=${passwordFile}`, "--no-instructions"]);
    } finally { await unlink(passwordFile); }
    startAttempted = true;
    await command(control, ["start", "-D", dataDir, "-l", logFile, "-w", "-t", "30", "-o", `-h 127.0.0.1 -p ${port}`]);
    const admin = new Client({ host: "127.0.0.1", port, user: "context_test_admin", password: adminPassword, database: "postgres" });
    try {
        await admin.connect();
        await admin.query(`CREATE ROLE context_test_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${admin.escapeLiteral(appPassword)}`);
        await admin.query("CREATE DATABASE context_tiers_native OWNER context_test_app");
        if (apiTest) await admin.query("CREATE DATABASE context_tiers_api OWNER context_test_app");
        console.log(JSON.stringify({ kind: "context-tiers-postgres-version", label, version: (await admin.query("SELECT version() AS version")).rows[0].version }));
    } finally { await admin.end(); }
    const childEnv = { ...process.env, SAAS_CONTEXT_PG_RUN: "owned", SAAS_CONTEXT_SOURCE_ROOT: sourceRoot, SAAS_CONTEXT_SCHEMA_LABEL: label };
    const url = (name: string) => `postgresql://context_test_app:${appPassword}@127.0.0.1:${port}/${name}`;
    await command(process.execPath, ["--no-env-file", "--no-install", "test", nativeTest, "--timeout", "30000"], { ...childEnv, SAAS_CONTEXT_PG_URL: url("context_tiers_native") }, sourceRoot);
    if (apiTest) await command(process.execPath, ["--no-env-file", "--no-install", "test", "./" + apiTest.replaceAll("\\", "/"), "--timeout", "30000"],
        { ...childEnv, SAAS_CONTEXT_PG_URL: url("context_tiers_api") }, sourceRoot);
    console.log(JSON.stringify({ kind: "context-tiers-native-result", label, status: "passed", apiTest: apiTest ?? null }));
} finally {
    let running = startAttempted;
    if (running) {
        try { await promisify(execFile)(control, ["status", "-D", dataDir], { windowsHide: true }); }
        catch (error) { if ((error as { code?: number }).code === 3) running = false; else throw error; }
    }
    if (running) await command(control, ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "30"]);
    console.log(JSON.stringify({ kind: "context-tiers-native-cleanup", label, clusterStopped: true, retainedRunDir: runDir }));
}
