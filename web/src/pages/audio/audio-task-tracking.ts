import type { AudioGenerationScope, AudioGenerationTaskView } from "@/services/saas/audio-generation";
import { generationTracker, generationTrackingPresentation, type GenerationTrackerEntry, type GenerationTrackerRegistration } from "@/stores/use-generation-tracker";

type Tracker = { getState: () => {
    entries?: Readonly<Record<string, GenerationTrackerEntry>>;
    register: (value: GenerationTrackerRegistration) => void;
    reconcileAudioReceipt: (value: GenerationTrackerRegistration) => boolean;
} };
type Status = Pick<AudioGenerationTaskView["task"], "executionStatus" | "deliveryStatus" | "billingStatus">;
export const audioTaskStatusSignature = (value: Status) => JSON.stringify([value.executionStatus, value.deliveryStatus, value.billingStatus]);

export function audioTaskResponseIsStale(before: GenerationTrackerEntry | undefined, after: GenerationTrackerEntry | undefined, scope: AudioGenerationScope, view: AudioGenerationTaskView) {
    if (!after || after.accountId !== scope.accountId || after.epoch !== scope.epoch || after.taskId !== view.task.id || after.kindHint !== "audio") return false;
    const status = audioTaskStatusSignature(after);
    if (status === audioTaskStatusSignature(view.task)) return false;
    return !before || before.updatedAt !== after.updatedAt || audioTaskStatusSignature(before) !== status
        || generationTrackingPresentation(after).terminal && !generationTrackingPresentation(view.task).terminal;
}

export function audioTaskReadIssue(entry: GenerationTrackerEntry | undefined, scope: AudioGenerationScope, taskId?: string) {
    if (!entry || entry.accountId !== scope.accountId || entry.epoch !== scope.epoch || entry.taskId !== taskId || entry.kindHint !== "audio") return undefined;
    if (entry.readStatus === "missing") return "暂未查到原任务，自动读取已暂停。请保留回执并查询原任务；不会重新生成。";
    if (entry.readStatus === "unconfirmed") return "原任务状态读取未能确认，请主动查询原任务；不会重新生成。";
    return undefined;
}

/** Called only after the audio client verifies a task and its original receipt is saved. */
export function createAudioTaskRegistration(options: {
    scope: AudioGenerationScope; getScope: () => AudioGenerationScope | null; isCurrent: () => boolean; tracker?: Tracker;
}) {
    return (receiptTaskId: string, view: AudioGenerationTaskView) => {
        const current = options.getScope(), task = view.task;
        if (!options.isCurrent() || current?.accountId !== options.scope.accountId || current.epoch !== options.scope.epoch
            || task.id !== receiptTaskId || task.projectId !== null || task.nodeId !== null
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(task.id)) return;
        const value: GenerationTrackerRegistration = { ...options.scope, taskId: task.id, projectId: null, nodeId: null,
            modelId: task.modelId, originRoute: "/audio", kindHint: "audio", executionStatus: task.executionStatus,
            deliveryStatus: task.deliveryStatus, billingStatus: task.billingStatus };
        const tracker = (options.tracker ?? generationTracker).getState();
        const previous = Object.values(tracker.entries ?? {}).find(entry => entry.accountId === options.scope.accountId && entry.epoch === options.scope.epoch && entry.taskId === task.id);
        if (audioTaskResponseIsStale(previous, previous, options.scope, view)) return;
        if (!tracker.reconcileAudioReceipt(value)) tracker.register(value);
    };
}
