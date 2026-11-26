import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PublicationPrice, SavedPriceDraft, publicationPriceNote } from "./ModelPriceDraft";
import { PriceDerivationSummary, selectedOfficialContextRows } from "./MultiplierPricePreview";
import { deriveModelPriceRules, parseModelPriceDerivation } from "../../../../../packages/shared/src/model-price-derivation";
import { textContextTierNote, validTextContextTierNote } from "../../../../../packages/shared/src/model-price-publications";
import { createAdminModelPricePublicationClient, type AdminGenerationScope, type AdminModelPriceDraft, type AdminModelPricePublication, type ModelPricePublicationPreview } from "@/services/saas/platform";
import { PlatformPriceDetails } from "@/components/account/platform-overview";
import { TextRateLines } from "@/components/canvas/canvas-platform-text-modal";
import type { PlatformPricing } from "@/services/saas/platform";

const textPrice: PlatformPricing = { modelId: "synthetic-text", displayName: "模拟文本", capability: "text", version: 3,
    billingUnit: "text_tokens", creditsPerUnit: null, inputCreditsPerMillion: "0.000004", outputCreditsPerMillion: "9007199254740993.000002",
    priceNote: "本模型输入与输出单独计价。", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null };

test("admin publication and public catalog show exact rates with their respective text execution boundaries", () => {
    const admin = renderToStaticMarkup(<PublicationPrice price={textPrice} />);
    const catalog = renderToStaticMarkup(<PlatformPriceDetails price={textPrice} />);
    for (const html of [admin, catalog]) {
        for (const text of ["输入", "输出", "0.000004", "9007199254740993.000002", "积分 / 百万 Token"]) expect(html).toContain(text);
        for (const hidden of ["null", "配置成本", "预计毛利", "生成按钮"]) expect(html).not.toContain(hidden);
    }
    for (const text of ["发布价目后仍须满足站点开放及渠道可用条件", "发布本身不会预留或扣除积分"]) expect(admin).toContain(text);
    for (const text of ["原画布实时可用目录和正式报价", "确认预算后才会冻结积分", "实际费用按原任务价格版本核算"]) expect(catalog).toContain(text);
    expect(catalog).not.toContain("尚未开放平台文本生成");
    expect(catalog).toContain("价格版本 3"); expect(catalog).toContain(textPrice.priceNote!);
    const saved = tierDraft(), frozenNote = publicationPriceNote(saved, "原任务固定公开备注")!;
    const frozen = renderToStaticMarkup(<PlatformPriceDetails price={{ ...textPrice, inputCreditsPerMillion: "72", cachedInputCreditsPerMillion: "3.6", outputCreditsPerMillion: "360", priceNote: frozenNote }} />);
    expect(frozen).toContain(frozenNote);
    for (const text of ["超过272K按长档计价", "短档：非缓存输入 72", "长档：非缓存输入 144", "超过预算不追加冻结或扣款", "费用待核对"]) expect(frozen).toContain(text);
});

test("existing image price displays its request unit without a currency symbol or text rates", () => {
    const image: PlatformPricing = { modelId: "image", displayName: "图片", capability: "image", version: 1, billingUnit: "request", creditsPerUnit: 7,
        effectiveFrom: textPrice.effectiveFrom, effectiveTo: null };
    for (const html of [renderToStaticMarkup(<PublicationPrice price={image} />), renderToStaticMarkup(<PlatformPriceDetails price={image} />)]) {
        expect(html).toContain("7 积分 / 次"); expect(html).not.toContain("$"); expect(html).not.toContain("百万 Token"); expect(html).not.toContain("文本生成");
    }
});

test("a published legacy price without a draft is not described as awaiting a price", () => {
    const published = renderToStaticMarkup(<SavedPriceDraft published />);
    expect(published).toContain("尚无价目草稿");
    expect(published).not.toContain("待定价");
    const unpriced = renderToStaticMarkup(<SavedPriceDraft published={false} />);
    expect(unpriced).toContain("待定价");
    expect(unpriced).not.toContain("尚无价目草稿");
});

