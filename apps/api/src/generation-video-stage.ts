import { sql } from "drizzle-orm";
import type { Database } from "@infinite-canvas/database";
import { createGenerationTaskRepository, type GenerationTaskView } from "@infinite-canvas/database/generation-tasks";
import { createGenerationResultRepository, type GenerationResultView } from "@infinite-canvas/database/generation-results";
import { createGenerationJobPayload, fromDrizzle, GENERATION_QUEUE_NAME, type GenerationJobPayload } from "@infinite-canvas/jobs";
import { createGenerationVideoStageRepository, videoStageDue, type GenerationVideoStage } from "../../../packages/database/src/generation-video-stages";
import { parseVideoQuoteSnapshot, VIDEO_PROTOCOL, type VideoBinding } from "../../../packages/shared/src/generation-video";
import type { GenerationQueueSender } from "./generation-dispatch";
import type { GenerationDeliveryResult, GenerationWorkerDependencies, GenerationWorkerResult } from "./generation-worker";
import type { VideoRuntimePolicy } from "./generation-video-config";
import type { VideoProviderResponse } from "./video-provider-response";
import type { VideoInput, VideoReference } from "./video-provider-request";
import type { VideoProbeSnapshot } from "./generation-video-probe";
import { videoQueueTransaction } from "./generation-video-queue";
import { createMediaRepository } from "@infinite-canvas/database/media";

export type GenerationVideoDriverOptions = {
    database: Database; queue: GenerationQueueSender; policy: VideoRuntimePolicy;
    provider: { create(binding: VideoBinding, input: VideoInput, parameters: GenerationVideoStage["parametersSnapshot"], reference?: VideoReference): Promise<VideoProviderResponse>;
        inspect(binding: VideoBinding, providerTaskId: string): Promise<VideoProviderResponse> };
    /** Validate immutable publication/current permission and prepare private input before authorizing create. */
    prepare: (task: GenerationTaskView, stage: GenerationVideoStage) => Promise<{ input: VideoInput; reference?: VideoReference }>;
    deliver: (input: { task: GenerationTaskView; result: GenerationResultView; stage: GenerationVideoStage;
        commitProbe: (probe: VideoProbeSnapshot) => Promise<boolean> }) => Promise<GenerationDeliveryResult>;
    settleBilling: NonNullable<GenerationWorkerDependencies["settleBilling"]>;
    now?: () => Date;
};
const binding = (stage: GenerationVideoStage): VideoBinding => ({ protocol: VIDEO_PROTOCOL, providerId: stage.providerId, endpoint: stage.endpoint, providerModel: stage.providerModel });

