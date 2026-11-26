import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readVideoConsumerApprovalOptions } from "../src/config";

const generation = { queueConnectionString: "postgres://api:synthetic@DB.EXAMPLE.TEST/canvas", textEnabled: true, imageEnabled: false, audioEnabled: true, videoEnabled: true };
const storage = { provider: "aliyun-oss" as const, region: "synthetic-region", bucket: "synthetic-bucket", quotaBytes: 1024, maxBytes: { image: 128, audio: 128, video: 128 } };
const env = { GENERATION_VIDEO_CONSUMER_APPROVAL_PATH: join(tmpdir(), "synthetic-video-approval.json"), GENERATION_VIDEO_CONSUMER_APPROVAL_SHA256: "a".repeat(64),
    GENERATION_VIDEO_CANDIDATE_REVISION: "b".repeat(40), GENERATION_VIDEO_IMAGE_ID: `sha256:${"c".repeat(64)}`,
    GENERATION_VIDEO_CONFIG_PLAN_SHA256: "d".repeat(64), GENERATION_VIDEO_CONFIG_READY_SHA256: "e".repeat(64) };

test("video consumer approval binds independent current configuration without opening the receipt", () => {
    const result = readVideoConsumerApprovalOptions(env, generation, storage);
    expect(result).toEqual({ path: env.GENERATION_VIDEO_CONSUMER_APPROVAL_PATH, sha256: env.GENERATION_VIDEO_CONSUMER_APPROVAL_SHA256, expected: {
        candidate: env.GENERATION_VIDEO_CANDIDATE_REVISION, image: env.GENERATION_VIDEO_IMAGE_ID, databaseTarget: "postgresql://db.example.test:5432/canvas",
        queueSchema: "canvas_jobs", queueName: "generation", payloadVersion: 1, videoProtocol: "yunfei-grok-video-v1", capabilities: ["text", "audio", "video"],
        storage: { provider: "aliyun-oss", region: "synthetic-region", bucket: "synthetic-bucket", endpoint: null },
        configPlanSha256: env.GENERATION_VIDEO_CONFIG_PLAN_SHA256, readyReceiptSha256: env.GENERATION_VIDEO_CONFIG_READY_SHA256,
    } });
    expect(JSON.stringify(result)).not.toContain("synthetic@");
});

test("missing independent approval bindings and unsafe targets cannot admit video", () => {
    for (const name of Object.keys(env) as (keyof typeof env)[]) expect(readVideoConsumerApprovalOptions({ ...env, [name]: undefined }, generation, storage)).toBeNull();
    expect(readVideoConsumerApprovalOptions({ ...env, GENERATION_VIDEO_CONSUMER_APPROVAL_PATH: "relative.json" }, generation, storage)).toBeNull();
    expect(readVideoConsumerApprovalOptions(env, { ...generation, queueConnectionString: `${generation.queueConnectionString}?host=other` }, storage)).toBeNull();
    expect(readVideoConsumerApprovalOptions(env, generation, { ...storage, region: undefined })).toBeNull();
    expect(readVideoConsumerApprovalOptions(env, generation, null)).toBeNull();
    expect(readVideoConsumerApprovalOptions({}, { ...generation, videoEnabled: false }, storage)).toBeNull();
});
