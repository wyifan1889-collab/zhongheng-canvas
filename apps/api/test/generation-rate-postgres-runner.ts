// Adapted from Z1's reviewed shared PG16 runner. Only fresh owned local clusters;
// final source/target is the Q1 canonical worktree, never an old candidate.
import { execFile, spawn } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, readFile, realpath, readdir, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "../../../packages/database/src/client";
import { migrateDatabase } from "../../../packages/database/src/migrate";
import { checkAccountDatabaseReadiness, checkGenerationDatabaseReadiness, checkGenerationRateDatabaseReadiness,
    checkPaymentDatabaseReadiness, checkVideoDatabaseReadiness } from "../src/readiness";
import { runGenerationWorkerSchemaOperation } from "../src/generation-worker-schema";

const sourceRoot = "E:\\codex-画布\\worktrees\\launch-safety-q1-r1";
const nativeRoot = "C:\\Users\\WYF\\AppData\\Local\\Temp\\canvas-payments-z1-pg16-65d9c1e4ca6c\\native\\pgsql";
const baseCommit = "fe8edd2fc95779cbf97823982255673b6fc61d98";
const expectedMigrationCount = 33, expectedTag = "0032_generation_rate_policy";
const evidenceRoot = "E:\\codex-画布\\evidence\\launch-q1-r1";
const groups = [
    { name: "migration-readiness", files: ["apps/api/test/generation-rate-readiness.test.ts"], queue: false },
    { name: "rate-atomic", files: ["apps/api/test/generation-rate-atomic-postgres.test.ts"], queue: false },
    { name: "rate-settings", files: ["apps/api/test/generation-rate-settings-postgres.test.ts"], queue: false },
    { name: "four-media", files: ["apps/api/test/generation-rate-transaction-admission.test.ts"], queue: true },
    { name: "four-media-http", files: ["apps/api/test/generation-rate-http.test.ts"], queue: true },
    { name: "http", files: ["apps/api/test/payment-safety-integration.test.ts", "apps/api/test/content-safety-api-postgres.test.ts"], queue: false },
] as const;
const samePath = (a: string, b: string) => normalize(a).toLowerCase() === normalize(b).toLowerCase();
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const safeCode = (error: unknown) => typeof (error as { code?: unknown })?.code === "string" && /^[A-Za-z0-9_]+$/.test((error as { code: string }).code)
    ? (error as { code: string }).code : "runner_failure";
