import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { createApprovedConsumerCheck, type ApprovedConsumerExpected } from "../src/generation-approved-consumers";
import { canonicalPostgresTarget } from "../src/generation-worker-config";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const expected = (): ApprovedConsumerExpected => ({ candidate: "a".repeat(40), image: `sha256:${"b".repeat(64)}`,
    databaseTarget: canonicalPostgresTarget("postgres://synthetic:never-connect@localhost:65432/approval_fixture", "fixture"),
    queueSchema: "canvas_jobs", queueName: "generation", payloadVersion: 1, videoProtocol: "yunfei-grok-video-v1",
    capabilities: ["text", "image", "audio", "video"], storage: { provider: "aliyun-oss", region: "synthetic-region", bucket: "synthetic-bucket", endpoint: null },
    configPlanSha256: "c".repeat(64), readyReceiptSha256: "d".repeat(64) });
const receipt = (identity = expected()) => ({ schemaVersion: 1, status: "approved", ...identity,
    approval: { allConsumersReviewed: true, oldConsumersExited: true, reference: "synthetic operator approval reference" } });
async function fixture(action: (f: { root: string; path: string; write: (value: unknown) => Promise<string>; raw: (value: string | Uint8Array) => Promise<string> }) => Promise<void>) {
    const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, "canvas-approved-consumers-"));
    if (!isAbsolute(root) || !root.startsWith(parent + sep)) throw new Error("Fixture directory escaped the selected temporary parent");
    const path = join(root, "approval.json");
    const raw = async (value: string | Uint8Array) => { await writeFile(path, value); return hash(value); };
    try { await action({ root, path, raw, write: value => raw(JSON.stringify(value)) }); }
    finally { await rm(path, { force: true }); await rmdir(root); }
}

test("operator approval checks both strict storage contracts and the fixed enabled capability subset", async () => {
    await fixture(async f => {
        for (const identity of [expected(), { ...expected(), capabilities: ["video"] as const,
            storage: { provider: "server-disk" as const, rootDirectory: f.root } }]) {
            const value = { ...identity, capabilities: [...identity.capabilities] };
            const pin = await f.write(receipt(value));
            expect(await createApprovedConsumerCheck({ path: f.path, sha256: pin, expected: value })()).toBe(true);
        }
    });
});

test("every check rereads the exact bytes: deletion, replacement and an incorrect pin revoke an earlier true", async () => {
    await fixture(async f => {
        const pin = await f.write(receipt()), check = createApprovedConsumerCheck({ path: f.path, sha256: pin, expected: expected() });
        expect(await check()).toBe(true);
        const bytes = await readFile(f.path); await writeFile(f.path, Buffer.concat([bytes, Buffer.from("\n")]));
        expect(await check()).toBe(false);
        await writeFile(f.path, bytes); expect(await check()).toBe(true);
        await rm(f.path); expect(await check()).toBe(false);
        await writeFile(f.path, bytes); expect(await createApprovedConsumerCheck({ path: f.path, sha256: "0".repeat(64), expected: expected() })()).toBe(false);
    });
});

test("candidate, image, canonical database, queue, protocol, capabilities, storage and evidence hashes match caller identity", async () => {
    await fixture(async f => {
        const patches: Record<string, unknown>[] = [
            { candidate: "e".repeat(40) }, { image: `sha256:${"e".repeat(64)}` }, { databaseTarget: "postgresql://localhost:65432/other_fixture" },
            { queueSchema: "other_jobs" }, { queueName: "other" }, { payloadVersion: 2 }, { videoProtocol: "different-protocol" },
            { capabilities: ["video"] }, { capabilities: ["text", "video"] }, { capabilities: ["image", "audio", "video"] },
            { storage: { provider: "aliyun-oss", region: "other", bucket: "synthetic-bucket", endpoint: null } },
            { storage: { provider: "aliyun-oss", region: "synthetic-region", bucket: "other", endpoint: null } },
            { storage: { provider: "aliyun-oss", region: "synthetic-region", bucket: "synthetic-bucket", endpoint: "https://other.invalid" } },
            { storage: { provider: "server-disk", rootDirectory: f.root } },
            { configPlanSha256: "e".repeat(64) }, { readyReceiptSha256: "e".repeat(64) },
        ];
        for (const patch of patches) {
            const pin = await f.write({ ...receipt(), ...patch });
            expect(await createApprovedConsumerCheck({ path: f.path, sha256: pin, expected: expected() })()).toBe(false);
        }
        const disk = { ...expected(), storage: { provider: "server-disk" as const, rootDirectory: f.root } };
        const pin = await f.write(receipt({ ...disk, storage: { ...disk.storage, rootDirectory: join(f.root, "other") } }));
        expect(await createApprovedConsumerCheck({ path: f.path, sha256: pin, expected: disk })()).toBe(false);
    });
});

