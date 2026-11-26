import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDatabase } from "@infinite-canvas/database";

const componentTestFile = "apps/api/test/payment-postgres.test.ts";
const httpTestFile = "apps/api/test/payment-postgres-http.test.ts";
const uiFixtureFile = "apps/api/test/payment-ui-fixture.ts";
const databaseName = "canvas_payments_z1", appRole = "canvas_payments_z1_app", adminRole = "canvas_payments_z1_admin";
const root = fileURLToPath(new URL("../../../", import.meta.url));
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const errorCode = (error: unknown) => {
    const value = (error as { code?: unknown })?.code;
    return typeof value === "string" && /^[A-Za-z0-9_]+$/.test(value) ? value : "unclassified";
};
const samePath = (left: string, right: string) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
const absent = async (path: string) => {
    try { await access(path); return false; }
    catch (error) { if ((error as { code?: string }).code === "ENOENT") return true; throw error; }
};

export type PaymentPostgresMarker = {
    kind: "canvas-payments-z1-pg16";
    mode?: "components" | "http" | "ui";
    status: "prepared" | "identity-verified";
    runId: string;
    runDir: string;
    dataDir: string;
    nativeRoot: string;
    host: "127.0.0.1";
    port: number;
    database: string;
    role: string;
    clusterName: string;
    serverVersionNum: string;
    postmasterPid: number | null;
    postmasterPidStartSeconds: number | null;
    postmasterStart: string | null;
    postmasterStartEpoch: string | null;
};

type CommandReceipt = {
    name: string; executable: string; args: string[]; pid: number | null;
    startedAt: string; completedAt: string | null; exitCode: number | null;
    signal: string | null; exitObserved: boolean; closeObserved: boolean;
    timedOut: boolean; killRequested: boolean; spawnError: string | null;
};

