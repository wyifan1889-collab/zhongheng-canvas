import localforage from "localforage";
import { accountScopedStoreName, type AccountLocalScope } from "@/services/saas/account-local-scope";
import { createGenerationReceiptStore } from "@/services/saas/canvas-image-generation";
import { IMAGE_WORKBENCH_PROJECT_ID } from "./platform-image-workbench";
import { validImageConversationId } from "@/lib/creation-routes";

export type ImageRoundDetails = { conversationId: string; prompt: string; model: string; count: string; startedAt: number; intent?: string };
export const imageWorkbenchReceipts = createGenerationReceiptStore(undefined, "infinite-canvas-workbench-image-receipts");

export function imageRoundStorage(scope: NonNullable<AccountLocalScope>) {
    return localforage.createInstance({ name: "infinite-canvas", storeName: accountScopedStoreName("workbench_image_rounds", scope) });
}

const listeners = new Set<() => void>();
export function subscribeImageConversations(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
export function notifyImageConversationsChanged() {
    for (const listener of listeners) listener();
}

export async function readImageConversationRounds(scope: NonNullable<AccountLocalScope>) {
    const storage = imageRoundStorage(scope);
    const receipts = await imageWorkbenchReceipts.list(scope.accountId, IMAGE_WORKBENCH_PROJECT_ID);
    const rounds = await Promise.all(receipts.map(async receipt => ({ receipt, details: await storage.getItem<ImageRoundDetails>(receipt.idempotencyKey) })));
    return rounds.flatMap(({ receipt, details }) => details && validImageConversationId(details.conversationId) && typeof details.prompt === "string" &&
        Number.isFinite(details.startedAt) ? [{ receipt, details }] : []);
}

export async function readImageConversations(scope: NonNullable<AccountLocalScope>) {
    const rounds = await readImageConversationRounds(scope);
    const conversations = new Map<string, { id: string; title: string; updatedAt: number; turns: number; taskIds: string[] }>();
    for (const { details, receipt } of rounds.sort((a, b) => a.details.startedAt - b.details.startedAt)) {
        const existing = conversations.get(details.conversationId);
        if (existing) {
            existing.turns++;
            existing.updatedAt = details.startedAt;
            if (receipt.taskId) existing.taskIds.push(receipt.taskId);
        } else conversations.set(details.conversationId, { id: details.conversationId, title: details.prompt,
            updatedAt: details.startedAt, turns: 1, taskIds: receipt.taskId ? [receipt.taskId] : [] });
    }
    return [...conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
