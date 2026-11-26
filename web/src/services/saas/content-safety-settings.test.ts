import { expect, spyOn, test } from "bun:test";
import { createContentSafetyClient, type ContentSafetyScope, type GenerationSafetyPolicyWrite, type GenerationSafetyPublication, type GenerationSafetySettings } from "./content-safety";

const scope: ContentSafetyScope = { accountId: "settings-synthetic-admin", epoch: 3, role: "admin" };
const id = "a1111111-1111-4111-8111-111111111111", laterId = "a2222222-2222-4222-8222-222222222222";
const config = (): GenerationSafetySettings => ({ revision: 0, publicationId: null, source: "server-default",
    policy: { ip: { enabled: true, points: 10, duration: 3600 }, user: { enabled: true, points: 50, duration: 86400 } }, modelRates: [], checkpointMode: "record" });
const write = (): GenerationSafetyPolicyWrite => ({ operationId: id, expectedRevision: 0, policy: { ip: { enabled: false, points: 20 }, user: { enabled: true, points: 60 } } });
const receipt = (): GenerationSafetyPublication => ({ operationId: id, publishedRevision: 1,
    policy: { ip: { ...write().policy.ip, duration: 3600 }, user: { ...write().policy.user, duration: 86400 } }, createdAt: "2026-10-28T12:00:00.000000Z" });
