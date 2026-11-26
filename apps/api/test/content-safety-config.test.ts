import { expect, test } from "bun:test";
import { readContentSafetyConfig } from "../src/content-safety-config";

test("D04 enables approved generation defaults while moderation and reports remain separately gated", () => {
    expect(readContentSafetyConfig({})).toEqual({
        moderationEnabled: false, reportsEnabled: false, checkpointMode: "record",
        generationPolicyDefaults: { ip: { enabled: true, points: 10, duration: 3600 }, user: { enabled: true, points: 50, duration: 86400 } },
        generationRates: { ip: { points: 10, duration: 3600 }, user: { points: 50, duration: 86400 }, models: [] },
    });
    expect(readContentSafetyConfig({
        SAAS_GENERATION_IP_RATE_ENABLED: "false", SAAS_GENERATION_IP_RATE_POINTS: "7",
        SAAS_GENERATION_IP_RATE_DURATION_SECONDS: "11", SAAS_GENERATION_MODEL_RATES: "[]",
        SAAS_GENERATION_USER_RATE_ENABLED: "false",
    }).generationRates).toEqual({ ip: null, user: null, models: [] });
    expect(readContentSafetyConfig({ SAAS_GENERATION_IP_RATE_ENABLED: "false", SAAS_GENERATION_IP_RATE_POINTS: "7" })
        .generationPolicyDefaults.ip).toEqual({ enabled: false, points: 7, duration: 3600 });
    expect(readContentSafetyConfig({ SAAS_CONTENT_SAFETY_MODE: "off" }).checkpointMode).toBe("off");
});

test("safety flags and checkpoint mode reject unsupported or ambiguous opt-ins", () => {
    for (const name of ["SAAS_ACCOUNT_MODERATION_ENABLED", "SAAS_ABUSE_REPORTS_ENABLED", "SAAS_GENERATION_IP_RATE_ENABLED", "SAAS_GENERATION_USER_RATE_ENABLED"]) {
        for (const value of ["", "TRUE", "yes", "1", "true "]) {
            expect(() => readContentSafetyConfig({ [name]: value })).toThrow(name);
        }
    }
    for (const value of ["", "blocking", "reject", "Record", "record "]) {
        expect(() => readContentSafetyConfig({ SAAS_CONTENT_SAFETY_MODE: value })).toThrow("SAAS_CONTENT_SAFETY_MODE");
    }
    expect(readContentSafetyConfig({ SAAS_ACCOUNT_MODERATION_ENABLED: "true", SAAS_ABUSE_REPORTS_ENABLED: "true",
        SAAS_CONTENT_SAFETY_MODE: "record" })).toMatchObject({ moderationEnabled: true, reportsEnabled: true, checkpointMode: "record" });
});

test("IP and user overrides retain valid fixed seconds and reject malformed explicit values even when disabled", () => {
    const env = { SAAS_GENERATION_IP_RATE_ENABLED: "true", SAAS_GENERATION_IP_RATE_POINTS: "7", SAAS_GENERATION_IP_RATE_DURATION_SECONDS: "11" };
    expect(readContentSafetyConfig(env).generationRates.ip).toEqual({ points: 7, duration: 11 });
    expect(readContentSafetyConfig({ SAAS_GENERATION_USER_RATE_POINTS: "91", SAAS_GENERATION_USER_RATE_DURATION_SECONDS: "137" })
        .generationRates.user).toEqual({ points: 91, duration: 137 });
    for (const name of ["SAAS_GENERATION_IP_RATE_POINTS", "SAAS_GENERATION_IP_RATE_DURATION_SECONDS", "SAAS_GENERATION_USER_RATE_POINTS", "SAAS_GENERATION_USER_RATE_DURATION_SECONDS"]) {
        for (const value of ["", "0", "-1", "1.5", "1e3", " 7", "9007199254740992", "private-config-value"]) {
            expect(() => readContentSafetyConfig({ ...env, [name]: value })).toThrow(name);
            expect(() => readContentSafetyConfig({ ...env, SAAS_GENERATION_IP_RATE_ENABLED: "false", SAAS_GENERATION_USER_RATE_ENABLED: "false", [name]: value })).toThrow(name);
        }
    }
    expect(() => readContentSafetyConfig({ SAAS_GENERATION_USER_RATE_POINTS: "2147483648" })).toThrow("SAAS_GENERATION_USER_RATE_POINTS");
    expect(() => readContentSafetyConfig({ SAAS_GENERATION_IP_RATE_DURATION_SECONDS: "9007199254740" })).toThrow("SAAS_GENERATION_IP_RATE_DURATION_SECONDS");
});

test("model rates require exact distinct identifiers and strictly shaped numeric rules", () => {
    const rules = [{ modelId: "synthetic-model-a", points: 3, duration: 17 }, { modelId: "synthetic-model-b", points: 2, duration: 19 }];
    expect(readContentSafetyConfig({ SAAS_GENERATION_MODEL_RATES: JSON.stringify(rules) }).generationRates.models).toEqual(rules);
    for (const value of ["", "not-json", "null", "{}", "[{}]", JSON.stringify([rules[0], rules[0]]),
        ...["", " synthetic-model", "model\nname"].map(modelId => JSON.stringify([{ ...rules[0], modelId }])),
        ...[0, -1, 1.2, 9007199254740992, "2"].flatMap(value => [
            JSON.stringify([{ ...rules[0], points: value }]), JSON.stringify([{ ...rules[0], duration: value }]),
        ]), JSON.stringify([{ ...rules[0], concurrent: 2 }])]) {
        expect(() => readContentSafetyConfig({ SAAS_GENERATION_MODEL_RATES: value })).toThrow("SAAS_GENERATION_MODEL_RATES");
    }
});

test("invalid settings never echo environment values or surrounding secrets", () => {
    for (const env of [
        { SAAS_GENERATION_MODEL_RATES: 'private-secret-and-broken-json' },
        { SAAS_GENERATION_MODEL_RATES: '[{"modelId":"private-secret","points":0,"duration":1}]' },
        { SAAS_GENERATION_IP_RATE_ENABLED: "private-secret" },
    ]) {
        try { readContentSafetyConfig({ ...env, SAAS_AUTH_SECRET: "private-secret" }); throw new Error("expected invalid config"); }
        catch (error) { expect(String(error)).not.toContain("private-secret"); }
    }
});
