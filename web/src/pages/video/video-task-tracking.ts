import { generationTracker, generationTrackingPresentation, type GenerationTrackerEntry, type GenerationTrackerRegistration } from "@/stores/use-generation-tracker";
import type { VideoGenerationScope, VideoGenerationTaskView } from "@/services/saas/video-generation";
export const videoTaskStatusSignature = (value: Pick<VideoGenerationTaskView["task"], "executionStatus" | "deliveryStatus" | "billingStatus">) => JSON.stringify([value.executionStatus, value.deliveryStatus, value.billingStatus]);
export function videoTaskResponseIsStale(before: GenerationTrackerEntry | undefined, after: GenerationTrackerEntry | undefined, scope: VideoGenerationScope, view: VideoGenerationTaskView) {
    if (!after || after.accountId !== scope.accountId || after.epoch !== scope.epoch || after.taskId !== view.task.id || after.kindHint !== "video") return false;
    if (videoTaskStatusSignature(after) === videoTaskStatusSignature(view.task)) return false;
    return !before || before.updatedAt !== after.updatedAt || videoTaskStatusSignature(before) !== videoTaskStatusSignature(after)
        || generationTrackingPresentation(after).terminal && !generationTrackingPresentation(view.task).terminal;
}
export function registerVideoTask(scope: VideoGenerationScope, view: VideoGenerationTaskView) {
    if (view.task.projectId !== null || view.task.nodeId != null) return;
    const value: GenerationTrackerRegistration = { ...scope, taskId: view.task.id, projectId: null, nodeId: null, modelId: view.task.modelId,
        originRoute: "/video", kindHint: "video", executionStatus: view.task.executionStatus, deliveryStatus: view.task.deliveryStatus, billingStatus: view.task.billingStatus };
    const tracker = generationTracker.getState();
    if (!tracker.reconcileVideoReceipt(value)) tracker.register(value);
}
