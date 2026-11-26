import { expect, test } from "bun:test";
import { parseOfficialPriceDocument, fetchOfficialPriceEntries } from "../src/official-price-sources";
import { parseAdminOfficialPriceCatalog, parseOfficialPriceMappingWrite, parsePublicOfficialPriceReferences } from "@infinite-canvas/shared";

// Synthetic document fixtures exercise the verified official table layouts; these are not official prices.
const openai = `Prices per 1M tokens.
### Standard pricing data
| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-test | $2.00 | $10.00 | $0.1 | $2.50 | $5 | $4 | $15 | $0.2 | $5 | $10 |

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-other | $1 | $4 | - |
### Batch pricing data
| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-other | $0.5 | $2 | - |
Short context: ≤272K input tokens. Long context: >272K input tokens.
### Standard pricing data
| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-cyber | $99 | $99 | - |
`;
const anthropic = `All prices are in USD.
## Model pricing
| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| --- | --- | --- | --- | --- | --- |
| Claude Sample 1 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.05 / MTok<sup>1</sup> | $10 / MTok |
| Claude Sample 2 (for prompts up to 100,000 tokens) | $1 / MTok | $1.25 / MTok | $2 / MTok | $0.1 / MTok | $5 / MTok |
| Claude Sample 2 (for prompts over 100,000 tokens) | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.2 / MTok | $10 / MTok |
## Cloud platform pricing
`;
test("OpenAI keeps all cache TTL/context rates and never substitutes Batch or a later Standard section", () => {
    const entries = parseOfficialPriceDocument("openai", openai);
    expect(entries).toHaveLength(2); expect(entries[0]!.rates).toHaveLength(10);
    expect(entries[0]!.rates[3]).toEqual({ label: "短上下文缓存写入（30 分钟）", usdPerMillion: "2.5" });
    expect(entries[0]!.rates[8]).toEqual({ label: "长上下文缓存写入（30 分钟）", usdPerMillion: "5" });
    expect(entries[0]!.context).toContain("≤272K");
    expect(entries[1]!.rates.map(r => r.usdPerMillion)).toEqual(["1", "4", null]);
});
test("Claude uses the stated cache read price, merges both long-context bands and retains each full write rate", () => {
    const entries = parseOfficialPriceDocument("anthropic", anthropic);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.rates.map(r => r.usdPerMillion)).toEqual(["2", "2.5", "4", "0.05", "10"]);
    expect(entries[1]!.modelName).toBe("Claude Sample 2"); expect(entries[1]!.rates).toHaveLength(10);
    expect(entries[1]!.rates[0]!.label).toContain("≤100,000"); expect(entries[1]!.rates[5]!.label).toContain(">100,000");
});
test("structural, currency, unknown-unit, missing-tier and ambiguous-future-price changes fail the whole source", () => {
    for (const bad of [openai.replace("Short context input", "New input type"), openai.replace("$0.1 |", "$0.1 until next month |"),
        openai.replace("$4 | $15", "€4 | $15"), openai.replace(">272K input", ">300K input"), openai.replace("Prices per 1M tokens.", "Prices per 1K tokens."),
        openai.replace("gpt-other |", "gpt-test |")]) expect(() => parseOfficialPriceDocument("openai", bad)).toThrow();
    for (const bad of [anthropic.replace("$0.05 / MTok<sup>1</sup>", "$0.05 / KTok"), anthropic.replace("All prices are in USD.", "All prices are in CNY."),
        anthropic.split("\n").filter(l => !l.includes("over 100,000")).join("\n"), anthropic.replace("over 100,000", "over 200,000")]) expect(() => parseOfficialPriceDocument("anthropic", bad)).toThrow();
});
test("official fetch uses only fixed public URL with no credentials; rejects redirect/errors/HTML/oversized body", async () => {
    const ok = (async (url: string, init: RequestInit) => {
        expect(url).toBe("https://developers.openai.com/api/docs/pricing.md");
        expect(init.redirect).toBe("error"); expect(init.credentials).toBe("omit");
        expect(new Headers(init.headers).has("authorization")).toBe(false);
        return new Response(openai, { headers: { "content-type": "text/markdown; charset=utf-8" } });
    }) as typeof fetch;
    expect(await fetchOfficialPriceEntries("openai", { fetcher: ok })).toHaveLength(2);
    for (const response of [new Response("unavailable", { status: 403, headers: { "content-type": "text/plain" } }),
        new Response("redirect", { status: 307, headers: { location: "http://127.0.0.1/", "content-type": "text/plain" } }),
        new Response("<html/>", { headers: { "content-type": "text/html" } }),
        new Response("x".repeat(512 * 1024 + 1), { headers: { "content-type": "text/markdown" } })]) {
        await expect(fetchOfficialPriceEntries("openai", { fetcher: (async () => response) as typeof fetch })).rejects.toThrow();
    }
});
test("reference projections cannot add pricing/key data; mappings require explicit text binding and optimistic version", () => {
    const checkedAt = "2026-10-23T10:00:00.000Z", entries = parseOfficialPriceDocument("openai", openai);
    const source = { id: "openai", version: 1, checkedAt, attemptedAt: checkedAt, changedAt: null, status: "ready", entries, changedEntryIds: [], secret: "private" };
    const admin = parseAdminOfficialPriceCatalog({ sources: [source], mappings: [] });
    expect(admin?.sources[0]).not.toHaveProperty("secret");
    expect(parseAdminOfficialPriceCatalog({ sources: [{ ...source, version: 0 }], mappings: [] })).toBeNull();
    expect(parseAdminOfficialPriceCatalog({ sources: [{ ...source, changedEntryIds: [entries[0]!.id, entries[0]!.id] }], mappings: [] })).toBeNull();
    const ref = { modelId: "text", sourceId: "openai", version: 1, checkedAt, changedAt: null, stale: false, entry: entries[0], cost: "PRIVATE", endpoint: "PRIVATE" };
    const publicItems = parsePublicOfficialPriceReferences([ref]);
    expect(publicItems).toHaveLength(1); expect(JSON.stringify(publicItems)).not.toContain("PRIVATE");
    expect(parsePublicOfficialPriceReferences([{ ...ref, entry: { ...entries[0], id: "anthropic:wrong" } }])).toBeNull();
    const write = { modelId: "text", expectedVersion: 0, referenceId: entries[0]!.id, binding: { providerId: "channel", providerModel: "alias", adapter: "openai-compatible", endpoint: "https://example.invalid", capability: "text" } };
    expect(parseOfficialPriceMappingWrite(write)).toEqual(write);
    expect(parseOfficialPriceMappingWrite({ ...write, binding: { ...write.binding, capability: "image" } })).toBeNull();
    expect(parseOfficialPriceMappingWrite({ ...write, cost: "5" })).toBeNull();
    expect(parseOfficialPriceMappingWrite({ ...write, expectedVersion: -1 })).toBeNull();
});
