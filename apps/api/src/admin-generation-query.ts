import type { Database } from "@infinite-canvas/database";
import { generationTask, generationResult, walletReservation, walletLedger, modelPricePublication, modelPriceDraft, modelPricing, modelCatalog } from "@infinite-canvas/database/schema";
import type { AdminGenerationTaskDetail, TaskPriceSnapshot } from "@infinite-canvas/shared";
import { executableImageDraftCredits, publishedTextDraftRates, parseTextQuoteSnapshot, parseTaskPriceSnapshot, parseTextUsageEvidence, normalizeCreditAmount, subtractCreditAmounts } from "@infinite-canvas/shared";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { GenerationQueryError } from "./generation-query";
import { getImageSpecTaskSnapshot } from "@infinite-canvas/database/model-price-publications";

// Only existing server-owned codes may leave this boundary. Historical or manually
// supplied free text must not expose provider payloads, credentials or prompts.
const reasonCodes = new Set([
    "provider_rejected", "provider_invalid_response", "provider_timeout", "provider_unreachable", "provider_response_unknown",
    "invalid_generation_input", "invalid_generation_parameters", "model_unavailable", "unsupported_generation_capability",
    "provider_adapter_unsupported", "image_delivery_unavailable", "unsupported_image_billing", "provider_adapter_exception",
    "provider_image_invalid_response", "worker_recovery_required", "worker_replayed_after_running", "worker_provider_exception",
    "result_requires_review", "delivery_reference_persistence_unknown", "delivery_adapter_exception", "delivery_adapter_not_configured",
    "delivery_result_not_succeeded", "delivery_text_result_invalid", "delivery_result_unsupported", "delivery_media_integrity_unknown",
    "delivery_asset_resolver_exception", "delivery_asset_missing", "delivery_asset_invalid", "delivery_content_type_invalid",
    "delivery_asset_too_large", "delivery_storage_key_conflict", "delivery_quota_cleanup_unknown", "delivery_quota_exceeded",
    "delivery_persistence_unknown", "provider_text_invalid_response",
    "image_spec_execution_unavailable",
    "image_spec_evidence_missing", "image_spec_evidence_conflicting", "image_spec_png_invalid", "image_spec_pixel_budget_exceeded", "image_spec_source_invalid",
    "gemini_image_budget_exceeded", "gemini_image_batch_limit", "gemini_image_dimensions_mismatch", "gemini_image_reservation_mismatch",
    "gemini_delivery_evidence_invalid", "gemini_delivery_quota_exceeded", "gemini_delivery_storage_unknown",
    "response_invalid", "response_error", "response_blocked", "response_incomplete", "response_part_unsupported", "response_no_image", "image_format_unsupported",
]);

function safeReason(value: string | null): string | null {
    return value === null ? null : reasonCodes.has(value) ? value : "unrecognized_reason";
}

