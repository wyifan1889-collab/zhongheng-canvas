import { spawn } from "node:child_process";
import { access, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, like } from "drizzle-orm";
import { createAuth } from "@infinite-canvas/auth";
import { createDatabase } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";
import { auditEvent, user } from "@infinite-canvas/database/schema";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import type { PaymentPostgresMarker } from "./payment-postgres-runner";
import type { ViteDevServer } from "../../../web/node_modules/vite/dist/node/index";

const root = fileURLToPath(new URL("../../../", import.meta.url)), peer = "127.0.0.1";
const samePath = (left: string, right: string) => resolve(left).toLowerCase() === resolve(right).toLowerCase();
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
const safeCode = (error: unknown) => typeof (error as { code?: unknown })?.code === "string" && /^[A-Za-z0-9_]+$/.test((error as { code: string }).code)
    ? (error as { code: string }).code : "unclassified";

/** Fixed, synthetic, local-only UI harness. Importing this module starts nothing. */
export async function runPaymentUiFixture() {
    const allowed = new Set(["SAAS_TEST_DATABASE_URL", "SAAS_PAYMENTS_Z1_CLUSTER_MARKER"]);
    if (Object.keys(process.env).some(name => !allowed.has(name) &&
        /(?:^|_)DATABASE_URL$|^PG|^SAAS_POSTGRES_|^SAAS_TEST_|^SAAS_PAYMENTS_|^CANVAS_ACCEPTANCE_|^VITE_|^NODE_(?:PATH|OPTIONS)$|^BUN_(?:OPTIONS|PRELOAD|CONFIG_|INSTALL$)/i.test(name))) fail("ui_external_environment_rejected");
    const markerFile = process.env.SAAS_PAYMENTS_Z1_CLUSTER_MARKER, incomingUrl = process.env.SAAS_TEST_DATABASE_URL;
    if (process.platform !== "win32" || !markerFile || !incomingUrl || !isAbsolute(markerFile)) fail("ui_runner_required");
    const runParent = join(await realpath(tmpdir()), "canvas-payments-z1"), supplied = resolve(markerFile);
    if (/[^\x20-\x7e]/.test(markerFile) || basename(supplied) !== "marker.json" || !samePath(dirname(dirname(supplied)), runParent) ||
        !basename(dirname(supplied)).startsWith("run-") || !samePath(await realpath(supplied), supplied)) fail("ui_marker_location_rejected");
    const marker: PaymentPostgresMarker = JSON.parse(await readFile(markerFile, "utf8"));
    if (marker.kind !== "canvas-payments-z1-pg16" || marker.mode !== "ui" || marker.status !== "identity-verified" ||
        !/^[0-9a-f-]{36}$/.test(marker.runId) || !samePath(marker.runDir, dirname(supplied)) || !samePath(marker.dataDir, join(marker.runDir, "data")) ||
        !samePath(await realpath(marker.runDir), marker.runDir) || !samePath(await realpath(marker.dataDir), marker.dataDir) || marker.host !== peer ||
        marker.database !== "canvas_payments_z1" || marker.role !== "canvas_payments_z1_app" || !/^16[0-9]{4}$/.test(marker.serverVersionNum) ||
        !Number.isInteger(marker.port) || marker.port < 1 || marker.port > 65535 || marker.clusterName !== `canvas_payments_z1_${marker.runId.replaceAll("-", "")}` ||
        !Number.isSafeInteger(marker.postmasterPid) || !marker.postmasterPid || !Number.isSafeInteger(marker.postmasterPidStartSeconds) || !marker.postmasterPidStartSeconds ||
        !marker.postmasterStartEpoch || !marker.postmasterStart) fail("ui_marker_rejected");
    const target = new URL(incomingUrl);
    if (target.protocol !== "postgresql:" || target.hostname !== peer || Number(target.port) !== marker.port || target.username !== marker.role ||
        !target.password || target.pathname !== `/${marker.database}` || target.search || target.hash) fail("ui_database_url_rejected");
    const applicationName = `payment_z1_${marker.runId.replaceAll("-", "")}_ui`;
    target.searchParams.set("application_name", applicationName);
    const database = createDatabase(target.href), realFetch = globalThis.fetch;
    let vite: ViteDevServer | undefined, server: ReturnType<typeof Bun.serve> | undefined, origin = "", viteOrigin = "";
    let phase = "identity", failure: string | null = null, armed = false, blockedExternalFetches = 0, stopReason = "not_stopped";
    let migration: Record<string, unknown> | null = null, adminId: string | null = null, bootstrap: Promise<Response> | undefined;
    const injections: Record<string, unknown>[] = [], faults: Record<string, string>[] = [], poolErrors: string[] = [];
    database.pool.on("error", error => { poolErrors.push(safeCode(error)); });
    const secret = crypto.randomUUID() + crypto.randomUUID(), password = `synthetic-ui-${crypto.randomUUID()}`;
    const mail = { secret, sendVerificationEmail: async () => {}, sendResetPassword: async () => {} };
    const stopped = Promise.withResolvers<void>();
    const stop = (reason: string) => { stopReason = reason; stopped.resolve(); };
    const signalStop = () => stop("process_signal");
    let stopTimer: ReturnType<typeof setInterval> | undefined;
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
    const identitySql = `SELECT host(inet_server_addr()) AS host, inet_server_port() AS port, current_database() AS database,
        current_user AS role, current_setting('server_version_num') AS version, current_setting('cluster_name') AS cluster,
        pg_postmaster_start_time()::text AS started, extract(epoch FROM pg_postmaster_start_time())::text AS epoch,
        current_setting('application_name') AS application,
        (SELECT NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user) AS restricted`;
    async function verifyIdentity() {
        const actual = (await database.pool.query(identitySql)).rows[0];
        if (!actual || actual.host !== peer || actual.port !== marker.port || actual.database !== marker.database || actual.role !== marker.role ||
            actual.version !== marker.serverVersionNum || actual.cluster !== marker.clusterName || actual.started !== marker.postmasterStart ||
            actual.epoch !== marker.postmasterStartEpoch || actual.application !== applicationName || actual.restricted !== true) fail("ui_actual_database_identity_mismatch");
        const pid = (await readFile(join(marker.dataDir, "postmaster.pid"), "utf8")).split(/\r?\n/);
        if (Number(pid[0]) !== marker.postmasterPid || !samePath(pid[1] ?? "", marker.dataDir) || Number(pid[2]) !== marker.postmasterPidStartSeconds ||
            Number(pid[3]) !== marker.port || pid[5] !== peer || JSON.stringify(JSON.parse(await readFile(markerFile!, "utf8"))) !== JSON.stringify(marker)) fail("ui_server_marker_changed");
    }
    try {
        // Guard before any application/Vite startup, including accidental provider transport use.
        globalThis.fetch = Object.assign((source: Parameters<typeof fetch>[0], init?: RequestInit) => {
            const url = new URL(source instanceof Request ? source.url : String(source));
            if (!viteOrigin || url.origin !== viteOrigin || init?.redirect !== "manual") { blockedExternalFetches++; return Promise.reject(Object.assign(new Error(), { code: "ui_external_fetch_rejected" })); }
            return realFetch(source, init);
        }, { preconnect() { fail("ui_preconnect_rejected"); } }) as typeof fetch;
        await verifyIdentity();
        if ((await database.pool.query("SELECT to_regnamespace('canvas_saas') IS NULL AND to_regnamespace('canvas_migrations') IS NULL AND to_regnamespace('canvas_jobs') IS NULL AS fresh")).rows[0]?.fresh !== true) fail("ui_fresh_database_required");
        phase = "migrations";
        await migrateDatabase(database.db); await verifyIdentity();
        const after = (await database.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows[0].count;
        const journal = JSON.parse(await readFile(new URL("../../../packages/database/migrations/meta/_journal.json", import.meta.url), "utf8"));
        if (after !== 32 || after !== journal.entries.length) fail("ui_formal_32_migrations_required");
        await migrateDatabase(database.db); await verifyIdentity();
        const repeated = (await database.pool.query("SELECT count(*)::int AS count FROM canvas_migrations.__drizzle_migrations")).rows[0].count;
        if (repeated !== after) fail("ui_repeat_migration_changed");
        migration = { before: 0, after, repeated, verifiedIdentity: true, serverVersionNum: marker.serverVersionNum };
        phase = "certificate";
        // Existing bundled PowerShell/.NET only. CertificateRequest never writes a certificate store.
        const powershell = join(process.env.USERPROFILE ?? "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "native", "powershell", "pwsh.exe");
        if (!isAbsolute(powershell) || !samePath(await realpath(powershell), powershell)) fail("ui_existing_certificate_tool_required");
        const certificateScript = join(marker.runDir, "create-ui-certificate.ps1");
        await writeFile(certificateScript, `param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$taskRsa = [System.Security.Cryptography.RSA]::Create(2048)
try {
    $taskRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new('CN=127.0.0.1', $taskRsa, [System.Security.Cryptography.HashAlgorithmName]::SHA256, [System.Security.Cryptography.RSASignaturePadding]::Pkcs1)
    $taskSan = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $taskSan.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1')); $taskSan.AddDnsName('localhost')
    $taskRequest.CertificateExtensions.Add($taskSan.Build())
    $taskCertificate = $taskRequest.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-5), [DateTimeOffset]::UtcNow.AddDays(1))
    try {
        [System.IO.File]::WriteAllText([System.IO.Path]::Combine($OutputDirectory, 'ui-cert.pem'), [System.Security.Cryptography.PemEncoding]::WriteString('CERTIFICATE', $taskCertificate.RawData))
        [System.IO.File]::WriteAllText([System.IO.Path]::Combine($OutputDirectory, 'ui-key.pem'), [System.Security.Cryptography.PemEncoding]::WriteString('PRIVATE KEY', $taskRsa.ExportPkcs8PrivateKey()))
    } finally { $taskCertificate.Dispose() }
} finally { $taskRsa.Dispose() }
`, { flag: "wx" });
        const certExit = await new Promise<number | null>((done, reject) => {
            const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", certificateScript, marker.runDir], { cwd: marker.runDir, env: process.env, windowsHide: true, shell: false, stdio: "ignore" });
            const deadline = setTimeout(() => { child.kill(); reject(Object.assign(new Error(), { code: "ui_certificate_timeout" })); }, 15_000);
            child.once("error", error => { clearTimeout(deadline); reject(error); });
            child.once("close", code => { clearTimeout(deadline); done(code); });
        });
        if (certExit !== 0) fail("ui_certificate_failed");
        phase = "vite";
        const { createServer } = await import("../../../web/node_modules/vite/dist/node/index.js");
        vite = await createServer({ root: join(root, "web"), configFile: join(root, "web", "vite.config.ts"), configLoader: "native", envFile: false, envDir: false,
            cacheDir: join(marker.runDir, "vite-cache"), clearScreen: false, logLevel: "error", server: { host: peer, port: 0, hmr: false, watch: null, cors: false, proxy: {},
                fs: { strict: true, deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/marker.json", "**/create-ui-certificate.ps1"] } } });
        await vite.listen();
        const address = vite.httpServer?.address();
        if (!address || typeof address === "string" || address.address !== peer) fail("ui_vite_loopback_required");
        viteOrigin = `http://${peer}:${address.port}`;
        phase = "https";
        let app: ReturnType<typeof createApp> | undefined;
        server = Bun.serve({ hostname: peer, port: 0, tls: { cert: Bun.file(join(marker.runDir, "ui-cert.pem")), key: Bun.file(join(marker.runDir, "ui-key.pem")) },
            fetch: async (request, serving) => {
                try {
                    const url = new URL(request.url), remote = serving.requestIP(request)?.address;
                    if (remote !== peer || url.origin !== origin || request.headers.has("origin") && request.headers.get("origin") !== origin) return json({ error: "fixture_loopback_only" }, 403);
                    if (!app) return json({ error: "fixture_initializing" }, 503);
                    if (url.pathname.startsWith("/__fixture/")) {
                        if (url.search) return json({ error: "fixture_invalid_input" }, 400);
                        if (url.pathname === "/__fixture/login" && request.method === "GET") {
                            // This is the only bootstrap seam; real auth creates and signs the synthetic session.
                            if (!bootstrap) bootstrap = (async () => {
                                const auth = createAuth({ database: database.db, baseURL: origin, ...mail });
                                const email = `payment-ui-${marker.runId}@example.test`;
                                const invoke = (path: string, body: object) => auth.handler(new Request(`${origin}/api/auth/${path}`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) }));
                                const signed = await invoke("sign-up/email", { name: "合成支付后台验收账号", email, password });
                                if (signed.status !== 200) fail("ui_synthetic_signup_failed");
                                const [owner] = await database.db.select({ id: user.id }).from(user).where(eq(user.email, email));
                                if (!owner) fail("ui_synthetic_user_missing");
                                await database.db.update(user).set({ emailVerified: true, role: "admin" }).where(eq(user.id, owner.id)); adminId = owner.id;
                                const login = await invoke("sign-in/email", { email, password });
                                if (login.status !== 200 || !login.headers.getSetCookie().length) fail("ui_synthetic_login_failed");
                                const headers = new Headers({ location: "/admin", "cache-control": "no-store" });
                                for (const cookie of login.headers.getSetCookie()) headers.append("set-cookie", cookie);
                                return new Response(null, { status: 302, headers });
                            })();
                            return (await bootstrap).clone();
                        }
                        if (url.pathname === "/__fixture/stop" && request.method === "POST") { setTimeout(() => stop("explicit_loopback_stop"), 50); return json({ stopping: true }); }
                        // Arm/state require the current real admin session; no fixture auth impersonation.
                        const headers = new Headers(request.headers); headers.set("x-canvas-account-id", adminId ?? "fixture_not_bootstrapped");
                        const configuration = await app(new Request(`${origin}/api/v1/admin/payments/config`, { headers }), peer);
                        if (configuration.status !== 200) return json({ error: "fixture_admin_required" }, configuration.status);
                        const config = (await configuration.json()).config;
                        if (url.pathname === "/__fixture/arm-merchant-response-loss" && request.method === "POST") { armed = true; return json({ armed: true, boundary: "after_actual_merchant_PUT_commit_and_success_response" }); }
                        if (url.pathname === "/__fixture/state" && request.method === "GET") {
                            await verifyIdentity();
                            const audits = await database.db.select({ id: auditEvent.id, action: auditEvent.action, resourceId: auditEvent.resourceId, revision: auditEvent.revision, requestId: auditEvent.requestId }).from(auditEvent).where(like(auditEvent.action, "payment.%"));
                            return json({ synthetic: true, runtimeEnabled: false, config, audits, injection: { armed, delivered: injections }, blockedExternalFetches, poolErrors });
                        }
                        return json({ error: "fixture_not_found" }, 404);
                    }
                    if (url.pathname.startsWith("/api/")) {
                        const response = await app(request, peer);
                        if (armed && request.method === "PUT" && url.pathname === "/api/v1/admin/payments/merchant" && response.status === 200) {
                            armed = false;
                            injections.push({ operationId: request.headers.get("idempotency-key"), apiStatus: 200, deliveredStatus: 503, boundary: "local_fixture_after_actual_API_commit" });
                            return json({ error: { code: "service_unavailable", message: "合成回执未送达，请核对原操作" } }, 503);
                        }
                        return response;
                    }
                    if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "fixture_method_not_allowed" }, 405);
                    // Fixed loopback upstream only; never send cookies, keys or arbitrary target URLs to Vite.
                    const response = await fetch(`${viteOrigin}${url.pathname}${url.search}`, { method: request.method, headers: { accept: request.headers.get("accept") ?? "*/*" }, redirect: "manual" });
                    const headers = new Headers(response.headers); headers.set("cache-control", "no-store");
                    return new Response(response.body, { status: response.status, headers });
                } catch (error) { faults.push({ phase: "request", code: safeCode(error) }); return json({ error: "fixture_unavailable" }, 503); }
            } });
        origin = `https://${peer}:${server.port}`;
        if (server.port === marker.port || server.port === address.port) fail("ui_service_ports_must_differ");
        const denyProvider = Object.assign(async (): Promise<Response> => { blockedExternalFetches++; return fail("ui_provider_fetch_rejected"); }, { preconnect() { fail("ui_provider_preconnect_rejected"); } }) as typeof fetch;
        app = createApp(createAccountApi({ database: database.db, origin, auth: mail, payments: { enabled: false }, paymentFetcher: denyProvider,
            rates: { consume: async () => ({ allowed: true }) }, verifyHuman: async () => true,
            onFault: event => faults.push({ phase: "accounts", code: event.code, requestId: event.requestId }) }), "synthetic-fixture-captcha-site-key");
        process.once("SIGINT", signalStop); process.once("SIGTERM", signalStop);
        stopTimer = setInterval(() => { void access(join(marker.runDir, "ui-stop.request")).then(() => stop("runner_stop_file"), () => {}); }, 250);
        phase = "ready";
        const ready = { kind: "payments-z1-ui-ready", runId: marker.runId, runDir: marker.runDir, origin, loginUrl: `${origin}/__fixture/login`,
            stateUrl: `${origin}/__fixture/state`, armUrl: `${origin}/__fixture/arm-merchant-response-loss`, stopUrl: `${origin}/__fixture/stop`,
            synthetic: true, paymentsEnabled: false, initialMerchant: null, initialOffers: [], certificate: "self-signed-only-no-system-trust", vitePort: address.port, postgresPort: marker.port };
        await writeFile(join(marker.runDir, "payment-ui-ready.json"), JSON.stringify(ready, null, 2) + "\n", { flag: "wx" });
        console.log(JSON.stringify(ready));
        await stopped.promise;
        await verifyIdentity();
    } catch (error) { failure = safeCode(error); throw error; }
    finally {
        if (stopTimer) clearInterval(stopTimer);
        process.removeListener("SIGINT", signalStop); process.removeListener("SIGTERM", signalStop);
        const cleanup = { tls: false, vite: false, pool: false };
        try { await server?.stop(true); cleanup.tls = true; }
        finally {
            try { await vite?.close(); cleanup.vite = true; }
            finally {
                try { await database.close(); cleanup.pool = true; }
                finally {
                    globalThis.fetch = realFetch;
                    await writeFile(join(marker.runDir, "payment-ui-evidence.json"), JSON.stringify({ kind: "payments-z1-pg16-ui", synthetic: true,
                        runId: marker.runId, phase, failure, stopReason, migration, origin, realZpay: false, realMailCaptcha: false,
                        tls: "synthetic-self-signed-no-system-store", paymentsEnabled: false, blockedExternalFetches, injections, faults, poolErrors, cleanup }, null, 2) + "\n", { flag: "wx" });
                }
            }
        }
    }
}

if (import.meta.main) {
    try { await runPaymentUiFixture(); }
    catch (error) { console.error(JSON.stringify({ kind: "payments-z1-ui-error", code: safeCode(error) })); process.exitCode = 1; }
}
