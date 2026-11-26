import type { Database } from "@infinite-canvas/database";
import type { RateStore } from "@infinite-canvas/database/rate-limit";
import { resolveGenerationRates } from "@infinite-canvas/database/generation-rate-settings";
import { assertSafetyActor, type SafetyActor, type SafetyTx } from "@infinite-canvas/database/account-moderation";
import type { ContentSafetyConfig } from "./content-safety-config";
import { generationRatesFromPolicy } from "./content-safety-config";
import { recordGenerationCheckpoint } from "./content-safety-checkpoint";
import { enforceGenerationAdmission } from "./content-safety-admission";
import { GenerationContractError } from "./generation-contract";
import { HttpError } from "./http";
import { videoQueueTransaction as generationTransaction } from "./generation-video-queue";
import { rethrowModerationError } from "./account-moderation-contract";

export type GenerationSubmissionSafety = SafetyActor & {
    peerIp: string | undefined; rates: RateStore;
    config: Pick<ContentSafetyConfig, "checkpointMode" | "generationRates" | "generationPolicyDefaults">;
    onRecordUnavailable: () => void;
};
type AdmissionInput = { ownerId: string; requestId: string; modelId: string; capability: "text" | "image" | "audio" | "video" };
function checkpoint(context: GenerationSubmissionSafety, input: AdmissionInput) {
    if (context.actorId !== input.ownerId || context.requestId !== input.requestId) throw new GenerationContractError("invalid_input", "生成准入身份与可信请求不一致");
    return { actorId: input.ownerId, requestId: input.requestId, modelId: input.modelId, capability: input.capability };
}
/** Lock the original account/session before catalog, task or wallet locks, including replays. */
export async function assertGenerationSubmissionActor(tx: SafetyTx, context: GenerationSubmissionSafety | undefined, input: AdmissionInput): Promise<void> {
    if (!context) return;
    checkpoint(context, input);
    try { await assertSafetyActor(tx, context, false); }
    catch (error) { rethrowModerationError(error); }
}
/** HTTP request metadata only. Never run this best-effort write on the monetary transaction. */
export async function recordConfirmedGenerationRequest(db: Database, context: GenerationSubmissionSafety | undefined, input: AdmissionInput): Promise<void> {
    if (!context) return;
    if (await recordGenerationCheckpoint(db, context.config.checkpointMode, checkpoint(context, input)) === "unavailable") {
        try { context.onRecordUnavailable(); } catch { /* A logging failure cannot turn record mode into blocking. */ }
    }
}
/** Only after tasks.create returned created=true, on the same transaction as reserve and enqueue. */
export async function runConfirmedGenerationAdmission(tx: SafetyTx, context: GenerationSubmissionSafety | undefined, input: AdmissionInput): Promise<void> {
    if (!context) return;
    const request = checkpoint(context, input);
    let settings: Awaited<ReturnType<typeof resolveGenerationRates>>;
    try {
        settings = await resolveGenerationRates(tx, { policy: context.config.generationPolicyDefaults,
            modelRates: context.config.generationRates.models, checkpointMode: context.config.checkpointMode });
    } catch { throw new HttpError(503, "generation_admission_unavailable", "生成政策暂不可用，请保留输入并稍后再试"); }
    await enforceGenerationAdmission(context.rates, generationRatesFromPolicy(settings.policy, settings.modelRates),
        { ...request, peerIp: context.peerIp }, work => tx.transaction(nested => work({
            query: query => generationTransaction(nested).executeSql(query.text, query.values),
        })));
}