/** Exact-ID administrative projection; authentication belongs to the admin route. */
export async function getAdminGenerationTaskDetail(db: Database, taskId: string): Promise<AdminGenerationTaskDetail> {
    if (!z.uuid().safeParse(taskId).success) throw new GenerationQueryError("invalid_input", "任务 UUID 格式不正确");
    return db.transaction(async (tx) => {
        const [row] = await tx.select({
            observedAt: sql<string>`transaction_timestamp()::text`,
            id: generationTask.id, ownerId: generationTask.ownerId, projectId: generationTask.projectId, nodeId: generationTask.nodeId,
            modelId: generationTask.modelId, priceVersion: generationTask.priceVersion, quotedUnits: generationTask.quotedUnits,
            billingUnitSnapshot: generationTask.billingUnitSnapshot, creditsPerUnitSnapshot: generationTask.creditsPerUnitSnapshot,
            executionStatus: generationTask.executionStatus, deliveryStatus: generationTask.deliveryStatus,
            billingStatus: generationTask.billingStatus, unknownReason: generationTask.unknownReason,
            createdAt: generationTask.createdAt, updatedAt: generationTask.updatedAt, finishedAt: generationTask.finishedAt,
            reservationId: generationTask.reservationId,
            pricePublicationId: generationTask.pricePublicationId,
            textQuoteSnapshot: generationTask.textQuoteSnapshot,
            parameterSnapshot: generationTask.parameterSnapshot,
        }).from(generationTask).where(eq(generationTask.id, taskId.toLowerCase())).limit(1);
        if (!row) throw new GenerationQueryError("not_found", "生成任务不存在");
        let priceSnapshot: TaskPriceSnapshot = { status: row.textQuoteSnapshot === null ? "not_recorded" : "invalid" };
        if (row.pricePublicationId !== null) {
            // Follow the acceptance-time source, never the latest draft or current provider binding.
            const [source] = await tx.select({ publication: modelPricePublication, draft: modelPriceDraft, price: modelPricing, publicModelId: modelCatalog.publicId })
                .from(modelPricePublication).innerJoin(modelPriceDraft, eq(modelPriceDraft.id, modelPricePublication.draftId))
                .innerJoin(modelPricing, eq(modelPricing.id, modelPricePublication.pricingId))
                // Catalog identity only; current enablement and provider binding cannot rewrite history.
                .innerJoin(modelCatalog, eq(modelCatalog.id, modelPricing.modelId))
                .where(eq(modelPricePublication.id, row.pricePublicationId)).limit(1);
            priceSnapshot = { status: "invalid" };
            if (source && source.draft.modelId === source.price.modelId && source.publicModelId === row.modelId && source.price.version === row.priceVersion) {
                const snapshot = parseTaskPriceSnapshot({ status: "recorded", publicationId: source.publication.id,
                    draftId: source.draft.id, draftVersion: source.draft.version, priceVersion: source.price.version,
                    publicPriceNote: source.publication.publicPriceNote, rules: source.draft.rules,
                    binding: { providerId: source.draft.providerIdSnapshot, providerModel: source.draft.providerModelSnapshot,
                        adapter: source.draft.adapterSnapshot, endpoint: source.draft.endpointSnapshot, capability: source.draft.capabilitySnapshot },
                    publishedAt: source.publication.createdAt.toISOString() });
                if (snapshot?.status === "recorded") {
                    if (source.price.billingUnit === "text_tokens") {
                        const quote = parseTextQuoteSnapshot(row.textQuoteSnapshot), rates = publishedTextDraftRates(snapshot.binding, snapshot.rules);
                        if (quote && rates && source.price.creditsPerUnit === null && row.quotedUnits === null &&
                            row.billingUnitSnapshot === null && row.creditsPerUnitSnapshot === null &&
                            quote.inputCreditsPerMillion === rates.inputCreditsPerMillion && quote.outputCreditsPerMillion === rates.outputCreditsPerMillion &&
                            quote.cachedInputCreditsPerMillion === rates.cachedInputCreditsPerMillion &&
                            quote.usageSource === (snapshot.binding.adapter === "sub2api" ? "responses" : "chat_completions")) priceSnapshot = snapshot;
                    } else if (source.price.billingUnit === "image_specs") {
                        const original = await getImageSpecTaskSnapshot(tx, row);
                        if (original.status === "recorded" || original.status === "gemini") priceSnapshot = snapshot;
                    } else if (row.textQuoteSnapshot === null && source.price.billingUnit === row.billingUnitSnapshot &&
                        source.price.creditsPerUnit === row.creditsPerUnitSnapshot && row.billingUnitSnapshot === "request" &&
                        executableImageDraftCredits(snapshot.binding, snapshot.rules) === row.creditsPerUnitSnapshot) priceSnapshot = snapshot;
                }
            }
        }
        const [result] = await tx.select({
            status: generationResult.status, consumedUnits: generationResult.consumedUnits,
            resultSnapshot: generationResult.resultSnapshot,
            errorCode: generationResult.errorCode, unknownReason: generationResult.unknownReason,
            createdAt: generationResult.createdAt, updatedAt: generationResult.updatedAt,
        }).from(generationResult).where(and(eq(generationResult.taskId, row.id), eq(generationResult.ownerId, row.ownerId))).limit(1);
        let reservation: AdminGenerationTaskDetail["reservation"] = { linkStatus: "none", details: null };
        if (row.reservationId !== null) {
            const [linked] = await tx.select({
                id: walletReservation.id, ownerId: walletReservation.userId, taskId: walletReservation.taskId,
                status: walletReservation.status, requestedUnits: walletReservation.requestedUnits,
                capturedUnits: walletReservation.capturedUnits, releasedUnits: walletReservation.releasedUnits,
                createdAt: walletReservation.createdAt, updatedAt: walletReservation.updatedAt,
            }).from(walletReservation).where(eq(walletReservation.id, row.reservationId)).limit(1);
            if (!linked) reservation = { linkStatus: "missing", details: null };
            else if (linked.ownerId !== row.ownerId || linked.taskId !== row.id) reservation = { linkStatus: "mismatch", details: null };
            else reservation = { linkStatus: "linked", details: {
                id: linked.id, status: linked.status, requestedUnits: normalizeCreditAmount(linked.requestedUnits)!,
                capturedUnits: normalizeCreditAmount(linked.capturedUnits)!, releasedUnits: normalizeCreditAmount(linked.releasedUnits)!,
                remainingUnits: subtractCreditAmounts(subtractCreditAmounts(linked.requestedUnits, linked.capturedUnits), linked.releasedUnits),
                createdAt: linked.createdAt.toISOString(), updatedAt: linked.updatedAt.toISOString(),
            } };
        }
        const ledger = await tx.select({
            id: walletLedger.id, kind: walletLedger.kind, deltaAvailableUnits: walletLedger.deltaAvailableUnits,
            deltaReservedUnits: walletLedger.deltaReservedUnits, createdAt: walletLedger.createdAt,
        }).from(walletLedger).where(and(eq(walletLedger.userId, row.ownerId), eq(walletLedger.referenceType, "generation"),
            eq(walletLedger.referenceId, row.id))).orderBy(asc(walletLedger.createdAt), asc(walletLedger.id));
        const { reservationId: _reservationId, pricePublicationId: _pricePublicationId, textQuoteSnapshot: _textQuoteSnapshot,
            parameterSnapshot: _parameterSnapshot, observedAt, ...task } = row;
        // Raw output stays private. Old partial usage is not upgraded to verified evidence.
        const resultSnapshot = result?.resultSnapshot;
        const textUsage = resultSnapshot?.kind === "text" ? parseTextUsageEvidence(resultSnapshot.usageEvidence) : null;
        return {
            observedAt: new Date(observedAt).toISOString(),
            priceSnapshot,
            task: { ...task, unknownReason: safeReason(task.unknownReason), createdAt: task.createdAt.toISOString(),
                updatedAt: task.updatedAt.toISOString(), finishedAt: task.finishedAt?.toISOString() ?? null },
            result: result ? { textUsage, status: result.status, consumedUnits: result.consumedUnits,
                errorCode: safeReason(result.errorCode), unknownReason: safeReason(result.unknownReason),
                createdAt: result.createdAt.toISOString(), updatedAt: result.updatedAt.toISOString() } : null,
            reservation,
            ledger: ledger.map((entry) => ({ ...entry, deltaAvailableUnits: normalizeCreditAmount(entry.deltaAvailableUnits)!,
                deltaReservedUnits: normalizeCreditAmount(entry.deltaReservedUnits)!, createdAt: entry.createdAt.toISOString() })),
        };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
