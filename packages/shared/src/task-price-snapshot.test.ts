import { expect, test } from "bun:test";
import { parseTaskPriceSnapshot, type TaskPriceSnapshot } from "./task-price-snapshot";

const recorded: TaskPriceSnapshot = {
    status: "recorded", publicationId: "11111111-1111-4111-8111-111111111111", draftId: "22222222-2222-4222-8222-222222222222",
    draftVersion: 3, priceVersion: 2, publicPriceNote: "成功交付一张图片", publishedAt: "2026-10-23T00:00:00.000Z",
    binding: { providerId: "synthetic-provider", providerModel: "synthetic-image", adapter: "openai-compatible", endpoint: "https://provider.invalid/v1", capability: "image" },
    rules: { schemaVersion: 1, cost: { template: "image_request", currency: "USD", bands: [{ parameters: {}, rates: { request: "0.123456789" } }] },
        sale: { template: "image_request", currency: "credit", bands: [{ parameters: {}, rates: { request: "7" } }] } },
};

test("recorded configuration preserves exact prices, currencies and provenance independently of live binding", () => {
    expect(parseTaskPriceSnapshot(recorded)).toEqual(recorded);
    expect(parseTaskPriceSnapshot({ ...recorded, rules: { ...recorded.rules, cost: null } })).toEqual({ ...recorded, rules: { ...recorded.rules, cost: null } });
    const unknown = { ...recorded, rules: { ...recorded.rules, cost: { ...recorded.rules.cost!, bands: [{ parameters: {}, rates: { request: null } }] } } };
    expect(parseTaskPriceSnapshot(unknown)).toEqual(unknown);
    expect(parseTaskPriceSnapshot({ status: "not_recorded" })).toEqual({ status: "not_recorded" });
    expect(parseTaskPriceSnapshot({ status: "invalid" })).toEqual({ status: "invalid" });
});

test("missing, mixed-capability and private extra data cannot be interpreted as an accepted price", () => {
    for (const value of [undefined, null, [], {}, { status: "not_recorded", rules: recorded.rules },
        { ...recorded, publicationId: "unrecorded" }, { ...recorded, draftVersion: 0 }, { ...recorded, priceVersion: 1.2 },
        { ...recorded, publishedAt: "not a timestamp" }, { ...recorded, priceNote: "private" },
        { ...recorded, binding: { ...recorded.binding, endpoint: "https://provider.invalid/?key=private" } },
        { ...recorded, binding: { ...recorded.binding, capability: "text" } },
        { ...recorded, rules: { ...recorded.rules, sale: { ...recorded.rules.sale, currency: "CNY" } } },
        { ...recorded, rules: { ...recorded.rules, cost: { ...recorded.rules.cost!, secret: "private" } } },
    ]) expect(parseTaskPriceSnapshot(value)).toBeNull();
});
