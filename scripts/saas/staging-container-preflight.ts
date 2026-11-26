import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

type Container = {
    name: string; project: string; service: string; status: string; health: string;
    mounts: { Source: string; Destination: string }[]; networks: Record<string, unknown>;
    image?: string; configuredImage?: string;
};
const stagingProject = "infinite-canvas-staging";
const imageId = /^sha256:[a-f0-9]{64}$/;
function parseContainer(input: unknown): Container {
    assert(input && typeof input === "object" && !Array.isArray(input));
    const value = input as Record<string, unknown>;
    for (const key of ["name", "project", "service", "status", "health"]) assert(typeof value[key] === "string" && value[key]);
    assert(Array.isArray(value.mounts));
    for (const mount of value.mounts) assert(mount && typeof mount.Source === "string" && typeof mount.Destination === "string");
    assert(value.networks && typeof value.networks === "object" && !Array.isArray(value.networks));
    return value as Container;
}

/** Read-only container metadata checks, never a bootstrap or repair. */
export function checkStagingContainers(database: unknown, api: unknown, generation?: { worker: unknown; expectedImage: string }) {
    const db = parseContainer(database);
    const app = parseContainer(api);
    const issues: string[] = [];
    for (const [container, name, service] of [
        [db, "/infinite-canvas-staging-db", "db"],
        [app, "/infinite-canvas-staging-api", "api"],
    ] as const) {
        if (container.name !== name || container.service !== service) issues.push(`${service}: unexpected container identity`);
        if (container.status !== "running" || container.health !== "healthy") issues.push(`${service}: container is not running and healthy`);
    }
    if (db.project !== app.project) issues.push("API and database belong to different Compose projects; do not run up or migrate");
    if (db.project !== stagingProject) issues.push("unexpected staging Compose project");
    const data = db.mounts.filter((mount) => mount.Destination === "/var/lib/postgresql/data");
    if (data.length !== 1 || data[0].Source !== "/srv/infinite-canvas/staging/postgres") issues.push("database data mount differs from the staging directory");
    const sharedNetwork = Object.keys(db.networks).some((name) => Object.hasOwn(app.networks, name));
    if (!sharedNetwork) issues.push("API and database have no shared network");
    if (generation) {
        assert(imageId.test(generation.expectedImage), "expected image must be an immutable image ID");
        const worker = parseContainer(generation.worker);
        if (worker.name !== "/infinite-canvas-staging-generation-worker-1" || worker.service !== "generation-worker" || worker.project !== stagingProject) {
            issues.push("worker: unexpected container identity or Compose project");
        }
        // The worker has no healthcheck; running is only a process observation.
        if (worker.status !== "running") issues.push("worker: container is not running");
        if (worker.health !== "missing" && worker.health !== "healthy") issues.push("worker: healthcheck is not healthy");
        for (const [container, label] of [[app, "api"], [worker, "worker"]] as const) {
            if (!imageId.test(container.image ?? "") || container.image !== generation.expectedImage || container.configuredImage !== generation.expectedImage) {
                issues.push(`${label}: runtime and configured image must match the pinned image ID`);
            }
        }
        if (!Object.keys(db.networks).some((name) => Object.hasOwn(app.networks, name) && Object.hasOwn(worker.networks, name))) {
            issues.push("worker, API and database have no shared network");
        }
    }
    return { status: issues.length ? "blocked" : "ok", issues, ...(issues.length ? {} : {
        composeProject: db.project,
        ...(generation ? { generation: { image: generation.expectedImage, workerRunning: true } } : {}),
    }) };
}

// Select metadata only: never request Config.Env, credentials, or database rows.
const template = '{"name":{{json .Name}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"missing"{{end}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}},"image":{{json .Image}},"configuredImage":{{json .Config.Image}}}';
function inspect(name: string): Container {
    return parseContainer(JSON.parse(execFileSync("docker", ["inspect", "--format", template, name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })));
}

if (import.meta.main) {
    try {
        const args = process.argv.slice(2);
        if (args.length && (args.length !== 3 || args[0] !== "--require-worker" || args[1] !== "--expected-image" || !imageId.test(args[2]))) {
            throw new Error("expected --require-worker --expected-image sha256:<immutable image ID>");
        }
        const generation = args.length ? { worker: inspect("infinite-canvas-staging-generation-worker-1"), expectedImage: args[2] } : undefined;
        const report = checkStagingContainers(inspect("infinite-canvas-staging-db"), inspect("infinite-canvas-staging-api"), generation);
        console.log(JSON.stringify(report, null, 2));
        if (report.status !== "ok") process.exitCode = 1;
    } catch {
        console.error("Staging container preflight unavailable: check Docker access, existing containers and metadata. No changes made.");
        process.exitCode = 1;
    }
}
