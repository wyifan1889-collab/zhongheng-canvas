import { execFile, spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const code = (error: unknown) => {
    const value = (error as { code?: unknown })?.code;
    return typeof value === "string" && /^[A-Z0-9_]+$/.test(value) ? value : "unclassified";
};
const absent = async (path: string) => {
    try { await access(path); return false; }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") return true; throw error; }
};
const closedPort = (port: number) => new Promise<boolean>((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (closed: boolean) => { if (settled) return; settled = true; socket.destroy(); done(closed); };
    socket.once("connect", () => finish(false));
    socket.once("error", (error) => finish((error as { code?: string }).code === "ECONNREFUSED"));
    socket.setTimeout(1_000, () => finish(false));
});

/** Only this opt-in creates a new cluster; it never accepts an existing database address. */
export async function runCanvasSharing() {
    const forbidden = ["DATABASE_URL", "SAAS_DATABASE_URL", "SAAS_TEST_DATABASE_URL", "SAAS_POSTGRES_RUN_ROOT",
        "SAAS_POSTGRES_TEST_SUITE", "SAAS_TEST_DATA_DIRECTORY", "SAAS_TEST_RUN_ID", "SAAS_TEST_CLUSTER_MARKER", "SAAS_TEST_CLUSTER_PORT",
        "CANVAS_ACCEPTANCE_SOURCE_ROOT", "CANVAS_ACCEPTANCE_DEPENDENCIES", "NODE_PATH", "NODE_OPTIONS", "BUN_OPTIONS"]
        .filter((name) => process.env[name]);
    if (forbidden.length) throw new Error(`T10 runner rejects existing database or source overrides: ${forbidden.join(", ")}`);
    if (process.platform !== "win32" || process.arch !== "x64") throw new Error("T10 portable runner requires Windows x64");
    const temporaryRoot = await realpath(tmpdir());
    if (/[^\x00-\x7f]/.test(temporaryRoot)) throw new Error("T10 runner requires an ASCII temporary root");
    const { initdb, pg_ctl } = await import("@embedded-postgres/windows-x64");
    await Promise.all([access(initdb), access(pg_ctl)]);
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const runs = join(temporaryRoot, "infinite-canvas-postgres-tests");
    await mkdir(runs, { recursive: true });
    const runDir = await mkdtemp(join(runs, "t10-sharing-"));
    const dataDir = join(runDir, "data"), passwordFile = join(runDir, ".init-password");
    const runId = crypto.randomUUID(), logFile = join(runDir, "postgres.log"), markerPath = join(runDir, "marker.json");
    let initdbExecutable = initdb, pgCtlExecutable = pg_ctl;
    const probe = createServer();
    const port = await new Promise<number>((done, reject) => {
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            if (!address || typeof address === "string") return reject(new Error("T10 free port unavailable"));
            probe.close((error) => error ? reject(error) : done(address.port));
        });
    });
    const write = (name: string, value: unknown) => writeFile(join(runDir, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
    await write("marker.json", { kind: "canvas-sharing-native-cluster", runId, runDir, dataDir, host: "127.0.0.1", port, createdAt: new Date().toISOString() });
    console.log(JSON.stringify({ kind: "canvas-sharing-native-start", runId, runDir, dataDir, port }));
    const commands: Array<{ executable: string; args: string[]; pid: number | null; exitCode: number | null; timedOut: boolean }> = [];
    async function command(executable: string, args: string[], timeoutMs = 45_000) {
        const receipt = { executable, args, pid: null as number | null, exitCode: null as number | null, timedOut: false };
        commands.push(receipt);
        await new Promise<void>((done, reject) => {
            const child = spawn(executable, args, { cwd: runDir, env: process.env, windowsHide: true, shell: false, stdio: ["ignore", "inherit", "inherit"] });
            receipt.pid = child.pid ?? null;
            let settled = false, grace: ReturnType<typeof setTimeout> | undefined;
            const finish = (error?: Error) => {
                if (settled) return; settled = true; clearTimeout(timeout); if (grace) clearTimeout(grace);
                error ? reject(error) : done();
            };
            const timeout = setTimeout(() => {
                receipt.timedOut = true;
                try { child.kill("SIGKILL"); } catch { /* The final receipt remains a failure and cleanup still runs. */ }
                grace = setTimeout(() => finish(new Error("T10 native command exit not confirmed")), 5_000);
            }, timeoutMs);
            child.once("error", (error) => finish(new Error(`T10 native command spawn failed: ${code(error)}`)));
            // A started server may inherit streams. Observe exit rather than waiting for close.
            child.once("exit", (exitCode) => { receipt.exitCode = exitCode;
                finish(exitCode === 0 && !receipt.timedOut ? undefined : new Error("T10 native command failed")); });
        });
    }
    const test = { args: ["--no-env-file", "--no-install", "test", "apps/api/src/canvas-sharing-race.test.ts"],
        pid: null as number | null, exitCode: null as number | null, signal: null as string | null,
        deadlineMs: 180_000, timedOut: false, killRequested: false, exitObserved: false, closeObserved: false,
        startedAt: null as string | null, completedAt: null as string | null, spawnError: null as string | null };
    async function testCommand(env: NodeJS.ProcessEnv) {
        test.startedAt = new Date().toISOString();
        await new Promise<void>((done) => {
            const child = spawn(process.execPath, test.args, { cwd: root, env, windowsHide: true, shell: false, stdio: ["ignore", "inherit", "inherit"] });
            test.pid = child.pid ?? null;
            let settled = false;
            const finish = () => { if (settled) return; settled = true; clearTimeout(terminate); clearTimeout(deadline); done(); };
            const terminate = setTimeout(() => {
                test.timedOut = true;
                try { test.killRequested = child.kill("SIGKILL"); } catch { /* The failed termination is visible as exitObserved=false. */ }
            }, test.deadlineMs - 5_000);
            const deadline = setTimeout(() => { test.timedOut = true; finish(); }, test.deadlineMs);
            child.once("error", (error) => { test.spawnError = code(error); if (!child.pid) finish(); });
            child.once("exit", (exitCode, signal) => { test.exitObserved = true; test.exitCode = exitCode; test.signal = signal; });
            child.once("close", (exitCode, signal) => { test.closeObserved = true; test.exitCode = exitCode; test.signal = signal; finish(); });
        });
        test.completedAt = new Date().toISOString();
        if (test.timedOut || test.spawnError || !test.exitObserved || !test.closeObserved || test.exitCode !== 0) throw new Error("T10 native test child failed");
    }
    let phase = "preparation", startupAttempted = false, failure: { phase: string; code: string } | null = null;
    const cleanup = { statusExitCode: null as number | null, pidFileAbsent: false, portClosed: false, initPasswordAbsent: false,
        stopExitCode: null as number | null, errorCode: null as string | null, completedAt: null as string | null };
    try {
        if (/[^\x00-\x7f]/.test(initdb) || /[^\x00-\x7f]/.test(pg_ctl)) {
            const copiedNative = join(runDir, "native");
            await cp(dirname(dirname(initdb)), copiedNative, { recursive: true, errorOnExist: true, force: false });
            initdbExecutable = join(copiedNative, "bin", basename(initdb));
            pgCtlExecutable = join(copiedNative, "bin", basename(pg_ctl));
        }
        const adminPassword = crypto.randomUUID() + crypto.randomUUID(), appPassword = crypto.randomUUID() + crypto.randomUUID();
        phase = "initialization";
        try {
            await writeFile(passwordFile, adminPassword + "\n", { flag: "wx", mode: 0o600 });
            await command(initdbExecutable, ["-D", dataDir, "--username=canvas_test_admin", "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C", `--pwfile=${passwordFile}`, "--no-instructions"]);
        } finally { if (!await absent(passwordFile)) await unlink(passwordFile); }
        phase = "startup"; startupAttempted = true;
        await command(pgCtlExecutable, ["start", "-D", dataDir, "-l", logFile, "-w", "-t", "30", "-o", `-h 127.0.0.1 -p ${port}`]);
        phase = "identity";
        const admin = new Client({ host: "127.0.0.1", port, user: "canvas_test_admin", password: adminPassword, database: "postgres", connectionTimeoutMillis: 5_000 });
        try {
            await admin.connect();
            const { rows: [identity] } = await admin.query(`SELECT current_setting('data_directory') AS data_directory, host(inet_server_addr()) AS host,
                inet_server_port() AS port, current_database() AS database, current_user AS role, current_setting('server_version_num') AS server_version_num,
                to_regnamespace('canvas_saas') IS NULL AND to_regnamespace('canvas_jobs') IS NULL AS fresh`);
            const actualDirectory = await realpath(identity.data_directory);
            if (resolve(actualDirectory).toLowerCase() !== resolve(await realpath(dataDir)).toLowerCase() || identity.host !== "127.0.0.1" || identity.port !== port ||
                identity.database !== "postgres" || identity.role !== "canvas_test_admin" || identity.server_version_num !== "180004" || identity.fresh !== true) {
                throw new Error("T10 server identity mismatch");
            }
            const postmasterPid = Number((await readFile(join(dataDir, "postmaster.pid"), "utf8")).split(/\r?\n/, 1)[0]);
            if (!Number.isSafeInteger(postmasterPid) || postmasterPid <= 0) throw new Error("T10 postmaster identity unavailable");
            await write("identity.json", { runId, ...identity, expectedDataDirectory: dataDir, postmasterPid, checkedBeforeCreate: true });
            phase = "database";
            await admin.query(`CREATE ROLE canvas_test_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD ${admin.escapeLiteral(appPassword)}`);
            await admin.query("CREATE DATABASE canvas_saas_test OWNER canvas_test_app");
        } finally { await admin.end(); }
        phase = "test";
        await testCommand({ ...process.env, SAAS_TEST_DATABASE_URL: `postgresql://canvas_test_app:${appPassword}@127.0.0.1:${port}/canvas_saas_test`,
            SAAS_POSTGRES_TEST_SUITE: "canvas-sharing", SAAS_TEST_DATA_DIRECTORY: dataDir, SAAS_TEST_RUN_ID: runId,
            SAAS_TEST_CLUSTER_MARKER: markerPath, SAAS_TEST_CLUSTER_PORT: String(port) });
    } catch (error) { failure = { phase, code: code(error) }; }
    finally {
        try {
            if (startupAttempted) {
                let running = true;
                try { await promisify(execFile)(pgCtlExecutable, ["status", "-D", dataDir], { windowsHide: true, timeout: 10_000 }); }
                catch (error) { if ((error as { code?: number }).code === 3) running = false; else throw error; }
                if (running) {
                    await command(pgCtlExecutable, ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "30"]);
                    cleanup.stopExitCode = 0;
                }
                try { await promisify(execFile)(pgCtlExecutable, ["status", "-D", dataDir], { windowsHide: true, timeout: 10_000 }); cleanup.statusExitCode = 0; }
                catch (error) { cleanup.statusExitCode = typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null; }
            }
            cleanup.pidFileAbsent = await absent(join(dataDir, "postmaster.pid"));
            cleanup.portClosed = await closedPort(port);
            cleanup.initPasswordAbsent = await absent(passwordFile);
        } catch (error) { cleanup.errorCode = code(error); }
        cleanup.completedAt = new Date().toISOString();
        await write("cleanup.json", cleanup);
        const success = !failure && test.exitCode === 0 && test.exitObserved && test.closeObserved && !test.timedOut &&
            cleanup.statusExitCode === 3 && cleanup.pidFileAbsent && cleanup.portClosed && cleanup.initPasswordAbsent && !cleanup.errorCode;
        const result = { kind: "canvas-sharing-native-result", runId, runDir, dataDir, port, test, cleanup, failure, success };
        await write("commands.json", commands);
        await write("result.json", result);
        console.log(JSON.stringify(result));
        if (!success) throw new Error("T10 native runner failed; inspect the safe result.json and original output");
    }
}
