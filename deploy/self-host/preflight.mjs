import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = fileURLToPath(new URL("./", import.meta.url));
const args = ["compose", "--env-file", ".env", "-f", "compose.yaml", "--profile", "migration"];
const digest = /^[^\s@]+@sha256:[a-f0-9]{64}$/;
const disabled = ["TRUSTED_PROXY", "CLOUD_CANVAS_ENABLED", "MEDIA_ENABLED", "PAYMENTS_ENABLED",
    ...["TEXT", "IMAGE", "VIDEO", "AUDIO"].map(kind => `GENERATION_${kind}_ENABLED`)];

export function validate({ services, volumes }) {
    const { web, api, db, migrate } = services;
    for (const [name, service] of Object.entries({ web, api, db, migrate })) {
        if (!digest.test(service?.image ?? "") || service.build) throw new Error(`${name}: use an image pinned by SHA-256, with no build override.`);
    }
    if (api.image !== migrate.image) throw new Error("API and migration must use the same image.");
    if (!/^(?:docker\.io\/library\/)?postgres:16(?:[.-][a-z0-9.-]+)?@sha256:[a-f0-9]{64}$/.test(db.image)) {
        throw new Error("Use the PostgreSQL 16 image listed in the release.");
    }
    if (Object.keys(services).length !== 4 || !migrate.profiles?.includes("migration") || migrate.restart !== "no") {
        throw new Error("The loopback bundle must not start migrations or a worker by default.");
    }
    if ([db, api, migrate].some(service => service.ports?.length) || web.ports?.length !== 1 || web.ports[0].host_ip !== "127.0.0.1"
        || web.ports[0].target !== 3000 || api.environment.SAAS_ORIGIN !== `http://127.0.0.1:${web.ports[0].published}`) {
        throw new Error("Only Web may publish a port, on 127.0.0.1 and matching SAAS_ORIGIN.");
    }
    if (!volumes?.postgres || !db.volumes?.some(volume => volume.type === "volume" && volume.source === "postgres" && volume.target === "/var/lib/postgresql/data")) {
        throw new Error("PostgreSQL must use its named data volume.");
    }
    const password = db.environment.POSTGRES_PASSWORD;
    if (!/^[a-f0-9]{64}$/.test(password) || /^([a-f0-9])\1+$/.test(password)) throw new Error("CANVAS_DB_PASSWORD must be a unique 32-byte hex value.");
    const databaseUrl = `postgresql://canvas:${password}@db:5432/canvas`;
    if (api.environment.SAAS_DATABASE_URL !== databaseUrl || migrate.environment.SAAS_DATABASE_URL !== databaseUrl) throw new Error("API and migrate must target this instance's database.");
    if (disabled.some(flag => api.environment[`SAAS_${flag}`] !== "false")) throw new Error("Cloud, payment, generation and trusted proxy must stay off in this bundle.");
    if (!["true", "false"].includes(api.environment.SAAS_ACCOUNTS_ENABLED)) throw new Error("CANVAS_ACCOUNTS_ENABLED must be true or false.");
    if (api.environment.SAAS_ACCOUNTS_ENABLED === "true") {
        const env = api.environment;
        const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY",
            "CAPTCHA_TIMEOUT_MS", "SMTP_CONNECTION_TIMEOUT_MS", "SMTP_SOCKET_TIMEOUT_MS"];
        if ((env.SAAS_AUTH_SECRET?.trim().length ?? 0) < 32 || env.SAAS_AUTH_SECRET === password
            || required.some(key => !env[key]?.trim())) throw new Error("Accounts require a separate auth secret, SMTP, Turnstile and timeout settings.");
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const rendered = spawnSync("docker", [...args, "config", "--format", "json"], { cwd: here, encoding: "utf8", windowsHide: true });
        if (rendered.status !== 0) throw new Error("Compose could not render the bundle. Check Docker Compose, .env and required image references.");
        let config;
        try { config = JSON.parse(rendered.stdout); }
        catch { throw new Error("Compose did not return a valid configuration."); }
        validate(config);
        console.log("Self-host configuration passed. No images were pulled and no containers were started.");
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}
