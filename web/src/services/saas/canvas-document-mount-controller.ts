import type { JsonObject } from "../../../../packages/shared/src/index";
import type { CanvasDocumentMount } from "./canvas-document-mount";
import type { CanvasMountedVersion, CanvasVersionSelection } from "./canvas-version-save";

export type CanvasDocumentMountContext = Readonly<{
    accountId: string;
    epoch: number;
    projectId: string;
    currentProject: JsonObject;
    candidate: CanvasDocumentMount;
    cloudVersion?: CanvasVersionSelection;
    /** Session-only cloud media previews that must survive modal disposal after commit. */
    mediaObjectUrls?: readonly string[];
}>;

export type CanvasDocumentMountPlan = Readonly<{
    accountId: string;
    epoch: number;
    targetProjectId: string;
    currentProject: JsonObject;
    recoveryProject: JsonObject;
    replacementProject: JsonObject;
    unresolvedReferences: CanvasDocumentMount["unresolvedReferences"];
    /** Ownership transfers to the mounted canvas after commit. */
    mediaObjectUrls: readonly string[];
    cloudVersion: CanvasMountedVersion | null;
}>;

type CommitContext = Readonly<{
    accountId: string;
    epoch: number;
    projectId: string;
    currentProject: JsonObject;
}>;

type MountErrorCode = "invalid_context" | "context_changed" | "already_used" | "closed" | "pending";

const messages: Record<MountErrorCode, string> = {
    invalid_context: "正式挂载所需的账号或画布上下文不完整。",
    context_changed: "账号、项目或当前画布已变化，本次正式挂载已取消。",
    already_used: "这次正式挂载确认已经使用，请重新打开草稿后再准备。",
    closed: "正式挂载控制器已关闭，本次结果未采用。",
    pending: "正在保存挂载前恢复副本，请等待本次确认完成。",
};

export class CanvasDocumentMountControllerError extends Error {
    constructor(public readonly code: MountErrorCode) {
        super(messages[code]);
        this.name = "CanvasDocumentMountControllerError";
    }
}

const copy = <T>(value: T): T => {
    try { return JSON.parse(JSON.stringify(value)); }
    catch { throw new CanvasDocumentMountControllerError("invalid_context"); }
};
const sameProject = (left: unknown, right: unknown) => {
    try {
        const leftCopy = copy(left) as Record<string, unknown>, rightCopy = copy(right) as Record<string, unknown>;
        delete leftCopy.updatedAt; delete rightCopy.updatedAt;
        return JSON.stringify(leftCopy) === JSON.stringify(rightCopy);
    }
    catch { return false; }
};
const identity = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

function assertContext(context: CanvasDocumentMountContext | CommitContext): void {
    if (!identity(context.accountId) || !Number.isSafeInteger(context.epoch) || context.epoch < 0 || !identity(context.projectId) || typeof context.currentProject !== "object" || context.currentProject === null) {
        throw new CanvasDocumentMountControllerError("invalid_context");
    }
}

/**
 * Stages a checked document for an explicit replacement of one existing local
 * project. It never changes a canvas store or starts media/video work.
 */
export function createCanvasDocumentMountController() {
    let plan: CanvasDocumentMountPlan | null = null;
    let closed = false;
    let pending = false;

    function requireOpen() {
        if (closed) throw new CanvasDocumentMountControllerError("closed");
    }
    function requireIdle() {
        requireOpen();
        if (pending) throw new CanvasDocumentMountControllerError("pending");
    }
    function checkedPlan(context: CommitContext): CanvasDocumentMountPlan {
        assertContext(context);
        if (!plan) throw new CanvasDocumentMountControllerError("already_used");
        if (context.accountId !== plan.accountId || context.epoch !== plan.epoch || context.projectId !== plan.targetProjectId || !sameProject(context.currentProject, plan.currentProject)) {
            throw new CanvasDocumentMountControllerError("context_changed");
        }
        return plan;
    }

    return Object.freeze({
        prepare(context: CanvasDocumentMountContext): CanvasDocumentMountPlan {
            requireIdle();
            assertContext(context);
            if (context.candidate.status !== "mountable" || !identity(context.candidate.project.id)) {
                throw new CanvasDocumentMountControllerError("invalid_context");
            }
            const currentProject = copy(context.currentProject);
            if (typeof currentProject.createdAt !== "string") {
                throw new CanvasDocumentMountControllerError("invalid_context");
            }
            // The mount validator has already checked the project as JSON. The
            // editor's richer CanvasProject type contains non-JSON `unknown`
            // fields, so erase that implementation-only type at this boundary.
            const candidate = copy(context.candidate.project) as unknown as JsonObject;
            const cloud = context.cloudVersion;
            if (cloud && (cloud.accountId !== context.accountId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cloud.id) ||
                !Number.isSafeInteger(cloud.revision) || cloud.revision < 1 || typeof candidate.updatedAt !== "string" || !Number.isFinite(Date.parse(candidate.updatedAt)))) {
                throw new CanvasDocumentMountControllerError("invalid_context");
            }
            const replacementProject: JsonObject = {
                ...candidate,
                id: context.projectId,
                title: candidate.title,
                createdAt: currentProject.createdAt,
                updatedAt: new Date().toISOString(),
            };
            plan = Object.freeze({
                accountId: context.accountId,
                epoch: context.epoch,
                targetProjectId: context.projectId,
                currentProject,
                recoveryProject: copy(currentProject),
                replacementProject,
                unresolvedReferences: copy(context.candidate.unresolvedReferences),
                mediaObjectUrls: copy(context.mediaObjectUrls ?? []),
                cloudVersion: cloud ? { ...copy(cloud), epoch: context.epoch, localProjectId: context.projectId, updatedAt: candidate.updatedAt as string } : null,
            });
            return copy(plan);
        },
        commit(context: CommitContext): CanvasDocumentMountPlan {
            requireIdle();
            const committed = copy(checkedPlan(context));
            plan = null;
            return committed;
        },
        async commitAfterRecovery(
            readContext: () => CommitContext,
            persistRecovery: (plan: CanvasDocumentMountPlan) => Promise<unknown>,
            apply?: (committed: CanvasDocumentMountPlan) => void,
        ): Promise<CanvasDocumentMountPlan> {
            requireIdle();
            pending = true;
            try {
                const prepared = checkedPlan(readContext());
                await persistRecovery(copy(prepared));
                // Closing or changing context while IndexedDB commits must not
                // apply the old plan to a later editor/account session.
                requireOpen();
                const committed = copy(checkedPlan(readContext()));
                plan = null;
                // Apply synchronously with the final check, before another
                // microtask can change the editor context. A failed apply is
                // consumed too: its partial effects must not be retried.
                apply?.(copy(committed));
                return committed;
            } finally { pending = false; }
        },
        getPlan(): CanvasDocumentMountPlan | null { requireOpen(); return plan ? copy(plan) : null; },
        dispose() { closed = true; plan = null; },
    });
}