const published = (): GenerationSafetySettings => ({ ...config(), revision: 1, publicationId: id, source: "published", policy: receipt().policy });
const settings = (value: unknown = config()) => Response.json({ config: value, requestId: "settings-fixture" });
const publication = (value: unknown = receipt()) => Response.json({ receipt: value, requestId: "settings-fixture" });
function fixture(handler: (path: string, init?: RequestInit) => Response | Promise<Response>) {
    let current: ContentSafetyScope | null = { ...scope };
    const calls: { path: string; init?: RequestInit }[] = [];
    const client = createContentSafetyClient({ scope, getScope: () => current, fetcher: (async (path: RequestInfo | URL, init?: RequestInit) => { calls.push({ path: String(path), init }); return handler(String(path), init); }) as typeof fetch });
    return { client, calls, changeScope: (value: ContentSafetyScope | null) => { current = value; } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }

test("settings require an explicit baseline read and send only the complete writable policy", async () => {
    const f = fixture((_, init) => init?.method === "PUT" ? publication() : settings());
    await expect(f.client.publishSettings(write())).rejects.toMatchObject({ code: "settings_read_required", outcome: "not-sent" }); expect(f.calls).toHaveLength(0);
    expect(await f.client.readSettings()).toEqual(config());
    expect(f.calls[0]!.init).toMatchObject({ method: "GET", credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store" });
    expect(new Headers(f.calls[0]!.init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
    expect(await f.client.publishSettings(write())).toEqual(receipt());
    expect(f.calls[1]!.path).toBe("/api/v1/admin/content-safety/settings"); expect(JSON.parse(f.calls[1]!.init!.body as string)).toEqual(write());
    expect(f.client.requiresSettingsRead()).toBe(true); expect(f.client.getPendingSettingsOperation()).toBeNull();
    await expect(f.client.publishSettings({ ...write(), operationId: laterId })).rejects.toMatchObject({ code: "settings_read_required" }); expect(f.calls).toHaveLength(2);
});

test("settings read actual server values without inventing an enabled flag, period, model limit or logging mode", async () => {
    const actual = { ...config(), policy: { ip: { enabled: false, points: 27, duration: 7200 }, user: { enabled: true, points: 63, duration: 90000 } },
        modelRates: [{ modelId: "synthetic-model", points: 4, duration: 120 }], checkpointMode: "off" as const };
    const f = fixture(() => settings(actual)); expect(await f.client.readSettings()).toEqual(actual);
});

test("strict settings DTO and publication input reject bad identities, counts, modes and extra fields", async () => {
    for (const value of [{ ...config(), revision: 1 }, { ...config(), publicationId: id }, { ...published(), publicationId: null },
        { ...config(), checkpointMode: "passed" }, { ...config(), actorId: "private" }, { ...config(), policy: { ...config().policy, ip: { enabled: true, points: 0, duration: 3600 } } },
        { ...config(), modelRates: [{ modelId: "same", points: 1, duration: 1 }, { modelId: "same", points: 2, duration: 2 }] }]) {
        const f = fixture(() => settings(value)); await expect(f.client.readSettings()).rejects.toMatchObject({ code: "read_failed" }); expect(f.client.requiresSettingsRead()).toBe(true);
    }
    const f = fixture(() => settings()); await f.client.readSettings();
    for (const value of [{ ...write(), actorId: "forged" }, { ...write(), duration: 1 }, { ...write(), policy: { ...write().policy, ip: { ...write().policy.ip, duration: 3600 } } },
        { ...write(), policy: { ...write().policy, user: { enabled: true, points: "50" } } }, { ...write(), policy: { ...write().policy, ip: { enabled: true, points: 0 } } }]) {
        await expect(f.client.publishSettings(value as GenerationSafetyPolicyWrite)).rejects.toMatchObject({ code: "invalid_input", outcome: "not-sent" });
    }
    expect(f.calls).toHaveLength(1);
});

test("an unknown publication locks every new PUT and current-config read until the original receipt is found", async () => {
    let found = false;
    let requests = 0;
    const h = fixture((path, init) => ++requests === 1 ? settings() : init?.method === "PUT" ? new Response("lost ACK", { status: 502 })
        : path.includes("/operations/") ? found ? publication() : Response.json({ error: { code: "rate_settings_not_found" } }, { status: 404 }) : settings(published()));
    await h.client.readSettings(); await expect(h.client.publishSettings(write())).rejects.toMatchObject({ outcome: "unknown" });
    expect(h.client.getPendingSettingsOperation()).toEqual({ operationId: id, expectedRevision: 0 });
    await expect(h.client.publishSettings({ ...write(), operationId: laterId })).rejects.toMatchObject({ outcome: "unknown" });
    await expect(h.client.readSettings()).rejects.toMatchObject({ code: "settings_operation_pending" });
    await expect(h.client.readSettingsOperation(laterId)).rejects.toMatchObject({ code: "settings_operation_pending" });
    expect(h.calls).toHaveLength(2);
    await expect(h.client.readSettingsOperation(id)).rejects.toMatchObject({ code: "rate_settings_not_found" });
    expect(h.client.getPendingSettingsOperation()?.operationId).toBe(id); found = true;
    expect(await h.client.readSettingsOperation(id)).toEqual(receipt()); expect(h.client.requiresSettingsRead()).toBe(true);
    expect(await h.client.readSettings()).toEqual(published()); expect(h.calls.map(call => call.init?.method)).toEqual(["GET", "PUT", "GET", "GET", "GET"]);
});

test("503 remains unknown even with the known settings-unavailable code", async () => {
    const f = fixture((_, init) => init?.method === "PUT" ? Response.json({ error: { code: "rate_settings_unavailable" } }, { status: 503 }) : settings());
    await f.client.readSettings(); await expect(f.client.publishSettings(write())).rejects.toMatchObject({ outcome: "unknown" });
    expect(f.client.getPendingSettingsOperation()?.operationId).toBe(id);
});

test("publication receipts must match operation, next revision and both dimensions, with strictly valid periods", async () => {
    for (const patch of [{ operationId: laterId }, { publishedRevision: 2 }, { policy: { ...receipt().policy, ip: { ...receipt().policy.ip, points: 999 } } },
        { policy: { ...receipt().policy, user: { ...receipt().policy.user, duration: 0 } } }]) {
        const f = fixture((_, init) => init?.method === "PUT" ? publication({ ...receipt(), ...patch }) : settings());
        await f.client.readSettings(); await expect(f.client.publishSettings(write())).rejects.toMatchObject({ outcome: "unknown" }); expect(f.client.getPendingSettingsOperation()?.operationId).toBe(id);
    }
});

test("a server-controlled period change after revision-zero read confirms the original receipt and re-reads the new actual period", async () => {
    let reads = 0;
    const changedReceipt = { ...receipt(), policy: { ip: { ...receipt().policy.ip, duration: 7200 }, user: { ...receipt().policy.user, duration: 90000 } } };
    const changedActual = { ...published(), policy: changedReceipt.policy };
    const f = fixture((_, init) => init?.method === "PUT" ? publication(changedReceipt) : settings(++reads === 1 ? config() : changedActual));
    expect((await f.client.readSettings()).policy.ip.duration).toBe(3600);
    expect(await f.client.publishSettings(write())).toEqual(changedReceipt); expect(f.client.getPendingSettingsOperation()).toBeNull();
    expect(f.client.requiresSettingsRead()).toBe(true); expect(await f.client.readSettings()).toEqual(changedActual);
    expect(f.calls.map(call => call.init?.method)).toEqual(["GET", "PUT", "GET"]);
});

test("a confirmed historical publication is never used as the latest actual configuration", async () => {
    let reads = 0;
    const later: GenerationSafetySettings = { ...published(), revision: 2, publicationId: laterId, policy: { ...published().policy, user: { enabled: false, points: 70, duration: 86400 } } };
    const f = fixture((_, init) => init?.method === "PUT" ? publication() : settings(++reads === 1 ? config() : later));
    await f.client.readSettings(); expect((await f.client.publishSettings(write())).publishedRevision).toBe(1);
    expect(await f.client.readSettings()).toEqual(later);
    await expect(f.client.publishSettings({ ...write(), expectedRevision: 2 })).rejects.toMatchObject({ code: "settings_intent_used" });
    expect(f.calls.filter(call => call.init?.method === "PUT")).toHaveLength(1);
});

test("a definite revision conflict requires a fresh read and never silently rebases the original payload", async () => {
    const f = fixture((_, init) => init?.method === "PUT" ? Response.json({ error: { code: "rate_settings_conflict" } }, { status: 409 }) : settings());
    const original = write(); await f.client.readSettings(); await expect(f.client.publishSettings(original)).rejects.toMatchObject({ outcome: "rejected", code: "rate_settings_conflict" });
    expect(original).toEqual(write()); expect(f.client.requiresSettingsRead()).toBe(true); expect(f.client.getPendingSettingsOperation()).toBeNull();
    await expect(f.client.publishSettings({ ...write(), operationId: laterId })).rejects.toMatchObject({ code: "settings_read_required" }); expect(f.calls).toHaveLength(2);
});

test("ordinary roles and changed administrator epochs cannot expose or publish settings", async () => {
    const f = fixture(() => settings()); f.changeScope({ ...scope, role: "user" }); await expect(f.client.readSettings()).rejects.toMatchObject({ code: "context_changed" }); expect(f.calls).toHaveLength(0);
    const gate = deferred<Response>(), g = fixture(async () => gate.promise), reading = g.client.readSettings(); g.changeScope({ ...scope, epoch: scope.epoch + 1 }); gate.resolve(settings());
    await expect(reading).rejects.toMatchObject({ code: "context_changed" }); g.changeScope(scope); await expect(g.client.readSettings()).rejects.toMatchObject({ code: "context_changed" }); expect(g.calls).toHaveLength(1);
});

test("policy points and revisions accept the PostgreSQL integer boundary without widening the writable payload", async () => {
    const max = 2_147_483_647, baseline: GenerationSafetySettings = { ...published(), revision: max - 1, publicationId: laterId };
    const input = { ...write(), expectedRevision: max - 1, policy: { ip: { enabled: true, points: max }, user: { enabled: false, points: max } } };
    const result = { ...receipt(), publishedRevision: max, policy: { ip: { ...input.policy.ip, duration: 3600 }, user: { ...input.policy.user, duration: 86400 } } };
    let reads = 0;
    const f = fixture((_, init) => init?.method === "PUT" ? publication(result) : settings(++reads === 1 ? baseline : { ...published(), revision: max, policy: result.policy }));
    await f.client.readSettings(); expect(await f.client.publishSettings(input)).toEqual(result);
    expect((await f.client.readSettings()).revision).toBe(max);
    expect(JSON.parse(f.calls[1]!.init!.body as string).policy.ip.points).toBe(max);
});

test("policy counts and revisions above PostgreSQL integer capacity are rejected before writing or trusted display", async () => {
    const overflow = 2_147_483_648;
    for (const value of [{ ...published(), revision: overflow }, { ...config(), policy: { ...config().policy, ip: { ...config().policy.ip, points: overflow } } },
        { ...config(), modelRates: [{ modelId: "synthetic", points: overflow, duration: 60 }] }]) {
        const f = fixture(() => settings(value)); await expect(f.client.readSettings()).rejects.toMatchObject({ code: "read_failed" });
    }
    const f = fixture(() => settings()); await f.client.readSettings();
    for (const input of [{ ...write(), expectedRevision: overflow }, { ...write(), policy: { ...write().policy, user: { enabled: true, points: overflow } } }]) {
        await expect(f.client.publishSettings(input)).rejects.toMatchObject({ code: "invalid_input", outcome: "not-sent" });
    }
    expect(f.calls).toHaveLength(1);
    for (const patch of [{ publishedRevision: overflow }, { policy: { ...receipt().policy, user: { ...receipt().policy.user, points: overflow } } }]) {
        const g = fixture((_, init) => init?.method === "PUT" ? publication({ ...receipt(), ...patch }) : settings());
        await g.client.readSettings(); await expect(g.client.publishSettings(write())).rejects.toMatchObject({ outcome: "unknown" }); expect(g.client.getPendingSettingsOperation()?.operationId).toBe(id);
    }
});

test("policy durations require safe integer milliseconds and a safe absolute expiration for config, models and receipts", async () => {
    const now = 1_700_000_000_000, clock = spyOn(Date, "now").mockReturnValue(now);
    try {
        const safe = Math.floor((Number.MAX_SAFE_INTEGER - now) / 1000), millisecondsOverflow = Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1;
        const valid = { ...config(), policy: { ...config().policy, ip: { ...config().policy.ip, duration: safe } }, modelRates: [{ modelId: "synthetic", points: 1, duration: safe }] };
        expect((await fixture(() => settings(valid)).client.readSettings()).policy.ip.duration).toBe(safe);
        for (const duration of [safe + 1, millisecondsOverflow, Number.MAX_SAFE_INTEGER]) {
            for (const value of [{ ...config(), policy: { ...config().policy, user: { ...config().policy.user, duration } } },
                { ...config(), modelRates: [{ modelId: "synthetic", points: 1, duration }] }]) {
                await expect(fixture(() => settings(value)).client.readSettings()).rejects.toMatchObject({ code: "read_failed" });
            }
            const f = fixture((_, init) => init?.method === "PUT" ? publication({ ...receipt(), policy: { ...receipt().policy, ip: { ...receipt().policy.ip, duration } } }) : settings());
            await f.client.readSettings(); await expect(f.client.publishSettings(write())).rejects.toMatchObject({ outcome: "unknown" }); expect(f.client.getPendingSettingsOperation()?.operationId).toBe(id);
        }
    } finally { clock.mockRestore(); }
});
