import localforage from "localforage";

export type CreationTaskExecutionStatus = "pending" | "queued" | "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "timeout";
export type CreationTaskDeliveryStatus = "pending" | "saved" | "visible" | "failed" | "unknown";
export type CreationTaskBillingStatus = "unbilled" | "reserved" | "captured" | "released" | "pending_review";

export type CreationTaskProjection = Readonly<{
    accountId: string;
    epoch: number;
    taskId: string;
    originRoute: string;
    kind: "image";
    modelId: string;
    priceVersion: number;
    quotedUnits: number;
    submittedAt: number;
    updatedAt: number;
    executionStatus: CreationTaskExecutionStatus;
    deliveryStatus: CreationTaskDeliveryStatus;
    billingStatus: CreationTaskBillingStatus;
}>;

export type CreationTaskProjectionBacking = {
    keys: () => Promise<string[]>;
    getItem: (key: string) => Promise<unknown>;
    setItem: (key: string, value: CreationTaskProjection) => Promise<unknown>;
};

const executionStatuses = new Set<CreationTaskExecutionStatus>(["pending", "queued", "running", "succeeded", "failed", "unknown", "cancelled", "timeout"]);
const deliveryStatuses = new Set<CreationTaskDeliveryStatus>(["pending", "saved", "visible", "failed", "unknown"]);
const billingStatuses = new Set<CreationTaskBillingStatus>(["unbilled", "reserved", "captured", "released", "pending_review"]);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const safeString = (value: unknown): value is string => typeof value === "string" && value.trim() === value && value.length > 0;
const safeUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const safePositiveInt = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
const safeTimestamp = (value: unknown) => Number.isFinite(value) && (value as number) > 0;

function parseProjection(value: unknown): CreationTaskProjection | null {
    if (
        !record(value) ||
        value.kind !== "image" ||
        !safeString(value.accountId) ||
        !Number.isSafeInteger(value.epoch) ||
        (value.epoch as number) < 0 ||
        !safeUuid(value.taskId) ||
        !safeString(value.originRoute) ||
        !safeString(value.modelId) ||
        !safePositiveInt(value.priceVersion) ||
        !safePositiveInt(value.quotedUnits) ||
        !safeTimestamp(value.submittedAt) ||
        !safeTimestamp(value.updatedAt) ||
        !executionStatuses.has(value.executionStatus as CreationTaskExecutionStatus) ||
        !deliveryStatuses.has(value.deliveryStatus as CreationTaskDeliveryStatus) ||
        !billingStatuses.has(value.billingStatus as CreationTaskBillingStatus)
    )
        return null;
    return Object.freeze({
        accountId: value.accountId,
        epoch: value.epoch as number,
        taskId: value.taskId,
        originRoute: value.originRoute,
        kind: "image",
        modelId: value.modelId,
        priceVersion: value.priceVersion as number,
        quotedUnits: value.quotedUnits as number,
        submittedAt: value.submittedAt as number,
        updatedAt: value.updatedAt as number,
        executionStatus: value.executionStatus as CreationTaskExecutionStatus,
        deliveryStatus: value.deliveryStatus as CreationTaskDeliveryStatus,
        billingStatus: value.billingStatus as CreationTaskBillingStatus,
    });
}

const prefix = (accountId: string) => `v1:${encodeURIComponent(accountId)}:`;
const keyFor = (value: Pick<CreationTaskProjection, "accountId" | "taskId">) => `${prefix(value.accountId)}${value.taskId.toLowerCase()}`;

const productionBacking: CreationTaskProjectionBacking = (() => {
    const db = localforage.createInstance({ name: "infinite-canvas", storeName: "creation_task_projections" });
    return { keys: () => db.keys(), getItem: (key) => db.getItem(key), setItem: (key, value) => db.setItem(key, value) };
})();

/**
 * Persisted ownership is account/task scoped. The returned epoch belongs to
 * the current page, so callers must still reject late reads after scope changes. It
 * never contains prompts, media or credentials, and it never creates or
 * retries a server task. The server task and receipt remain authoritative.
 */
export function createCreationTaskProjectionStore(backing: CreationTaskProjectionBacking = productionBacking) {
    return Object.freeze({
        async put(value: CreationTaskProjection) {
            const parsed = parseProjection(value);
            if (!parsed) throw new Error("生成任务状态投影无效。");
            await backing.setItem(keyFor(parsed), parsed);
        },
        async get(accountId: string, epoch: number, taskId: string) {
            if (!safeString(accountId) || !Number.isSafeInteger(epoch) || epoch < 0 || !safeUuid(taskId)) return null;
            const value = parseProjection(await backing.getItem(`${prefix(accountId)}${taskId.toLowerCase()}`));
            return value && value.accountId === accountId && value.taskId.toLowerCase() === taskId.toLowerCase() ? Object.freeze({ ...value, epoch }) : null;
        },
        async list(accountId: string, epoch: number) {
            const result: CreationTaskProjection[] = [];
            if (!safeString(accountId) || !Number.isSafeInteger(epoch) || epoch < 0) return result;
            for (const key of (await backing.keys()).filter((item) => item.startsWith(prefix(accountId)))) {
                const value = parseProjection(await backing.getItem(key));
                if (value && value.accountId === accountId && keyFor(value) === key) result.push(Object.freeze({ ...value, epoch }));
            }
            return result.sort((left, right) => right.updatedAt - left.updatedAt);
        },
    });
}

export function createCreationTaskProjection(value: Omit<CreationTaskProjection, "updatedAt"> & { updatedAt?: number }): CreationTaskProjection {
    const parsed = parseProjection({ ...value, updatedAt: value.updatedAt ?? Date.now() });
    if (!parsed) throw new Error("生成任务状态投影无效。");
    return parsed;
}
