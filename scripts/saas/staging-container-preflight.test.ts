import { expect, test } from "bun:test";
import { checkStagingContainers } from "./staging-container-preflight";

const image = `sha256:${"a".repeat(64)}`;
function pair() {
    const common = { project: "infinite-canvas-staging", status: "running", health: "healthy", networks: { staging_default: {} } };
    return {
        db: { ...common, name: "/infinite-canvas-staging-db", service: "db", mounts: [{ Source: "/srv/infinite-canvas/staging/postgres", Destination: "/var/lib/postgresql/data" }] },
        api: { ...common, name: "/infinite-canvas-staging-api", service: "api", mounts: [] },
    };
}

function generationPair() {
    const { db, api } = pair();
    return {
        db, api: { ...api, image, configuredImage: image },
        worker: { ...api, name: "/infinite-canvas-staging-generation-worker-1", service: "generation-worker", health: "missing", image, configuredImage: image },
    };
}

test("reports the existing project for explicit -p without running Compose", () => {
    const { db, api } = pair();
    expect(checkStagingContainers(db, api)).toEqual({ status: "ok", issues: [], composeProject: "infinite-canvas-staging" });
});
test("blocks split Compose ownership even when both fixed-name containers are healthy", () => {
    const { db, api } = pair();
    const report = checkStagingContainers(db, { ...api, project: "agent-zh-api" });
    expect(report.status).toBe("blocked");
    expect(report).not.toHaveProperty("composeProject");
});
test("blocks a production mount, missing healthcheck, foreign identity and disconnected network", () => {
    const { db, api } = pair();
    for (const changed of [
        { ...db, mounts: [{ Source: "/srv/infinite-canvas/production/postgres", Destination: "/var/lib/postgresql/data" }] },
        { ...db, health: "missing" }, { ...db, name: "/production-db" },
        { ...db, networks: { other: {} } }, { ...db, project: "production" },
    ]) expect(checkStagingContainers(changed, api).status).toBe("blocked");
});
test("malformed Docker metadata is refused rather than treated as ready", () => {
    const { db, api } = pair();
    expect(() => checkStagingContainers({ ...db, project: null }, api)).toThrow();
});

test("blocks a shared but incorrect Compose project", () => {
    const { db, api } = pair();
    expect(checkStagingContainers({ ...db, project: "other-staging" }, { ...api, project: "other-staging" }).status).toBe("blocked");
});

test("checks the running worker against the externally pinned API image", () => {
    const { db, api, worker } = generationPair();
    expect(checkStagingContainers(db, api, { worker, expectedImage: image })).toEqual({
        status: "ok", issues: [], composeProject: "infinite-canvas-staging", generation: { image, workerRunning: true },
    });
});

test("blocks a foreign, stopped or disconnected worker", () => {
    const { db, api, worker } = generationPair();
    for (const changed of [
        { ...worker, name: "/other-worker" }, { ...worker, service: "api" },
        { ...worker, project: "other-staging" }, { ...worker, status: "exited" },
        { ...worker, health: "unhealthy" }, { ...worker, networks: { other: {} } },
    ]) {
        const report = checkStagingContainers(db, api, { worker: changed, expectedImage: image });
        expect(report.status).toBe("blocked");
        expect(report).not.toHaveProperty("generation");
    }
});

test("rejects mutable image tags, missing pins and API/worker image mismatches", () => {
    const { db, api, worker } = generationPair();
    for (const changed of [{ image: `sha256:${"b".repeat(64)}` }, { configuredImage: "canvas-api:latest" }, { image: undefined }]) {
        expect(checkStagingContainers(db, { ...api, ...changed }, { worker, expectedImage: image }).status).toBe("blocked");
        expect(checkStagingContainers(db, api, { worker: { ...worker, ...changed }, expectedImage: image }).status).toBe("blocked");
    }
    expect(() => checkStagingContainers(db, api, { worker, expectedImage: "canvas-api:latest" })).toThrow();
});

test("does not require a Compose platform manifest label to equal the image ID", () => {
    const { db, api, worker } = generationPair();
    const platformLabel = { "com.docker.compose.image": `sha256:${"b".repeat(64)}` };
    expect(checkStagingContainers(db, { ...api, labels: platformLabel }, { worker: { ...worker, labels: platformLabel }, expectedImage: image }).status).toBe("ok");
});
