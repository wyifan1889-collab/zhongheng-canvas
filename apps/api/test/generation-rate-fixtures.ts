import type { Database } from "@infinite-canvas/database";
import { officialPriceMapping, officialPriceSource } from "@infinite-canvas/database/schema";
import type { ModelPriceDraftWrite } from "@infinite-canvas/shared";
import { deriveModelPriceRules, type ModelPriceDerivationV2 } from "../../../packages/shared/src/model-price-derivation";

/** Uses the final Round18 contract; never weakens text eligibility to test D04. */
export async function generationRateTextRules(db: Database, modelId: string, binding: ModelPriceDraftWrite["binding"]): Promise<ModelPriceDraftWrite["rules"]> {
    const labels = ["短上下文输入", "短上下文输出", "短上下文缓存读取", "短上下文缓存写入（30 分钟）", "短上下文缓存写入（12 小时）",
        "长上下文输入", "长上下文输出", "长上下文缓存读取", "长上下文缓存写入（30 分钟）", "长上下文缓存写入（12 小时）"];
    const amounts = ["2", "10", "0.1", "2.5", "5", "4", "15", "0.2", "5", "10"];
    const derivation: ModelPriceDerivationV2 = { schemaVersion: 2, kind: "multiplier", binding, costMultiplier: null,
        saleMultiplier: "0.36", creditsPerCurrency: "100", basis: { template: "text_cached_tokens", currency: "USD",
            bands: [{ parameters: {}, rates: { input_token: "2", cached_input_token: "0.1", output_token: "10" } }] },
        source: { kind: "official", application: "context_tiers", sourceId: "openai", version: 1, checkedAt: "2026-10-29T00:00:00.000Z",
            entry: { id: "openai:gpt-6.1-sol", modelName: "gpt-6.1-sol", context: "官方输入阈值272K；平台按总量判档。合成限流测试。",
                rates: labels.map((label, i) => ({ label, usdPerMillion: amounts[i]! })) },
            selection: { metric: "total_tokens", shortMaxTotalTokens: 272000,
                short: { "短上下文输入": "input_token", "短上下文缓存读取": "cached_input_token", "短上下文输出": "output_token" },
                long: { "长上下文输入": "input_token", "长上下文缓存读取": "cached_input_token", "长上下文输出": "output_token" } } } };
    await db.insert(officialPriceSource).values({ id: "openai", version: 1, checkedAt: new Date(derivation.source.checkedAt),
        status: "ready", entries: [derivation.source.entry] }).onConflictDoNothing();
    await db.insert(officialPriceMapping).values({ modelId, referenceId: derivation.source.entry.id, version: 1,
        providerIdSnapshot: binding.providerId, providerModelSnapshot: binding.providerModel, adapterSnapshot: binding.adapter,
        endpointSnapshot: binding.endpoint, capabilitySnapshot: "text" });
    const rules = deriveModelPriceRules(derivation);
    if (!rules) throw new Error("Invalid synthetic Round18 derivation");
    return { ...rules, derivation };
}