test("missing, extra, malformed and unapproved receipt fields never become ready even under a matching raw hash", async () => {
    await fixture(async f => {
        const value = receipt();
        const invalid: unknown[] = [[], null, { ...value, schemaVersion: "1" }, { ...value, status: "pending" },
            { ...value, candidate: "a".repeat(39) }, { ...value, image: "b".repeat(64) }, { ...value, configPlanSha256: "bad" },
            { ...value, readyReceiptSha256: 1 }, { ...value, capabilities: ["text", "image", "audio"] }, { ...value, capabilities: ["video", "video"] },
            { ...value, capabilities: ["video", "text"] }, { ...value, capabilities: "video" }, { ...value, capabilities: ["video", "unknown"] },
            { ...value, credential: "synthetic-sensitive-value" }, { ...value, storage: { ...value.storage, accessKey: "synthetic-sensitive-value" } },
            { ...value, approval: { ...value.approval, allConsumersReviewed: false } }, { ...value, approval: { ...value.approval, oldConsumersExited: false } },
            { ...value, approval: { ...value.approval, reference: " " } }, { ...value, approval: { ...value.approval, detectedAlive: true } },
            ...Object.keys(value).map(key => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))),
        ];
        for (const row of invalid) {
            const pin = await f.write(row);
            expect(await createApprovedConsumerCheck({ path: f.path, sha256: pin, expected: expected() })()).toBe(false);
        }
    });
});

test("duplicate decoded JSON members, comments, trailing commas and invalid UTF8 are rejected locally", async () => {
    await fixture(async f => {
        const raw = JSON.stringify(receipt());
        const invalid = [raw.replace('"status":"approved"', '"status":"approved","status":"approved"'),
            raw.replace('"bucket":"synthetic-bucket"', '"bucket":"synthetic-bucket","bucket":"synthetic-bucket"'),
            raw.replace('"reference":"synthetic operator approval reference"', '"reference":"synthetic operator approval reference","\\u0072eference":"synthetic operator approval reference"'),
            raw.replace("{", "{/*comment*/"), raw.slice(0, -1) + ",}", Buffer.from([0xff, 0xfe]), ""];
        for (const value of invalid) {
            const pin = await f.raw(value);
            expect(await createApprovedConsumerCheck({ path: f.path, sha256: pin, expected: expected() })()).toBe(false);
        }
    });
});

test("bad options and unreadable targets return false without exposing paths, content or exceptions", async () => {
    await fixture(async f => {
        const pin = await f.write(receipt());
        for (const options of [
            { path: "relative-approval.json", sha256: pin, expected: expected() },
            { path: f.root, sha256: pin, expected: expected() },
            { path: f.path, sha256: "bad", expected: expected() },
            { path: f.path, sha256: pin, expected: { ...expected(), capabilities: ["image"] } },
            { path: f.path, sha256: pin, expected: { ...expected(), storage: { provider: "server-disk", rootDirectory: "relative" } } },
            { path: f.path, sha256: pin, expected: { ...expected(), injected: "synthetic-sensitive-value" } },
        ]) expect(await createApprovedConsumerCheck(options as Parameters<typeof createApprovedConsumerCheck>[0])()).toBe(false);
    });
});

test("the caller's expected snapshot is captured independently from later mutable config objects", async () => {
    await fixture(async f => {
        const identity = expected(), pin = await f.write(receipt(identity));
        const check = createApprovedConsumerCheck({ path: f.path, sha256: pin, expected: identity });
        identity.candidate = "e".repeat(40); identity.capabilities.pop(); identity.storage = { provider: "server-disk", rootDirectory: f.root };
        expect(await check()).toBe(true);
    });
});