test("cached-input publication and generation confirmation separate normal input, cache reads, and output", () => {
    const price = { ...textPrice, cachedInputCreditsPerMillion: "0.000001" };
    for (const html of [renderToStaticMarkup(<PublicationPrice price={price} />), renderToStaticMarkup(<PlatformPriceDetails price={price} />), renderToStaticMarkup(<TextRateLines rates={price} />)]) {
        for (const text of ["非缓存输入", "缓存读取", "0.000001", "0.000004", "9007199254740993.000002", "积分 / 百万 Token"]) expect(html).toContain(text);
        expect(html).not.toContain("配置成本");
    }
    const confirmation = renderToStaticMarkup(<TextRateLines rates={price} />);
    for (const text of ["输入总量减去缓存读取", "写入为 0", "费用待核对"]) expect(confirmation).toContain(text);
    expect(renderToStaticMarkup(<TextRateLines rates={textPrice} />)).toContain("缓存读取含在输入中");
    expect(renderToStaticMarkup(<PublicationPrice price={textPrice} />)).not.toContain("非缓存输入");
});

const tierRows = () => [
    ["短上下文输入", "2"], ["短上下文输出", "10"], ["短上下文缓存读取", "0.1"], ["短上下文缓存写入（30 分钟）", "2.5"], ["短上下文缓存写入（12 小时）", "5"],
    ["长上下文输入", "4"], ["长上下文输出", "15"], ["长上下文缓存读取", "0.2"], ["长上下文缓存写入（30 分钟）", "5"], ["长上下文缓存写入（12 小时）", "10"],
].map(([label, amount], index) => ({ id: `official-${index}`, label, amount, unit: "百万 Token", quantityBase: 1_000_000 as const }));
const tierMapping = () => ({ "official-0": "input_token", "official-1": "output_token", "official-2": "cached_input_token", "official-5": "input_token", "official-6": "output_token", "official-7": "cached_input_token" } as const);
function tierDraft(): AdminModelPriceDraft {
    const rows = tierRows(), selection = selectedOfficialContextRows(rows, tierMapping());
    const binding = { providerId: "synthetic-provider", providerModel: "gpt-6.1-sol", adapter: "sub2api", endpoint: "https://synthetic.invalid/", capability: "text" } as const;
    const origin = parseModelPriceDerivation({ schemaVersion: 2, kind: "multiplier", binding, costMultiplier: null, saleMultiplier: "0.36", creditsPerCurrency: "100",
        basis: { template: "text_cached_tokens", currency: "USD", bands: [{ parameters: {}, rates: { input_token: "2", cached_input_token: "0.1", output_token: "10" } }] },
        source: { kind: "official", application: "context_tiers", sourceId: "openai", version: 2, checkedAt: "2026-10-29T07:29:08.289Z",
            entry: { id: "openai:gpt-6.1-sol", modelName: "gpt-6.1-sol", context: "官方输入阈值：输入 ≤272K；输入 >272K。", rates: rows.map(row => ({ label: row.label, usdPerMillion: row.amount })) }, selection } }, "text");
    if (!origin) throw new Error("synthetic tier fixture rejected");
    const rules = deriveModelPriceRules(origin);
    if (!rules) throw new Error("synthetic tier arithmetic rejected");
    return { id: "a7398717-1f6e-470b-839d-c66bba8d21ae", modelId: "synthetic-sol", version: 1, binding, bindingMatchesCurrent: true,
        rules: { ...rules, derivation: origin }, priceNote: "private note", createdAt: "2026-10-29T00:00:00Z" };
}

test("admin requires six explicit source row choices while preserving all ten rows", () => {
    const rows = tierRows(), original = structuredClone(rows), mapping = tierMapping();
    expect(selectedOfficialContextRows(rows, {})).toBeNull();
    const selected = selectedOfficialContextRows(rows, mapping)!;
    expect(Object.keys(selected.short)).toEqual(["短上下文输入", "短上下文输出", "短上下文缓存读取"]);
    expect(Object.keys(selected.long)).toEqual(["长上下文输入", "长上下文输出", "长上下文缓存读取"]);
    expect(selected.shortMaxTotalTokens).toBe(272000);
    expect(rows).toEqual(original);
    expect(selectedOfficialContextRows(rows.slice(1), mapping)).toBeNull();
    expect(selectedOfficialContextRows(rows, { ...mapping, "official-5": "cached_input_token" })).toBeNull();
    expect(selectedOfficialContextRows(rows, { ...mapping, "official-8": "input_token" })).toBeNull();
    expect(selectedOfficialContextRows(rows, { ...mapping, "official-1": "input_token" })).toBeNull();
});