const options = new Map<string, string>();
let check = false, execute = false;
for (let index = 2; index < process.argv.length; index++) {
    const arg = process.argv[index]!;
    if (arg === "--check") { if (check) fail("duplicate_check"); check = true; }
    else if (arg === "--run") { if (execute) fail("duplicate_run"); execute = true; }
    else if (["--group", "--freeze-commit"].includes(arg)) {
        const value = process.argv[++index];
        if (!value || value.startsWith("--") || options.has(arg)) fail("invalid_fixed_runner_argument"); options.set(arg, value);
    } else fail("fixed_runner_arguments_required");
}
if (check === execute) fail("choose_check_or_run");
const selected = options.has("--group") ? groups.filter(group => group.name === options.get("--group")) : groups;
if (!selected.length) fail("fixed_group_required");
if (process.platform !== "win32" || process.arch !== "x64" || process.versions.bun !== "1.4.2" || basename(process.execPath).toLowerCase() !== "bun.exe") fail("fixed_windows_bun_required");
const forbidden = Object.keys(process.env).filter(name => /(?:^|_)DATABASE_URL$|^PG|^SAAS_(?:TEST_|POSTGRES_|PAYMENTS_)|^CANVAS_ACCEPTANCE_|^Q1_|^VIDEO_TEST_|^VITE_|^NODE_(?:PATH|OPTIONS)$|^BUN_(?:OPTIONS|PRELOAD|CONFIG_|INSTALL$)/i.test(name));
if (forbidden.length) fail(`external_environment_rejected_${forbidden.sort().join("_")}`);
if (!samePath(await realpath(sourceRoot), sourceRoot) || !samePath(await realpath(nativeRoot), nativeRoot)) fail("fixed_directory_link_rejected");
if (!samePath(await realpath(fileURLToPath(new URL("../../../", import.meta.url))), sourceRoot)) fail("runner_must_execute_from_canonical_q1_source");
const apiRequire = createRequire(join(sourceRoot, "apps/api/package.json"));
for (const [name, target] of [["@infinite-canvas/database", "packages/database/src/client.ts"], ["@infinite-canvas/auth", "packages/auth/src/index.ts"], ["@infinite-canvas/jobs", "packages/jobs/src/index.ts"]]) {
    if (!samePath(await realpath(apiRequire.resolve(name!)), join(sourceRoot, target!))) fail("workspace_source_identity_mismatch");
}
for (const group of selected) for (const file of group.files) await access(join(sourceRoot, file));
// Resolve pg from its actual workspace owner; apps/api intentionally has no direct pg dependency.
const require = createRequire(join(sourceRoot, "packages/database/package.json")), { Client } = require("pg");
const osEnvironment: NodeJS.ProcessEnv = {};
const osKeys = new Set(["path", "systemroot", "windir", "comspec", "temp", "tmp", "userprofile", "homedrive", "homepath", "appdata", "localappdata", "programfiles", "programfiles(x86)", "number_of_processors", "processor_architecture", "pathext"]);
for (const [name, value] of Object.entries(process.env)) if (osKeys.has(name.toLowerCase())) osEnvironment[name] = value;
const invoke = promisify(execFile), pgCtl = join(nativeRoot, "bin", "pg_ctl.exe"), initdb = join(nativeRoot, "bin", "initdb.exe");
for (const [tool, label] of [[initdb, "initdb"], [pgCtl, "pg_ctl"], [join(nativeRoot, "bin", "postgres.exe"), "postgres"]]) {
    if (!samePath(await realpath(tool!), tool!)) fail("native_tool_link_rejected");
    const result = await invoke(tool!, ["--version"], { env: osEnvironment, windowsHide: true, timeout: 15_000 });
    if (result.stdout.trim() !== `${label} (PostgreSQL) 16.15` || result.stderr.trim()) fail("postgres_16_15_required");
}
const git = join(process.env.USERPROFILE ?? "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "git", "cmd", "git.exe");
await access(git);
const head = (await invoke(git, ["rev-parse", "HEAD"], { cwd: sourceRoot, env: osEnvironment, windowsHide: true })).stdout.trim();
const freeze = options.get("--freeze-commit");
if (freeze && (!/^[0-9a-f]{40}$/.test(freeze) || freeze !== head) || execute && !freeze) fail("exact_frozen_head_required");
async function assertFrozen() {
    const current = (await invoke(git, ["rev-parse", "HEAD"], { cwd: sourceRoot, env: osEnvironment, windowsHide: true })).stdout.trim();
    const paths = ["apps/api", "packages", "web", "bun.lock"];
    if (!freeze || current !== freeze ||
        (await invoke(git, ["diff", "HEAD", "--name-only", "--", ...paths], { cwd: sourceRoot, env: osEnvironment, windowsHide: true })).stdout.trim() ||
        (await invoke(git, ["ls-files", "--others", "--exclude-standard", "--", ...paths], { cwd: sourceRoot, env: osEnvironment, windowsHide: true })).stdout.trim()) fail("all_execution_sources_must_be_committed_and_frozen");
}
if (freeze) await assertFrozen();
const journal = JSON.parse(await readFile(join(sourceRoot, "packages/database/migrations/meta/_journal.json"), "utf8"));
if (journal.entries?.length !== expectedMigrationCount || journal.entries.at(-1)?.idx !== 32 || journal.entries.at(-1)?.tag !== expectedTag) fail("formal_0032_33_entries_required");
const baseJournal = JSON.parse((await invoke(git, ["show", `${baseCommit}:packages/database/migrations/meta/_journal.json`],
    { cwd: sourceRoot, env: osEnvironment, windowsHide: true })).stdout);
if (baseJournal.entries?.length !== 32 || JSON.stringify(journal.entries.slice(0, 32)) !== JSON.stringify(baseJournal.entries)) fail("historical_migration_journal_changed");
for (const entry of journal.entries) await access(join(sourceRoot, "packages/database/migrations", `${entry.tag}.sql`));
const migratedPaths = (await invoke(git, ["diff", "--name-only", baseCommit, "HEAD", "--", "packages/database/migrations"],
    { cwd: sourceRoot, env: osEnvironment, windowsHide: true })).stdout.trim().split(/\r?\n/).filter(Boolean);
const allowedMigrations = new Set([`packages/database/migrations/${expectedTag}.sql`, "packages/database/migrations/meta/0032_snapshot.json", "packages/database/migrations/meta/_journal.json"]);
if (migratedPaths.some(path => !allowedMigrations.has(path))) fail("historical_migration_changed");
await invoke(git, ["merge-base", "--is-ancestor", baseCommit, "HEAD"], { cwd: sourceRoot, env: osEnvironment, windowsHide: true });
if (check) {
    console.log(JSON.stringify({ mode: "q1-pg16-check", sourceRoot, baseCommit, head, frozenHeadConfirmed: !!freeze, expectedMigrationCount, migrationTag: expectedTag,
        groups: selected, nativeRoot, nativeVersion: "16.15", blockedForRun: !freeze ? ["freeze-commit"] : [],
        databaseStarted: false, readiness: "not_run_requires_new_cluster", evidenceRoot, artifactsPerGroup: 4 }));
    process.exit(0);
}
const temporaryRoot = await realpath(tmpdir());
if (/[^\x20-\x7e]/.test(temporaryRoot)) fail("ascii_new_cluster_parent_required");
await mkdir(evidenceRoot, { recursive: true });
if (!samePath(await realpath(evidenceRoot), evidenceRoot)) fail("evidence_directory_link_rejected");
async function fileCount(directory: string): Promise<number> {
    let count = 0; for (const item of await readdir(directory, { withFileTypes: true })) count += item.isDirectory() ? await fileCount(join(directory, item.name)) : 1; return count;
}
if (await fileCount(evidenceRoot) + selected.length * 4 > 50) fail("evidence_batch_50_file_limit");
const suiteEvidence = await mkdtemp(join(evidenceRoot, "run-"));
let anyFailure = false;
for (const group of selected) {
    await assertFrozen();
    const runDir = await mkdtemp(join(temporaryRoot, `canvas-q1-${group.name}-pg16-`)), dataDir = join(runDir, "data"), logFile = join(runDir, "postgres.log");
    const groupEvidence = join(suiteEvidence, group.name); await mkdir(groupEvidence);
    const adminPassword = crypto.randomUUID() + crypto.randomUUID(), appPassword = crypto.randomUUID() + crypto.randomUUID();
    const passwordFile = join(runDir, ".init-password"), clusterName = `canvas_q1_${crypto.randomUUID().replaceAll("-", "")}`;
    let url = "", port = 0, nativeLog = "", stdout = "", stderr = "", startupAttempted = false, interrupted = false, cleaningUp = false;
    let activeChild: ReturnType<typeof spawn> | undefined;
    const redact = (value: string) => value.replaceAll(adminPassword, "[redacted]").replaceAll(appPassword, "[redacted]");
    const summary = { kind: "q1-policy-pg16-group", group: group.name, files: group.files, sourceRoot, baseCommit, freezeCommit: freeze, runDir, dataDir,
        nativeVersion: "16.15", nativeRoot, port: 0, clusterName, realProvider: false, storage: "synthetic-in-memory", identity: null as Record<string, unknown> | null, appIdentity: null as Record<string, unknown> | null,
        priorMigrations: 0, migrationCount: null as number | null, repeatedMigrationCount: null as number | null, migrationTag: expectedTag,
        readinessBefore: null as unknown, readinessAfter: null as unknown, queue: null as unknown,
        formalPolicySchemaInstalledBeforeTests: false, upgrade: null as Record<string, unknown> | null,
        phase: "preparation", testExitCode: null as number | null, passed: null as number | null, skipped: null as number | null,
        failure: null as string | null, failureStage: null as string | null, stop: "not_started", pidFileAbsent: false, passwordFileAbsent: false, completedAt: null as string | null };
    const interrupt = () => { interrupted = true; if (!cleaningUp) activeChild?.kill("SIGTERM"); };
    process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
    async function command(executable: string, args: string[], env = osEnvironment, test = false): Promise<number> {
        if (interrupted && !cleaningUp) fail("run_interrupted");
        return new Promise((done, reject) => {
            const child = spawn(executable, args, { cwd: test ? sourceRoot : runDir, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); activeChild = child;
            let out = "", err = "", settled = false;
            let spawnError: Error | undefined;
            const finish = (code: number | null, signal?: string | null, failure?: Error) => {
                if (settled) return; settled = true;
                if (timer) clearTimeout(timer);
                if (activeChild === child) activeChild = undefined;
                if (test) { stdout = redact(out); stderr = redact(err); } else nativeLog += `[${basename(executable)} ${args[0]}]\n${redact(out + err)}\n`;
                const error = failure ?? spawnError ?? (signal ? Object.assign(new Error(), { code: "child_interrupted" }) : undefined);
                error ? reject(error) : done(code ?? 1);
            };
            // pg_ctl may exit while the server retains inherited pipe handles.
            // Native exit is authoritative; tests still require closed output streams.
            const timer = test ? undefined : setTimeout(() => {
                try { child.kill("SIGKILL"); } catch { /* Unknown termination remains failure. */ }
                finish(null, undefined, Object.assign(new Error(), { code: "native_command_timeout" }));
            }, 30_000);
            child.stdout!.setEncoding("utf8"); child.stderr!.setEncoding("utf8"); child.stdout!.on("data", value => { out += value; }); child.stderr!.on("data", value => { err += value; });
            child.once("error", error => { spawnError = error; if (!child.pid) finish(null, undefined, error); });
            child.once("exit", (code, signal) => { if (!test) finish(code, signal); });
            child.once("close", (code, signal) => finish(code, signal));
        });
    }
    const native = async (executable: string, args: string[]) => { if (await command(executable, args) !== 0) fail("native_command_failed"); };
    async function pidIdentity() {
        if (!samePath(await realpath(runDir), runDir) || !samePath(await realpath(dataDir), dataDir)) fail("run_directory_changed");
        const lines = (await readFile(join(dataDir, "postmaster.pid"), "utf8")).split(/\r?\n/);
        if (!/^\d+$/.test(lines[0]!) || !samePath(lines[1]!, dataDir) || !/^\d+$/.test(lines[2]!) || Number(lines[3]) !== port || lines[5] !== "127.0.0.1") fail("postmaster_file_mismatch");
        if (summary.identity && (Number(lines[0]) !== summary.identity.pid || Number(lines[2]) !== summary.identity.pidStartSeconds)) fail("postmaster_changed");
        return lines;
    }
    async function absent(file: string) {
        try { await access(file); return false; }
        catch (error) { if ((error as { code?: string }).code === "ENOENT") return true; throw error; }
    }
    async function stop() {
        if (!startupAttempted) return;
        const status = await command(pgCtl, ["status", "-D", dataDir]);
        if (status === 3) { summary.stop = "confirmed_not_running"; return; }
        if (status !== 0) fail("cluster_status_unknown");
        await pidIdentity(); await native(pgCtl, ["stop", "-D", dataDir, "-m", "fast", "-w", "-t", "30"]);
        if (await command(pgCtl, ["status", "-D", dataDir]) !== 3) fail("cluster_stop_unconfirmed"); summary.stop = "confirmed_stopped";
    }
    async function readiness(pool: ReturnType<typeof createDatabase>["pool"]) {
        const result = { account: await checkAccountDatabaseReadiness(pool, true, { moderationEnabled: true, reportsEnabled: true, checkpointMode: "record" }),
            generation: await checkGenerationDatabaseReadiness(pool, true), payments: await checkPaymentDatabaseReadiness(pool),
            rates: await checkGenerationRateDatabaseReadiness(pool), video: await checkVideoDatabaseReadiness(pool) };
        return result;
    }
    try {
        const probe = createServer(); port = await new Promise<number>((done, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => {
            const address = probe.address(); if (!address || typeof address === "string") { probe.close(); reject(new Error("loopback_port_unavailable")); return; }
            probe.close(error => error ? reject(error) : done(address.port));
        }); }); summary.port = port;
        await writeFile(passwordFile, adminPassword + "\n", { flag: "wx", mode: 0o600 });
        try { summary.phase = "initdb"; await native(initdb, ["-D", dataDir, "--username=canvas_test_admin", "--auth=scram-sha-256", "--encoding=UTF8", "--locale=C", `--pwfile=${passwordFile}`, "--no-instructions"]); }
        finally { await unlink(passwordFile); }
        startupAttempted = true; summary.phase = "start";
        await native(pgCtl, ["start", "-D", dataDir, "-l", logFile, "-w", "-t", "30", "-o", `-h 127.0.0.1 -p ${port} -c cluster_name=${clusterName}`]);
        summary.phase = "identity"; const pid = await pidIdentity();
        const admin = new Client({ host: "127.0.0.1", port, user: "canvas_test_admin", password: adminPassword, database: "postgres" });
        try {
            await admin.connect(); const identity = (await admin.query(`SELECT current_user AS username,current_database() AS database,host(inet_server_addr()) AS host,
                inet_server_port() AS port,current_setting('data_directory') AS data_directory,current_setting('server_version_num') AS version,current_setting('cluster_name') AS cluster,
                system_identifier::text,pg_postmaster_start_time()::text AS started,
                split_part(pg_read_file('postmaster.pid'),E'\n',1)::bigint::text AS file_pid,split_part(pg_read_file('postmaster.pid'),E'\n',3)::bigint::text AS file_start FROM pg_control_system()`)).rows[0];
            if (identity.username !== "canvas_test_admin" || identity.database !== "postgres" || identity.host !== "127.0.0.1" || identity.port !== port ||
                !samePath(identity.data_directory, dataDir) || identity.version !== "160015" || identity.cluster !== clusterName || !/^\d+$/.test(identity.system_identifier) ||
                identity.file_pid !== pid[0] || identity.file_start !== pid[2]) fail("admin_identity_mismatch");
            summary.identity = { ...identity, pid: Number(pid[0]), pidStartSeconds: Number(pid[2]) };
            if ((await admin.query("SELECT 1 FROM pg_database WHERE datname='canvas_saas_test' UNION ALL SELECT 1 FROM pg_roles WHERE rolname='canvas_test_app'")).rows.length) fail("fresh_role_database_required");
            await admin.query(`CREATE ROLE canvas_test_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${admin.escapeLiteral(appPassword)}`);
            await admin.query("CREATE DATABASE canvas_saas_test OWNER canvas_test_app");
            if (group.name === "migration-readiness") await admin.query("CREATE DATABASE canvas_saas_upgrade OWNER canvas_test_app");
        } finally { await admin.end(); }
        url = `postgresql://canvas_test_app:${appPassword}@127.0.0.1:${port}/canvas_saas_test`;
        if (group.name === "migration-readiness") {
            summary.phase = "formal_upgrade_32_to_33";
            const folder = join(runDir, "baseline-migrations"); await mkdir(join(folder, "meta"), { recursive: true });
            // Temporary exact historical chain: never edit an applied source migration/journal.
            for (const entry of journal.entries.slice(0, 32)) await copyFile(join(sourceRoot, "packages/database/migrations", `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
            await writeFile(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 32) }), { flag: "wx" });
            const upgrade = createDatabase(`postgresql://canvas_test_app:${appPassword}@127.0.0.1:${port}/canvas_saas_upgrade`);
            upgrade.pool.on("error", () => { summary.failure ??= "unexpected_upgrade_pool_error"; anyFailure = true; });
            try {
                await migrate(upgrade.db, { migrationsFolder: folder, migrationsSchema: "canvas_migrations" });
                const initial = (await upgrade.pool.query(`SELECT (SELECT count(*)::int FROM canvas_migrations.__drizzle_migrations) AS migrations,
                    to_regclass('canvas_saas.generation_rate_settings') IS NULL AND to_regclass('canvas_saas.generation_rate_version') IS NULL AS rates_absent`)).rows[0];
                if (initial.migrations !== 32 || initial.rates_absent !== true || await checkGenerationRateDatabaseReadiness(upgrade.pool)) fail("upgrade_baseline_must_have_32_without_rates");
                const key = `q1-upgrade-sentinel-${crypto.randomUUID()}`;
                await upgrade.pool.query("INSERT INTO canvas_saas.rate_limit(key,points,expire) VALUES ($1,7,$2)", [key, Date.now() + 3600000]);
                const before = (await upgrade.pool.query("SELECT key,points,expire::text FROM canvas_saas.rate_limit WHERE key=$1", [key])).rows;
                await migrateDatabase(upgrade.db);
                const count = (await upgrade.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows[0].count;
                const ready = await readiness(upgrade.pool);
                await migrateDatabase(upgrade.db);
                const repeated = (await upgrade.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows[0].count;
                const after = (await upgrade.pool.query("SELECT key,points,expire::text FROM canvas_saas.rate_limit WHERE key=$1", [key])).rows;
                const seed = (await upgrade.pool.query("SELECT revision,active_version_id FROM canvas_saas.generation_rate_settings WHERE id='generation'")).rows;
                const oldStatePreserved = JSON.stringify(before) === JSON.stringify(after);
                if (count !== 33 || repeated !== 33 || Object.values(ready).some(value => value !== true) || !oldStatePreserved ||
                    seed.length !== 1 || seed[0].revision !== 0 || seed[0].active_version_id !== null) fail("formal_upgrade_failed");
                summary.upgrade = { initial, migrationCount: count, repeatedMigrationCount: repeated, readiness: ready, seed, oldStatePreserved };
            } finally { await upgrade.close(); }
        }
        const database = createDatabase(url);
        database.pool.on("error", () => { summary.failure ??= "unexpected_pool_error"; anyFailure = true; });
        try {
            summary.phase = "formal_migration";
            const actual = (await database.pool.query(`SELECT current_user AS username,current_database() AS database,host(inet_server_addr()) AS host,inet_server_port() AS port,
                current_setting('server_version_num') AS version,current_setting('cluster_name') AS cluster,pg_postmaster_start_time()::text AS started,
                NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AS restricted,
                to_regnamespace('canvas_saas') IS NULL AND to_regnamespace('canvas_jobs') IS NULL AND to_regnamespace('canvas_migrations') IS NULL AS fresh FROM pg_roles WHERE rolname=current_user`)).rows[0];
            if (!summary.identity || actual.username !== "canvas_test_app" || actual.database !== "canvas_saas_test" || actual.host !== "127.0.0.1" || actual.port !== port || actual.version !== "160015" ||
                actual.cluster !== clusterName || actual.started !== summary.identity.started || actual.restricted !== true || actual.fresh !== true) fail("new_app_identity_mismatch");
            summary.appIdentity = actual;
            await migrateDatabase(database.db);
            summary.migrationCount = (await database.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows[0].count;
            await migrateDatabase(database.db);
            summary.repeatedMigrationCount = (await database.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows[0].count;
            if (summary.migrationCount !== 33 || summary.repeatedMigrationCount !== 33) fail("formal_migration_count_mismatch");
            const readyBefore = await readiness(database.pool); summary.readinessBefore = readyBefore;
            if (Object.values(readyBefore).some(value => value !== true)) fail("formal_readiness_failed");
            summary.formalPolicySchemaInstalledBeforeTests = true;
            const seed = (await database.pool.query("SELECT revision,active_version_id FROM canvas_saas.generation_rate_settings WHERE id='generation'")).rows;
            if (seed.length !== 1 || seed[0].revision !== 0 || seed[0].active_version_id !== null) fail("formal_policy_seed_mismatch");
            if (group.queue) {
                summary.phase = "explicit_local_queue_install";
                const installed = await runGenerationWorkerSchemaOperation({ env: { GENERATION_WORKER_ENABLED: "true", GENERATION_WORKER_ENVIRONMENT: "staging",
                    GENERATION_WORKER_QUEUE_URL: url, SAAS_DATABASE_URL: url, SAAS_ORIGIN: "https://synthetic-q1.example.test" }, apply: true });
                summary.queue = installed;
                if (installed.schema.state !== "ready" || installed.queue.state !== "ready" || installed.queue.settings?.policy !== "standard" || installed.queue.settings.retryLimit !== 0) fail("standard_generation_queue_required");
            }
        } finally { await database.close(); }
        summary.phase = "test";
        const env = { ...osEnvironment, SAAS_TEST_DATABASE_URL: url, Q1_D04_POSTGRES: "1", ...(group.name === "http" ? { Q1_SAFETY_POSTGRES: "1" } : {}) };
        summary.testExitCode = await command(process.execPath, ["--no-env-file", "--no-install", "test", ...group.files], env, true);
        const output = stdout + stderr; summary.passed = Number(/(?:^|\n)\s*(\d+) pass\b/.exec(output)?.[1] ?? 0);
        summary.skipped = Number(/(?:^|\n)\s*(\d+) skip/.exec(output)?.[1] ?? 0);
        if (summary.testExitCode !== 0 || !summary.passed || summary.skipped || interrupted) fail("group_test_failed_or_skipped");
        summary.phase = "postflight"; await pidIdentity();
        await assertFrozen();
        const postflight = createDatabase(url);
        postflight.pool.on("error", () => { summary.failure ??= "unexpected_pool_error"; anyFailure = true; });
        try { const readyAfter = await readiness(postflight.pool); summary.readinessAfter = readyAfter;
            if (Object.values(readyAfter).some(value => value !== true)) fail("postflight_readiness_failed"); }
        finally { await postflight.close(); }
    } catch (error) { summary.failure = safeCode(error); summary.failureStage = summary.phase; anyFailure = true; }
    finally {
        cleaningUp = true;
        try { await stop(); } catch { summary.stop = "unconfirmed_or_failed"; summary.failure ??= "cleanup_failed"; anyFailure = true; }
        try {
            if (!await absent(passwordFile)) await unlink(passwordFile);
            summary.pidFileAbsent = await absent(join(dataDir, "postmaster.pid")); summary.passwordFileAbsent = await absent(passwordFile);
        } catch { summary.failure ??= "cleanup_files_unconfirmed"; anyFailure = true; }
        if (!summary.pidFileAbsent || !summary.passwordFileAbsent) { summary.failure ??= "cleanup_files_unconfirmed"; anyFailure = true; }
        summary.completedAt = new Date().toISOString();
        await writeFile(join(groupEvidence, "test.stdout.log"), stdout, { flag: "wx" }); await writeFile(join(groupEvidence, "test.stderr.log"), stderr, { flag: "wx" });
        await writeFile(join(groupEvidence, "native.log"), redact(nativeLog), { flag: "wx" }); await writeFile(join(groupEvidence, "result.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
        console.log(JSON.stringify({ kind: "q1-policy-pg16-result", group: group.name, evidence: groupEvidence, passed: summary.passed, testExitCode: summary.testExitCode, failure: summary.failure, stop: summary.stop }));
        process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    }
    if (anyFailure) break;
}
process.exitCode = anyFailure ? 1 : 0;
