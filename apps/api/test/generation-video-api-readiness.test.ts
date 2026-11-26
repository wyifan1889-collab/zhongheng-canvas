import { expect, test } from "bun:test";
import { createVideoApiReadiness } from "../src/generation-video-api-readiness";
import type { VideoRuntimePolicy } from "../src/generation-video-config";

const identity = { ffprobeSha256: "a".repeat(64), ffmpegSha256: "b".repeat(64), version: "synthetic", license: "synthetic", sourceUrl: "https://example.test/tools" };
const policy = {} as VideoRuntimePolicy; // No real tool is inspected by these gate fixtures.
const database = { query: async () => { throw new Error("fixture must not open a database"); } };

test("an installed queue or resource configuration cannot replace compatible-consumer proof", async () => {
    const gate = createVideoApiReadiness({ database, policy, toolchainIdentity: identity,
        checkDatabase: async () => { throw new Error("missing proof must keep the launch gate closed"); } });
    expect(await gate()).toBe(false);
});

test("video readiness rechecks structural, tool and consumer evidence and closes on revocation", async () => {
    const state = { consumers: true, schema: true, tools: true };
    const gate = createVideoApiReadiness({ database, policy, toolchainIdentity: identity,
        compatibleConsumers: async () => state.consumers, checkDatabase: async () => state.schema,
        inspectTools: async () => ({ ready: state.tools, platform: "fixture", reasons: [] }) });
    expect(await gate()).toBe(true);
    for (const field of ["consumers", "schema", "tools"] as const) {
        state[field] = false; expect(await gate()).toBe(false); state[field] = true;
    }
    expect(await gate()).toBe(true);
});

test("unavailable evidence cannot leave video readiness open", async () => {
    const gate = createVideoApiReadiness({ database, policy, toolchainIdentity: identity,
        compatibleConsumers: async () => { throw new Error("synthetic proof outage"); } });
    expect(await gate()).toBe(false);
    expect(await createVideoApiReadiness({ database, policy, toolchainIdentity: null, compatibleConsumers: async () => true })()).toBe(false);
});
