import { isIP } from "node:net";
import type { RateBatchEntry, RateStore, RateTransactionRunner } from "@infinite-canvas/database/rate-limit";
import type { GenerationRateConfig } from "./content-safety-config";
import type { ContentSafetyCheckpoint } from "./content-safety-checkpoint";
import { HttpError } from "./http";

export type GenerationAdmissionInput = ContentSafetyCheckpoint & { peerIp: string | undefined };

/** Caller supplies its resolved model and trusted socket/proxy address, never request body identity. */
export async function enforceGenerationAdmission(
    rates: RateStore, config: GenerationRateConfig, input: GenerationAdmissionInput, transaction?: RateTransactionRunner,
): Promise<void> {
    const unavailable = () => new HttpError(503, "service_unavailable", "生成准入暂不可用，请保留输入并稍后再试");
    const entries: RateBatchEntry[] = [];
    if (config.ip) {
        if (!input.peerIp || !isIP(input.peerIp)) throw unavailable();
        entries.push({ bucket: "generation-ip", identity: input.peerIp, rule: config.ip });
    }
    if (config.user) {
        if (!input.actorId?.trim()) throw unavailable();
        entries.push({ bucket: "generation-user", identity: input.actorId, rule: config.user });
    }
    const modelRule = config.models.find(rule => rule.modelId === input.modelId);
    if (modelRule) entries.push({ bucket: "generation-model", identity: input.modelId, rule: { points: modelRule.points, duration: modelRule.duration } });
    if (!entries.length) return;
    // An old single-bucket fake or a missing transaction must never silently weaken compound admission.
    if (!rates.consumeMany || !transaction) throw unavailable();
    let decision;
    try { decision = await rates.consumeMany(entries, transaction); }
    catch { throw unavailable(); }
    if (decision.allowed === true) return;
    if (decision.allowed !== false || !Number.isSafeInteger(decision.retryAfter) || decision.retryAfter < 1) throw unavailable();
    throw new HttpError(429, "rate_limited", "生成请求过于频繁，请保留输入并稍后再试", decision.retryAfter);
}
