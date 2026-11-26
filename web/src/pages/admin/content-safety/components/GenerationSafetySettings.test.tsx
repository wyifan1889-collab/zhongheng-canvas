import { expect, test } from "bun:test";
import { buildGenerationSafetyWrite, generationSafetyDraft, generationSafetyPeriod } from "./GenerationSafetySettings";
import type { GenerationSafetySettings } from "@/services/saas/content-safety";

const config = (): GenerationSafetySettings => ({ revision: 4, publicationId: "a1111111-1111-4111-8111-111111111111", source: "published",
    policy: { ip: { enabled: false, points: 23, duration: 7200 }, user: { enabled: true, points: 57, duration: 86400 } }, modelRates: [{ modelId: "synthetic", points: 2, duration: 100 }], checkpointMode: "off" });
const operationId = "a2222222-2222-4222-8222-222222222222";

test("draft starts from actual values and publishing excludes periods, model rules and logging mode", () => {
    const value = config(), draft = generationSafetyDraft(value.policy); draft.ip.enabled = true; draft.user.points = "62";
    expect(buildGenerationSafetyWrite(value, draft, operationId)).toEqual({ operationId, expectedRevision: 4, policy: { ip: { enabled: true, points: 23 }, user: { enabled: true, points: 62 } } });
    expect(value.policy.ip.enabled).toBe(false); expect(value.policy.user.points).toBe(57); expect(value.policy.ip.duration).toBe(7200); expect(value.modelRates).toHaveLength(1); expect(value.checkpointMode).toBe("off");
});

test("counts cannot be zero, negative, fractional, exponential, blank or silently rounded", () => {
    for (const points of ["", "0", "-1", "1.5", "1e2", "01", " 10", "10 ", "2147483648", "9007199254740992"]) {
        const value = config(), draft = generationSafetyDraft(value.policy); draft.ip.points = points;
        expect(() => buildGenerationSafetyWrite(value, draft, operationId)).toThrow("正安全整数");
    }
});

test("the form accepts the exact PostgreSQL integer maximum without rounding", () => {
    const value = config(), draft = generationSafetyDraft(value.policy); draft.user.points = "2147483647";
    expect(buildGenerationSafetyWrite(value, draft, operationId).policy.user.points).toBe(2_147_483_647);
});

test("actual periods are shown as fixed request windows, including a server override", () => {
    expect(generationSafetyPeriod(3600)).toBe("1 小时周期（3600 秒）");
    expect(generationSafetyPeriod(86400)).toBe("24 小时周期（86400 秒）");
    expect(generationSafetyPeriod(7200)).toBe("7200 秒周期（服务端配置）");
});