test("saved tier summary distinguishes the official input condition from platform total and shows both exact triples", () => {
    const saved = tierDraft(), html = renderToStaticMarkup(<PriceDerivationSummary rules={saved.rules} />);
    for (const text of ["官方输入阈值", "本平台按实际输入 + 输出总量判档", "272000", "超过272K按长档计价", "完整冻结 10 行", "显式选择 6 行", "4 行缓存写入费率未适配", "72", "3.6", "360", "144", "7.2", "540"]) expect(html).toContain(text);
    expect(html).not.toContain("平台价格不自动随上下文或服务档位切换");
    expect(saved.rules.derivation!.source.kind === "official" && saved.rules.derivation!.source.entry.rates).toHaveLength(10);
});

test("admin submits canonical complete disclosure with user note and preserves legacy note unchanged", () => {
    const saved = tierDraft(), prefix = textContextTierNote(saved.rules, saved.binding)!;
    expect(publicationPriceNote(saved, "")).toBe(prefix);
    const final = publicationPriceNote(saved, "公开备注");
    expect(final).toBe(prefix + "\n\n公开备注");
    expect(validTextContextTierNote(saved.rules, saved.binding, final)).toBe(true);
    expect(publicationPriceNote(saved, final!)).toBe(final);
    expect(publicationPriceNote({ ...saved, rules: { ...saved.rules, derivation: undefined } }, "旧公开说明")).toBe("旧公开说明");
    expect(publicationPriceNote(saved, "仅管理员新备注")).not.toBe("仅管理员新备注");
    const bad = structuredClone(saved); (bad.rules.derivation!.source as unknown as { selection: { long: unknown } }).selection.long = {};
    expect(publicationPriceNote(bad, "公开备注")).toBeNull();
});

test("actual publication client sends the admin complete tier note and accepts the identical server receipt", async () => {
    const saved = tierDraft(), finalNote = publicationPriceNote(saved, "公开备注")!;
    const scope: AdminGenerationScope = { accountId: "synthetic-publisher", epoch: 3, role: "admin" };
    const preview: ModelPricePublicationPreview = { modelId: saved.modelId, draft: saved, latestPriceVersion: 0,
        currentPrice: null, publication: null, unavailableReason: null };
    const publication: AdminModelPricePublication = { id: "22222222-2222-4222-8222-222222222222", modelId: saved.modelId,
        draftId: saved.id, draftVersion: saved.version, priceVersion: 1, billingUnit: "text_tokens", creditsPerUnit: null,
        inputCreditsPerMillion: "72", cachedInputCreditsPerMillion: "3.6", outputCreditsPerMillion: "360",
        publicPriceNote: finalNote, rules: saved.rules, binding: saved.binding, bindingMatchesCurrent: true, createdAt: "2026-10-29T00:00:01Z" };
    const calls: Array<{ init?: RequestInit }> = [];
    const fetcher: typeof fetch = Object.assign(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ init });
        return Response.json(init?.method === "POST" ? { publication } : { preview });
    }, { preconnect: fetch.preconnect });
    const client = createAdminModelPricePublicationClient({ scope, getScope: () => scope, fetcher });
    try {
        const loaded = (await client.load(saved.modelId))!;
        const receipt = await client.publish(loaded, publicationPriceNote(loaded.draft!, "公开备注")!);
        expect(receipt).toEqual(publication);
        expect(receipt?.publicPriceNote).toBe(finalNote);
        const body = JSON.parse(String(calls[1].init?.body));
        expect(body).toEqual({ modelId: saved.modelId, draftId: saved.id, expectedDraftVersion: saved.version,
            expectedPriceVersion: 0, binding: saved.binding, publicPriceNote: finalNote });
        expect(body.publicPriceNote).toBe(textContextTierNote(saved.rules, saved.binding) + "\n\n公开备注");
        expect(JSON.stringify(body)).not.toContain(saved.priceNote);
        expect(client.hasUnconfirmed(saved.modelId)).toBe(false);
        expect(calls.map(call => call.init?.method)).toEqual(["GET", "POST"]);
    } finally { client.close(); }
});
