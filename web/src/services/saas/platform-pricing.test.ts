import { expect, test } from "bun:test";
import { fetchAdminPricing, fetchPlatformPricing, PlatformServiceError, type AdminPricing, type PlatformPricing } from "./platform";

const time = "2026-01-01T00:00:00.000Z";
const textPrice = (): Extract<PlatformPricing, { billingUnit: "text_tokens" }> => ({ modelId: "synthetic-text", displayName: "模拟文本", capability: "text", version: 2,
    billingUnit: "text_tokens", creditsPerUnit: null, inputCreditsPerMillion: "0.000004", outputCreditsPerMillion: "9007199254740993.000002",
    priceNote: "输入与输出分别计量", effectiveFrom: time, effectiveTo: null });
const imagePrice = (): PlatformPricing => ({ modelId: "synthetic-image", displayName: "模拟图片", capability: "image", version: 1, billingUnit: "request", creditsPerUnit: 7, effectiveFrom: time, effectiveTo: null });
const adminPrice = (): AdminPricing => ({ ...textPrice(), id: "synthetic-price", modelCatalogId: "synthetic-catalog", providerId: "synthetic-channel", providerDisplayName: "模拟渠道",
    enabled: true, providerEnabled: true, modelEnabled: true, createdAt: time, updatedAt: time });
async function withReply(items: unknown[], run: (calls: Array<{ path: string; init?: RequestInit }>) => Promise<void>) {
    const previous = globalThis.fetch, calls: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => { calls.push({ path: String(input), init }); return Response.json({ items }); }, { preconnect: previous.preconnect });
    try { await run(calls); } finally { globalThis.fetch = previous; }
}

test("public prices project exact dual-rate strings and explicit public notes, never private configuration", async () => {
    const rows = [textPrice(), imagePrice()];
    await withReply(rows.map(row => ({ ...row, rules: { cost: "private-cost" }, binding: { endpoint: "private-endpoint" }, privateNote: "private-note", credential: "private-key" })), async calls => {
        const result = await fetchPlatformPricing(); expect(result).toEqual(rows);
        expect(JSON.stringify(result)).not.toContain("private-"); expect(result[1].priceNote).toBeUndefined();
        expect(calls).toHaveLength(1); expect(calls[0].path).toBe("/api/v1/model-pricing"); expect(calls[0].init).toMatchObject({ credentials: "same-origin" });
    });
});

test("public text prices reject malformed or zero rates instead of filtering rows or treating null as zero", async () => {
    for (const patch of [
        ...[0, "0", "1.0", "-0.1", "1e-6", " 1", "1\n", null, undefined].map(inputCreditsPerMillion => ({ inputCreditsPerMillion })),
        { outputCreditsPerMillion: 4 }, { outputCreditsPerMillion: "0" }, { creditsPerUnit: 0 }, { capability: "image" }, { priceNote: null },
    ]) await withReply([imagePrice(), { ...textPrice(), ...patch }], async () => { await expect(fetchPlatformPricing()).rejects.toBeInstanceOf(PlatformServiceError); });
});

test("admin pricing history retains two immutable rates and administrative metadata without private rules", async () => {
    const row = adminPrice();
    await withReply([{ ...row, rules: { cost: "private-cost" }, privateNote: "private-note" }], async calls => {
        expect(await fetchAdminPricing()).toEqual([row]); expect(calls[0].path).toBe("/api/v1/admin/model-pricing"); expect(calls[0].init?.cache).toBe("no-store");
    });
    await withReply([{ ...row, enabled: "true" }], async () => { await expect(fetchAdminPricing()).rejects.toBeInstanceOf(PlatformServiceError); });
    for (const unit of ["request", "input_token", "output_token", "second", "megapixel"]) await withReply([{ ...imagePrice(), billingUnit: unit }], async () => {
        expect((await fetchPlatformPricing())[0]).toMatchObject({ billingUnit: unit, creditsPerUnit: 7 });
    });
});

test("cached-input public price retains the exact third rate and rejects absent-value or malformed cache fields", async () => {
    const row = { ...textPrice(), cachedInputCreditsPerMillion: "0.000001" };
    await withReply([{ ...row, rules: { cost: "private-cost" } }], async () => { expect(await fetchPlatformPricing()).toEqual([row]); });
    for (const cachedInputCreditsPerMillion of [0, "0", "0.0000010", "1e-6", "-1", null]) {
        await withReply([{ ...row, cachedInputCreditsPerMillion }], async () => { await expect(fetchPlatformPricing()).rejects.toBeInstanceOf(PlatformServiceError); });
    }
    await withReply([{ ...imagePrice(), cachedInputCreditsPerMillion: "1" }], async () => { await expect(fetchPlatformPricing()).rejects.toBeInstanceOf(PlatformServiceError); });
});

test("public text multiplier explanations stay with their publication version and discard private fields", async () => {
    const metadata = { priceVersion: 2, saleMultiplier: "0.36", creditsPerCurrency: "100", currency: "USD", unit: "million_tokens", sourceId: "openai",
        sourceVersion: 4, checkedAt: time, entryId: "openai:synthetic", officialPrices: { input: "2", cachedInput: "0.2", output: "10" } } as const;
    const row = { ...textPrice(), inputCreditsPerMillion: "72", cachedInputCreditsPerMillion: "7.2", outputCreditsPerMillion: "360", textPriceDerivation: metadata };
    await withReply([{ ...row, textPriceDerivation: { ...metadata, costMultiplier: "private-cost", endpoint: "private-endpoint" } }], async () => {
        expect(await fetchPlatformPricing()).toEqual([row]);
    });
    await withReply([{ ...row, textPriceDerivation: { ...metadata, priceVersion: 3 } }], async () => {
        await expect(fetchPlatformPricing()).rejects.toBeInstanceOf(PlatformServiceError);
    });
});
