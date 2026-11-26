import { expect, test } from "bun:test";
import { handleContentSafetySettings } from "../src/content-safety-settings-handler";
import { readContentSafetyConfig } from "../src/content-safety-config";
import type { SafetyRouteContext } from "../src/account-moderation-contract";

const path = "/api/v1/admin/content-safety/settings";
const context: SafetyRouteContext = { database: null as never, actor: { actorId: "synthetic-admin", sessionId: "synthetic-session", sessionExpiresAt: new Date(Date.now() + 60000), requestId: "synthetic-request" },
    role: "admin", config: readContentSafetyConfig({}), policy: { documentBytes: 4096, pageSize: 20 } };
const request = (suffix = "", body?: unknown, method = body === undefined ? "GET" : "PUT") => new Request("http://localhost" + path + suffix,
    { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const valid = () => ({ operationId: crypto.randomUUID(), expectedRevision: 0, policy: { ip: { enabled: true, points: 10 }, user: { enabled: true, points: 50 } } });

test("settings handler leaves unrelated routes to their owner and checks role before accessing storage", async () => {
    expect(await handleContentSafetySettings(new Request("http://localhost/api/v1/admin/other"), context)).toBeNull();
    await expect(handleContentSafetySettings(request(), { ...context, role: "user" })).rejects.toMatchObject({ status: 403 });
    await expect(handleContentSafetySettings(request(), { ...context, actor: { ...context.actor, sessionId: "" } })).rejects.toMatchObject({ status: 401 });
});
test("settings writes reject injected identity, period, model and malformed policy before storage", async () => {
    for (const body of [{ ...valid(), actorId: "forged" }, { ...valid(), expectedRevision: -1 }, { ...valid(), operationId: "bad" },
        { ...valid(), policy: { ...valid().policy, ip: { enabled: true, points: 1, duration: 1 } } },
        { ...valid(), policy: { ...valid().policy, models: [] } },
        ...[0, -1, 1.5, 2147483648, "10"].map(points => ({ ...valid(), policy: { ...valid().policy, ip: { enabled: true, points } } }))]) {
        await expect(handleContentSafetySettings(request("", body), context)).rejects.toMatchObject({ status: 400, code: "rate_settings_invalid" });
    }
    await expect(handleContentSafetySettings(request("?period=day"), context)).rejects.toMatchObject({ status: 400 });
    await expect(handleContentSafetySettings(request("", undefined, "DELETE"), context)).rejects.toMatchObject({ status: 405 });
    await expect(handleContentSafetySettings(request("/operations/not-a-uuid"), context)).rejects.toMatchObject({ status: 400 });
});
test("database unavailable returns no empty or default successful settings", async () => {
    await expect(handleContentSafetySettings(request(), context)).rejects.toMatchObject({ status: 503, code: "rate_settings_unavailable" });
    await expect(handleContentSafetySettings(request("", valid()), context)).rejects.toMatchObject({ status: 503, code: "rate_settings_unavailable" });
});