/** Explicit local PG16 opt-in; creates a new cluster and never accepts an existing URL. */
export async function runPaymentPostgres(nativeArgument: string, mode: "components" | "http" | "ui" = "components") {
    if (mode !== "components" && mode !== "http" && mode !== "ui") fail("fixed_payment_test_mode_required");
    const testArgs = ["--no-env-file", "--no-install", mode === "ui" ? "run" : "test", mode === "ui" ? uiFixtureFile : mode === "http" ? httpTestFile : componentTestFile];
    const forbidden = Object.keys(process.env).filter((name) =>
        /(?:^|_)DATABASE_URL$|^PG|^SAAS_POSTGRES_|^SAAS_TEST_|^SAAS_PAYMENTS_|^CANVAS_ACCEPTANCE_|^NODE_(?:PATH|OPTIONS)$|^BUN_(?:OPTIONS|PRELOAD|CONFIG_|INSTALL$)/i.test(name));
    if (forbidden.length) fail(`external_environment_rejected_${forbidden.sort().join("_")}`);
    if (process.platform !== "win32" || process.arch !== "x64" || !process.versions.bun || basename(process.execPath).toLowerCase() !== "bun.exe") fail("windows_x64_bun_required");
    if (!isAbsolute(nativeArgument) || /[^\x20-\x7e]/.test(nativeArgument)) fail("absolute_ascii_native_root_required");
    const nativeRoot = await realpath(nativeArgument), temporaryRoot = await realpath(tmpdir());
    if (!/^[A-Za-z]:\\/.test(temporaryRoot) || !/^[A-Za-z]:\\/.test(nativeRoot) || /[^\x20-\x7e]/.test(temporaryRoot) || /[^\x20-\x7e]/.test(nativeRoot)) fail("local_ascii_paths_required");
    const tools = { postgres: join(nativeRoot, "bin", "postgres.exe"), initdb: join(nativeRoot, "bin", "initdb.exe"), pgCtl: join(nativeRoot, "bin", "pg_ctl.exe") };
    for (const executable of Object.values(tools)) {
        if (!samePath(await realpath(executable), executable)) fail("native_tool_link_rejected");
    }
    // No inherited PATH, connection variables, provider credentials or Node/Bun preload options.
    const baseEnv: NodeJS.ProcessEnv = {};
    for (const key of ["SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "PATHEXT", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "ProgramData", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]) {
        const entry = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase());
        if (entry) baseEnv[key] = entry[1];
    }
    const windowsRoot = baseEnv.SystemRoot ?? baseEnv.WINDIR;
    if (!windowsRoot || !isAbsolute(windowsRoot)) fail("windows_system_root_required");
    baseEnv.PATH = [dirname(process.execPath), join(windowsRoot, "System32"), windowsRoot].join(";");
    baseEnv.TEMP = temporaryRoot; baseEnv.TMP = temporaryRoot; baseEnv.NO_COLOR = "1";
    // Reject config-file preloads too; this runner has no configurable source/dependency root.
    for (const config of [join(root, "bunfig.toml"), join(baseEnv.USERPROFILE ?? temporaryRoot, ".bunfig.toml")]) {
        if (!await absent(config)) fail("bun_config_override_rejected");
    }
    await access(join(root, testArgs[3]!));
    const runs = join(temporaryRoot, "canvas-payments-z1");
    await mkdir(runs, { recursive: true });
    if (!samePath(await realpath(runs), runs)) fail("run_parent_link_rejected");
    const runDir = await mkdtemp(join(runs, "run-")), dataDir = join(runDir, "data");
    const evidenceParent = join(root, "docs", "test-results", "payments-z1");
    await mkdir(evidenceParent, { recursive: true });
    const evidenceDir = await mkdtemp(join(evidenceParent, mode === "ui" ? "pg16-ui-run-" : mode === "http" ? "pg16-http-run-" : "pg16-run-"));
    const markerPath = join(runDir, "marker.json"), passwordFile = join(runDir, ".init-password"), postgresLog = join(runDir, "postgres.log");
    const runId = crypto.randomUUID(), clusterName = `canvas_payments_z1_${runId.replaceAll("-", "")}`;
    const adminPassword = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const appPassword = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    const port = await new Promise<number>((done, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            if (!address || typeof address === "string") { probe.close(); reject(new Error("loopback_port_unavailable")); return; }
            probe.close((error) => error ? reject(error) : done(address.port));
        });
    });
    const appUrl = `postgresql://${appRole}:${appPassword}@127.0.0.1:${port}/${databaseName}`;
    const redact = (value: string) => value.replaceAll(appUrl, "[test-database-url]").replaceAll(adminPassword, "[redacted]").replaceAll(appPassword, "[redacted]");
    let outputRedacted = false;
    const safeOutput = (value: string) => { const safe = redact(value); if (safe !== value) outputRedacted = true; return safe; };
    const commands: CommandReceipt[] = [];
    let nativeOutput = "", testStdout = "", testStderr = "", activeChild: ChildProcess | null = null, interrupted = false;
    const interrupt = () => {
        interrupted = true;
        if (mode === "ui" && marker?.status === "identity-verified") {
            // The UI child observes this exact run's stop file and closes Vite/TLS/pool in finally.
            void writeFile(join(runDir, "ui-stop.request"), "stop\n").catch(() => { try { activeChild?.kill("SIGKILL"); } catch {} });
        } else { try { activeChild?.kill("SIGKILL"); } catch { /* Exit observation remains authoritative. */ } }
    };
    process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
    async function command(name: string, executable: string, args: string[], env = baseEnv, test = false) {
        const receipt: CommandReceipt = { name, executable, args, pid: null, startedAt: new Date().toISOString(), completedAt: null,
            exitCode: null, signal: null, exitObserved: false, closeObserved: false, timedOut: false, killRequested: false, spawnError: null };
        commands.push(receipt);
        let stdout = "", stderr = "";
        await new Promise<void>((done) => {
            let child: ChildProcess;
            try { child = spawn(executable, args, { cwd: test ? root : runDir, env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] }); }
            catch (error) { receipt.spawnError = errorCode(error); done(); return; }
            activeChild = child; receipt.pid = child.pid ?? null;
            let settled = false;
            const finish = () => { if (settled) return; settled = true; if (deadline) clearTimeout(deadline); if (activeChild === child) activeChild = null; done(); };
            // Native lifecycle waits reuse the existing 30s test-tool boundary. Test cases own their Bun timeouts.
            const deadline = test ? undefined : setTimeout(() => {
                receipt.timedOut = true;
                try { receipt.killRequested = child.kill("SIGKILL"); } catch { /* A missing exit stays unknown, never success. */ }
                finish();
            }, 30_000);
            child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
            child.stdout?.on("data", (chunk: string) => { stdout += chunk; if (test && mode === "ui") process.stdout.write(safeOutput(chunk)); });
            child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
            child.once("error", (error) => { receipt.spawnError = errorCode(error); if (!child.pid) finish(); });
            child.once("exit", (code, signal) => {
                receipt.exitObserved = true; receipt.exitCode = code; receipt.signal = signal;
                // pg_ctl start can leave inherited handles; test stdout/stderr require close.
                if (!test) finish();
            });
            child.once("close", (code, signal) => { receipt.closeObserved = true; receipt.exitCode = code; receipt.signal = signal; finish(); });
        });
        receipt.completedAt = new Date().toISOString();
        if (test) { testStdout = stdout; testStderr = stderr; }
        else nativeOutput += `\n[${name}]\n${stdout}${stderr}`;
        return { receipt, stdout, stderr };
    }
    const requireSuccess = (receipt: CommandReceipt) => {
        if (interrupted || receipt.spawnError || receipt.timedOut || !receipt.exitObserved || receipt.exitCode !== 0) fail("native_command_failed");
    };
    let phase = "version", startupAttempted = false, failure: { phase: string; code: string } | null = null;
    let marker: PaymentPostgresMarker | null = null, adminIdentity: unknown = null, appIdentity: unknown = null;
    const cleanup = { statusBefore: null as number | null, stopExitCode: null as number | null, statusAfter: null as number | null,
        pidFileAbsent: false, passwordFileAbsent: false, errorCode: null as string | null, completedAt: null as string | null };
    const assertRunPath = async () => {
        if (!samePath(await realpath(runDir), runDir) || relative(runDir, dataDir) !== "data") fail("run_directory_identity_mismatch");
        if (!await absent(dataDir) && !samePath(await realpath(dataDir), dataDir)) fail("data_directory_link_rejected");
    };
    const readPostmaster = async () => {
        const lines = (await readFile(join(dataDir, "postmaster.pid"), "utf8")).split(/\r?\n/);
        const pid = Number(lines[0]), startSeconds = Number(lines[2]);
        if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(startSeconds) || !samePath(lines[1] ?? "", dataDir) || Number(lines[3]) !== port || lines[5] !== "127.0.0.1") fail("postmaster_file_identity_mismatch");
        if (marker?.postmasterPid && (marker.postmasterPid !== pid || marker.postmasterPidStartSeconds !== startSeconds)) fail("postmaster_changed");
        return { pid, startSeconds };
    };
    try {
        const version = await command("postgres-version", tools.postgres, ["--version"]);
        requireSuccess(version.receipt);
        const match = /^postgres \(PostgreSQL\) 16\.(\d+)\s*$/.exec(version.stdout);
        if (!match) fail("postgresql_16_required");
        const serverVersionNum = String(160000 + Number(match[1]));
        marker = { kind: "canvas-payments-z1-pg16", mode, status: "prepared", runId, runDir, dataDir, nativeRoot,
            host: "127.0.0.1", port, database: databaseName, role: appRole, clusterName, serverVersionNum,
            postmasterPid: null, postmasterPidStartSeconds: null, postmasterStart: null, postmasterStartEpoch: null };
        await writeFile(markerPath, JSON.stringify(marker, null, 2) + "\n", { flag: "wx" });
        phase = "initialization";
        try {
            await writeFile(passwordFile, adminPassword + "\n", { flag: "wx", mode: 0o600 });
            requireSuccess((await command("initdb", tools.initdb, ["-D", dataDir, `--username=${adminRole}`, "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C", `--pwfile=${passwordFile}`, "--no-instructions"])).receipt);
        } finally { if (!await absent(passwordFile)) await unlink(passwordFile); }
        phase = "startup"; startupAttempted = true;
        await assertRunPath();
        requireSuccess((await command("pg-ctl-start", tools.pgCtl, ["start", "-D", dataDir, "-l", postgresLog, "-w", "-t", "30", "-o", `-h 127.0.0.1 -p ${port} -c cluster_name=${clusterName}`])).receipt);
        phase = "identity";
        const admin = createDatabase(`postgresql://${adminRole}:${adminPassword}@127.0.0.1:${port}/postgres`);
        admin.pool.on("error", () => { failure ??= { phase: "admin-pool", code: "unexpected_pool_error" }; });
        const identitySql = `SELECT host(inet_server_addr()) AS host, inet_server_port() AS port, current_database() AS database,
            current_user AS role, current_setting('server_version_num') AS server_version_num, current_setting('cluster_name') AS cluster_name,
            pg_postmaster_start_time()::text AS postmaster_start, extract(epoch FROM pg_postmaster_start_time())::text AS postmaster_start_epoch`;
        try {
            const actual = (await admin.pool.query(`${identitySql}, current_setting('data_directory') AS data_directory,
                split_part(pg_read_file('postmaster.pid'), E'\n', 1)::bigint::text AS file_postmaster_pid,
                split_part(pg_read_file('postmaster.pid'), E'\n', 3)::bigint::text AS file_postmaster_start_seconds,
                to_regnamespace('canvas_saas') IS NULL AND to_regnamespace('canvas_migrations') IS NULL AND to_regnamespace('canvas_jobs') IS NULL AS fresh`)).rows[0];
            const postmaster = await readPostmaster();
            adminIdentity = actual ? { ...actual, postmasterStartSeconds: postmaster.startSeconds } : null;
            if (!actual || !samePath(await realpath(actual.data_directory), await realpath(dataDir)) || actual.host !== "127.0.0.1" || actual.port !== port ||
                actual.database !== "postgres" || actual.role !== adminRole || actual.server_version_num !== serverVersionNum || actual.cluster_name !== clusterName ||
                actual.fresh !== true || Number(actual.file_postmaster_pid) !== postmaster.pid ||
                Number(actual.file_postmaster_start_seconds) !== postmaster.startSeconds) fail("admin_identity_mismatch");
            if (JSON.stringify(JSON.parse(await readFile(markerPath, "utf8"))) !== JSON.stringify(marker)) fail("prepared_marker_changed");
            // PG samples the pid-file start and SQL start at separate moments. Keep both
            // exact identities; equating their rounded seconds can reject a valid startup.
            marker.postmasterPid = postmaster.pid; marker.postmasterPidStartSeconds = postmaster.startSeconds;
            marker.postmasterStart = actual.postmaster_start; marker.postmasterStartEpoch = actual.postmaster_start_epoch;
            phase = "database";
            // Generated passwords contain only hexadecimal characters; no incoming SQL or database name is accepted.
            await admin.pool.query(`CREATE ROLE ${appRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${appPassword}'`);
            await admin.pool.query(`CREATE DATABASE ${databaseName} OWNER ${appRole}`);
            const app = createDatabase(appUrl);
            app.pool.on("error", () => { failure ??= { phase: "app-pool", code: "unexpected_pool_error" }; });
            try {
                const actualApp = (await app.pool.query(`${identitySql},
                    (SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS restricted,
                    to_regnamespace('canvas_saas') IS NULL AND to_regnamespace('canvas_migrations') IS NULL AND to_regnamespace('canvas_jobs') IS NULL AS fresh`)).rows[0];
                if (!actualApp || actualApp.host !== "127.0.0.1" || actualApp.port !== port || actualApp.database !== databaseName || actualApp.role !== appRole ||
                    actualApp.server_version_num !== serverVersionNum || actualApp.cluster_name !== clusterName || actualApp.postmaster_start_epoch !== marker.postmasterStartEpoch ||
                    actualApp.postmaster_start !== marker.postmasterStart || actualApp.restricted !== true || actualApp.fresh !== true) fail("app_identity_mismatch");
                appIdentity = actualApp;
            } finally { await app.close(); }
            const finalAdmin = (await admin.pool.query(`${identitySql}, current_setting('data_directory') AS data_directory`)).rows[0];
            if (!samePath(await realpath(finalAdmin.data_directory), dataDir) || finalAdmin.postmaster_start_epoch !== marker.postmasterStartEpoch || finalAdmin.cluster_name !== clusterName) fail("server_identity_changed");
        } finally { await admin.close(); }
        if (failure || interrupted) fail("pretest_dependency_failed");
        marker.status = "identity-verified";
        await writeFile(markerPath, JSON.stringify(marker, null, 2) + "\n");
        await readPostmaster();
        if (JSON.stringify(JSON.parse(await readFile(markerPath, "utf8"))) !== JSON.stringify(marker)) fail("verified_marker_changed");
        phase = "test";
        const test = await command("payment-postgres-test", process.execPath, testArgs, { ...baseEnv,
            SAAS_TEST_DATABASE_URL: appUrl, SAAS_PAYMENTS_Z1_CLUSTER_MARKER: markerPath }, true);
        requireSuccess(test.receipt);
        if (!test.receipt.closeObserved) fail("test_stream_close_unconfirmed");
    } catch (error) { failure ??= { phase, code: errorCode(error) }; }
    finally {
        try {
            await assertRunPath();
            if (startupAttempted) {
                const before = await command("pg-ctl-status-before-cleanup", tools.pgCtl, ["status", "-D", dataDir]);
                cleanup.statusBefore = before.receipt.exitCode;
                if (before.receipt.timedOut || !before.receipt.exitObserved || before.receipt.spawnError || ![0, 3].includes(before.receipt.exitCode ?? -1)) fail("cleanup_status_unknown");
                if (before.receipt.exitCode === 0) {
                    await readPostmaster();
                    const stop = await command("pg-ctl-stop", tools.pgCtl, ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "30"]);
                    cleanup.stopExitCode = stop.receipt.exitCode;
                    if (stop.receipt.spawnError || stop.receipt.timedOut || !stop.receipt.exitObserved || stop.receipt.exitCode !== 0) fail("cleanup_stop_failed");
                }
                const after = await command("pg-ctl-status-after-cleanup", tools.pgCtl, ["status", "-D", dataDir]);
                cleanup.statusAfter = after.receipt.exitCode;
                if (after.receipt.spawnError || after.receipt.timedOut || !after.receipt.exitObserved || after.receipt.exitCode !== 3) fail("cleanup_not_confirmed_stopped");
            }
        } catch (error) { cleanup.errorCode = errorCode(error); }
        try { if (!await absent(passwordFile)) await unlink(passwordFile); cleanup.passwordFileAbsent = await absent(passwordFile); cleanup.pidFileAbsent = await absent(join(dataDir, "postmaster.pid")); }
        catch (error) { cleanup.errorCode ??= errorCode(error); }
        cleanup.completedAt = new Date().toISOString();
        process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
        const test = commands.find((entry) => entry.name === "payment-postgres-test") ?? null;
        const success = !failure && !interrupted && !cleanup.errorCode && cleanup.statusAfter === 3 && cleanup.pidFileAbsent && cleanup.passwordFileAbsent &&
            !!test && test.exitCode === 0 && test.exitObserved && test.closeObserved && !test.spawnError && !test.timedOut;
        // Four compact evidence files per run; the original synthetic data and PG log stay in this run's temp directory.
        await writeFile(join(evidenceDir, "test.stdout.log"), safeOutput(testStdout), { flag: "wx" });
        await writeFile(join(evidenceDir, "test.stderr.log"), safeOutput(testStderr), { flag: "wx" });
        await writeFile(join(evidenceDir, "native.log"), safeOutput(nativeOutput), { flag: "wx" });
        await writeFile(join(evidenceDir, "result.json"), JSON.stringify({ kind: "payments-z1-pg16-result", mode, success, runId, runDir, dataDir, nativeRoot,
            evidenceDir, markerPath, postgresLog, bunVersion: process.versions.bun, marker, adminIdentity, appIdentity, commands, failure, interrupted, outputRedacted, cleanup }, null, 2) + "\n", { flag: "wx" });
        console.log(JSON.stringify({ kind: "payments-z1-pg16-result", mode, success, evidenceDir, runDir, testExitCode: test?.exitCode ?? null, cleanup }));
        if (!success) fail("payment_postgres_run_failed");
    }
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    try {
        if ((args.length !== 2 && args.length !== 3) || args[0] !== "--native-root" || !args[1] || args.length === 3 && args[2] !== "--http" && args[2] !== "--ui") fail("usage_native_root_optional_http_or_ui_required");
        await runPaymentPostgres(args[1], args[2] === "--ui" ? "ui" : args[2] === "--http" ? "http" : "components");
    } catch (error) { console.error(JSON.stringify({ kind: "payments-z1-pg16-runner-error", code: errorCode(error) })); process.exitCode = 1; }
}