/** Durable application phases reuse the original task/queue/wallet. No in-memory provider polling loop. */
export function createGenerationVideoDriver(options: GenerationVideoDriverOptions) {
    const db = options.database, policy = options.policy, now = options.now ?? (() => new Date());
    async function wake(tx: Database, stage: GenerationVideoStage, task: GenerationTaskView, at: Date) {
        const jobId = await options.queue.send(GENERATION_QUEUE_NAME, createGenerationJobPayload({ taskId: task.id, ownerId: task.ownerId, requestId: task.requestId }),
            { db: videoQueueTransaction(tx), startAfter: at });
        if (!jobId) throw new Error("Video continuation enqueue failed");
        return createGenerationVideoStageRepository(tx).update(stage, { wakeRevision: stage.revision, wakeJobId: jobId,
            wakeDeadlineAt: new Date(at.getTime() + policy.claimLeaseMs) });
    }
    async function review(tx: Database, task: GenerationTaskView, reason: string, execution = true) {
        const tasks = createGenerationTaskRepository(tx);
        if (execution && ["queued", "running"].includes(task.executionStatus)) task = await tasks.transitionExecution({ ownerId: task.ownerId, taskId: task.id, status: "unknown", unknownReason: reason });
        if (task.deliveryStatus === "pending") task = await tasks.transitionDelivery({ ownerId: task.ownerId, taskId: task.id, status: "unknown" });
        if (task.billingStatus === "reserved") task = await tasks.transitionBilling({ ownerId: task.ownerId, taskId: task.id, status: "pending_review" });
        return task;
    }
    async function observation(task: GenerationTaskView, claimed: GenerationVideoStage, response: VideoProviderResponse, create: boolean) {
        await db.transaction(async tx => {
            const tasks = createGenerationTaskRepository(tx), repo = createGenerationVideoStageRepository(tx);
            let currentTask = await tasks.get(task.ownerId, task.id), stage = await repo.lock(task.ownerId, task.id);
            if (!currentTask || !stage || (create ? stage.createAttemptToken !== claimed.createAttemptToken :
                stage.claimToken !== claimed.claimToken || !stage.leaseUntil || stage.leaseUntil <= now())) return;
            if (["completed", "failed", "rejected"].includes(stage.phase)) return;
            if (response.providerTaskId && stage.providerTaskId && response.providerTaskId !== stage.providerTaskId) {
                await review(tx, currentTask, "video_provider_identity_conflict");
                await repo.update(stage, { phase: "unknown", nextActionAt: null, claimToken: null, leaseUntil: null, lastReason: "video_provider_identity_conflict" }); return;
            }
            if (response.status === "unknown") {
                if (response.providerTaskId && !stage.providerTaskId) currentTask = await tasks.transitionExecution({ ownerId: task.ownerId, taskId: task.id,
                    status: currentTask.executionStatus, providerTaskId: response.providerTaskId,
                    ...(currentTask.executionStatus === "unknown" ? { unknownReason: currentTask.unknownReason ?? "video_observation_unknown" } : {}) });
                const stop = create && !response.providerTaskId || stage.inspectAttempts >= policy.maxInspectAttempts || stage.observationDeadlineAt !== null && now() >= stage.observationDeadlineAt;
                if (create || stop) currentTask = await review(tx, currentTask, `video_${response.reason}`);
                const next = stop ? null : new Date(now().getTime() + policy.pollIntervalMs);
                stage = await repo.update(stage, { phase: stop ? "unknown" : "polling", nextActionAt: next, claimToken: null, leaseUntil: null,
                    lastReason: `video_${response.reason}`, providerTaskId: stage.providerTaskId ?? response.providerTaskId ?? null,
                    ...(!stop ? { observationDeadlineAt: stage.observationDeadlineAt ?? new Date(now().getTime() + policy.observationWindowMs) } : {}) });
                if (next) await wake(tx, stage, currentTask, next); return;
            }
            const providerTaskId = response.providerTaskId;
            currentTask = await tasks.transitionExecution({ ownerId: task.ownerId, taskId: task.id, status: currentTask.executionStatus,
                providerTaskId, ...(currentTask.executionStatus === "unknown" ? { unknownReason: currentTask.unknownReason ?? "video_recovered_original_id" } : {}) });
            if (response.status === "accepted" || response.status === "pending") {
                const next = new Date(now().getTime() + policy.pollIntervalMs);
                stage = await repo.update(stage, { phase: response.status === "accepted" ? "accepted" : "polling", providerTaskId,
                    nextActionAt: next, claimToken: null, leaseUntil: null, lastReason: null,
                    observationDeadlineAt: stage.observationDeadlineAt ?? new Date(now().getTime() + policy.observationWindowMs) });
                await wake(tx, stage, currentTask, next); return;
            }
            if (response.status !== "completed" && response.status !== "failed") return;
            const completed = response.status === "completed";
            await createGenerationResultRepository(tx).create({ ownerId: task.ownerId, taskId: task.id, status: completed ? "succeeded" : "failed", providerTaskId,
                resultSnapshot: { kind: "video", protocol: VIDEO_PROTOCOL, billingPolicy: { source: "platform_delivered_video", unit: "video" },
                    ...(completed ? { durationEvidence: response.durationEvidence } : {}) },
                ...(!completed ? { errorCode: response.errorCode } : {}) });
            currentTask = await tasks.transitionExecution({ ownerId: task.ownerId, taskId: task.id, status: completed ? "succeeded" : "failed", providerTaskId });
            stage = await repo.update(stage, { phase: completed ? "completed" : "failed", providerTaskId, nextActionAt: now(), claimToken: null, leaseUntil: null,
                lastReason: completed ? null : response.errorCode, completedAt: completed ? now() : null, ...(completed ? { durationEvidence: { ...response.durationEvidence } } : {}) });
            await wake(tx, stage, currentTask, now());
        });
    }
    async function process(job: GenerationJobPayload): Promise<GenerationWorkerResult | null> {
        const claim = await db.transaction(async tx => {
            const tasks = createGenerationTaskRepository(tx), repo = createGenerationVideoStageRepository(tx);
            let task = await tasks.get(job.ownerId, job.taskId), stage = await repo.lock(job.ownerId, job.taskId);
            if (!task || !stage || task.requestId !== job.requestId || !parseVideoQuoteSnapshot(task.videoQuoteSnapshot)) throw new Error("Video task binding is invalid");
            if (["captured", "released"].includes(task.billingStatus)) { if (stage.nextActionAt) await repo.update(stage, { nextActionAt: null }); return null; }
            if (!videoStageDue(stage, now())) return null;
            if (stage.phase === "completed" && stage.lastReason === "video_storage_io_started" && !await createMediaRepository(tx).get(task.ownerId, task.id)) {
                await review(tx, task, "video_storage_outcome_unknown", false);
                await repo.update(stage, { nextActionAt: null, claimToken: null, leaseUntil: null }); return null;
            }
            if (stage.phase === "create_started") {
                await review(tx, task, "video_create_outcome_unknown");
                await repo.update(stage, { phase: "unknown", nextActionAt: null, claimToken: null, leaseUntil: null, lastReason: "video_create_outcome_unknown" }); return null;
            }
            if (stage.phase === "unknown" && !stage.providerTaskId) return null;
            const action = stage.phase === "ready" ? "create" : ["completed", "failed", "rejected"].includes(stage.phase) ? "deliver" : "inspect";
            if (action === "inspect" && (stage.inspectAttempts >= policy.maxInspectAttempts || stage.observationDeadlineAt !== null && now() >= stage.observationDeadlineAt)) {
                await review(tx, task, "video_observation_limit");
                await repo.update(stage, { phase: "unknown", nextActionAt: null, claimToken: null, leaseUntil: null, lastReason: "video_observation_limit" }); return null;
            }
            if (action === "deliver" && stage.phase === "completed" && stage.downloadAttempts >= policy.maxDownloadAttempts && !["saved", "visible"].includes(task.deliveryStatus)) {
                await review(tx, task, "video_delivery_limit", false);
                await repo.update(stage, { nextActionAt: null, claimToken: null, leaseUntil: null, lastReason: "video_delivery_limit" }); return null;
            }
            if (task.executionStatus === "queued") task = await tasks.transitionExecution({ ownerId: task.ownerId, taskId: task.id, status: "running" });
            const leaseUntil = new Date(now().getTime() + policy.claimLeaseMs), token = crypto.randomUUID();
            stage = await repo.update(stage, { claimToken: token, leaseUntil, nextActionAt: leaseUntil,
                ...(action === "inspect" ? { inspectAttempts: stage.inspectAttempts + 1 } : {}),
                ...(action === "deliver" && stage.phase === "completed" ? { downloadAttempts: stage.downloadAttempts + 1 } : {}) });
            stage = await wake(tx, stage, task, leaseUntil);
            return { task, stage, action };
        });
        if (!claim) return null;
        const { task, action } = claim; let { stage } = claim;
        if (action === "create") {
            let prepared: Awaited<ReturnType<GenerationVideoDriverOptions["prepare"]>>;
            try { prepared = await options.prepare(task, stage); }
            catch {
                await db.transaction(async tx => {
                    const repo = createGenerationVideoStageRepository(tx), tasks = createGenerationTaskRepository(tx), current = await repo.lock(task.ownerId, task.id);
                    if (!current || current.phase !== "ready" || current.claimToken !== stage.claimToken || current.createAttemptToken || !current.leaseUntil || current.leaseUntil <= now()) return;
                    await createGenerationResultRepository(tx).create({ ownerId: task.ownerId, taskId: task.id, status: "failed", errorCode: "video_rejected_before_create", resultSnapshot: { kind: "video" } });
                    const failed = await tasks.transitionExecution({ ownerId: task.ownerId, taskId: task.id, status: "failed" });
                    const rejected = await repo.update(current, { phase: "rejected", claimToken: null, leaseUntil: null, nextActionAt: now(), lastReason: "video_rejected_before_create" });
                    await wake(tx, rejected, failed, now());
                }); return null;
            }
            const started = await db.transaction(async tx => {
                const repo = createGenerationVideoStageRepository(tx), current = await repo.lock(task.ownerId, task.id);
                if (!current || current.phase !== "ready" || current.claimToken !== stage.claimToken || !current.leaseUntil || current.leaseUntil <= now() || current.createAttemptToken) return null;
                const leaseUntil = new Date(now().getTime() + policy.claimLeaseMs);
                const marked = await repo.update(current, { phase: "create_started", createAttemptToken: current.claimToken, createStartedAt: now(), leaseUntil, nextActionAt: leaseUntil });
                return wake(tx, marked, task, leaseUntil);
            });
            if (!started) return null; stage = started;
            let response: VideoProviderResponse;
            try { response = await options.provider.create(binding(stage), prepared.input, stage.parametersSnapshot, prepared.reference); }
            catch { response = { source: VIDEO_PROTOCOL, status: "unknown", reason: "http_or_transport_unknown" }; }
            await observation(task, stage, response, true); return null;
        }
        if (action === "inspect") {
            let response: VideoProviderResponse;
            try { response = await options.provider.inspect(binding(stage), stage.providerTaskId!); }
            catch { response = { source: VIDEO_PROTOCOL, status: "unknown", reason: "http_or_transport_unknown", providerTaskId: stage.providerTaskId! }; }
            await observation(task, stage, response, false); return null;
        }
        const results = createGenerationResultRepository(db), result = await results.get(task.ownerId, task.id);
        if (!result) throw new Error("Completed video has no original result");
        let delivery: GenerationDeliveryResult = { status: "failed", errorCode: result.errorCode ?? undefined };
        if (result.status === "succeeded") {
            try {
                delivery = await options.deliver({ task, result, stage, commitProbe: async probe => db.transaction(async tx => {
                    const repo = createGenerationVideoStageRepository(tx), current = await repo.lock(task.ownerId, task.id);
                    if (!current || current.claimToken !== stage.claimToken || !current.leaseUntil || current.leaseUntil <= now()) return false;
                    await repo.update(current, { probeSnapshot: { ...probe } }); return true;
                }) });
            } catch { delivery = { status: "unknown", unknownReason: "video_delivery_unknown" }; }
        }
        return db.transaction(async tx => {
            const repo = createGenerationVideoStageRepository(tx), tasks = createGenerationTaskRepository(tx);
            const current = await repo.lock(task.ownerId, task.id); let updated = await tasks.get(task.ownerId, task.id), attached = result;
            if (!current || !updated || current.claimToken !== stage.claimToken || !current.leaseUntil || current.leaseUntil <= now()) return null;
            if ((delivery.status === "saved" || delivery.status === "visible") && delivery.media) {
                attached = await createGenerationResultRepository(tx).attachMedia({ ownerId: task.ownerId, taskId: task.id, media: delivery.media, videoDelivered: true });
                if (["pending", "unknown"].includes(updated.deliveryStatus)) updated = await tasks.transitionDelivery({ ownerId: task.ownerId, taskId: task.id, status: "saved" });
                if (delivery.status === "visible" && updated.deliveryStatus === "saved") updated = await tasks.transitionDelivery({ ownerId: task.ownerId, taskId: task.id, status: "visible" });
            } else if (result.status === "failed") {
                if (["pending", "unknown"].includes(updated.deliveryStatus)) updated = await tasks.transitionDelivery({ ownerId: task.ownerId, taskId: task.id, status: "failed" });
            } else updated = await review(tx, updated, "video_delivery_unknown", false);
            // Wallet operations have their own stable key/transaction. Do not call them
            // while holding the task transaction: settle only after durable media commit.
            await repo.update(current, { nextActionAt: current.leaseUntil, wakeDeadlineAt: null });
            return { task: updated, result: attached, delivery, replay: true };
        }).then(async output => {
            if (!output) return null;
            const billing = await options.settleBilling({ ...output, videoClaimToken: stage.claimToken ?? undefined });
            await db.transaction(async tx => {
                const repo = createGenerationVideoStageRepository(tx), tasks = createGenerationTaskRepository(tx), current = await repo.lock(task.ownerId, task.id);
                const actual = await tasks.get(task.ownerId, task.id);
                if (actual) output.task = actual;
                if (!current || current.claimToken !== stage.claimToken || !current.leaseUntil || current.leaseUntil <= now()) return;
                if (billing && output.task.billingStatus !== billing) output.task = await tasks.transitionBilling({ ownerId: task.ownerId, taskId: task.id, status: billing });
                await repo.update(current, { claimToken: null, leaseUntil: null,
                    nextActionAt: ["captured", "released"].includes(output.task.billingStatus) ? null : new Date(now().getTime() + policy.pollIntervalMs), wakeDeadlineAt: null });
            });
            return output;
        });
    }
    async function recover() {
        for (const row of await createGenerationVideoStageRepository(db).due(now(), policy.recoveryScanBatchSize)) {
            await db.transaction(async tx => {
                const repo = createGenerationVideoStageRepository(tx), stage = await repo.lock(row.ownerId, row.taskId);
                if (!stage || !stage.nextActionAt || stage.nextActionAt > now() || stage.wakeDeadlineAt && stage.wakeDeadlineAt > now()) return;
                const task = await createGenerationTaskRepository(tx).get(row.ownerId, row.taskId);
                if (task) await wake(tx, stage, task, now());
            });
        }
    }
    return { process, recover };
}
