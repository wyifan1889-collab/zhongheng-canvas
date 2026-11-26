import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import type { Database } from "./client";
import { AccountModerationError, assertSafetyActor, type SafetyActor, type SafetyTx } from "./account-moderation";
import { auditEvent, generationTask, modelCatalog, modelProvider, modelProviderCredential, providerDiscoveredModel, providerDiscoveryReceipt } from "./schema";
import { lockModelMappingDraft, pruneProviderMappingDraft } from "./model-mapping-drafts";

export class CatalogDeletionError extends Error {
    constructor(readonly code: "catalog_not_found" | "catalog_revision_conflict" | "catalog_in_use" | "account_changed", message: string) { super(message); }
}
export type CatalogDeletionReceipt = { id: string; revision: number; modelIds: string[] };
const conflict = () => new CatalogDeletionError("catalog_revision_conflict", "配置已变化，请重新读取并核对后删除");
const missing = () => new CatalogDeletionError("catalog_not_found", "渠道或模型已删除，请重新读取配置");

async function activeAdmin(tx: SafetyTx, actor: SafetyActor) {
    try { await assertSafetyActor(tx, actor, true); }
    catch (error) {
        if (!(error instanceof AccountModerationError)) throw error;
        throw new CatalogDeletionError("account_changed", "登录状态已变化，本次删除未执行，请重新确认账号");
    }
}

export async function assertNoUnfinishedTasks(tx: SafetyTx, modelIds: string[]) {
    if (!modelIds.length) return;
    const [task] = await tx.select({ id: generationTask.id }).from(generationTask).where(and(
        inArray(generationTask.modelId, modelIds),
        or(inArray(generationTask.executionStatus, ["pending", "queued", "running", "unknown", "timeout"]),
            inArray(generationTask.billingStatus, ["reserved", "pending_review"]),
            eq(generationTask.deliveryStatus, "unknown"),
            and(eq(generationTask.executionStatus, "succeeded"), eq(generationTask.deliveryStatus, "pending"))),
    )).limit(1);
    if (task) throw new CatalogDeletionError("catalog_in_use", "仍有未结束或待核对的生成任务，请先在生成任务中处理，完成后再删除");
}

/** Parent deletion hides every child atomically, without rewriting historical prices or task bindings. */
export async function deleteCatalogProvider(db: Database, id: string, revision: number, actor: SafetyActor): Promise<CatalogDeletionReceipt> {
    return db.transaction(async tx => {
        const mapping = await lockModelMappingDraft(tx);
        const [provider] = await tx.select().from(modelProvider).where(eq(modelProvider.id, id)).for("update");
        if (!provider || provider.deletedAt) throw missing();
        if (provider.revision !== revision || revision >= 2_147_483_647) throw conflict();
        // New task admission holds this provider row FOR SHARE until its task/reservation commits.
        const models = await tx.select({ id: modelCatalog.publicId }).from(modelCatalog)
            .where(eq(modelCatalog.providerId, id)).orderBy(asc(modelCatalog.publicId));
        const modelIds = models.map(row => row.id);
        await assertNoUnfinishedTasks(tx, modelIds);
        await activeAdmin(tx, actor);
        const now = new Date();
        await tx.update(modelProvider).set({ deletedAt: now, enabled: false, revision: revision + 1, updatedAt: now }).where(eq(modelProvider.id, id));
        await tx.delete(providerDiscoveryReceipt).where(eq(providerDiscoveryReceipt.providerId, id));
        await tx.delete(providerDiscoveredModel).where(eq(providerDiscoveredModel.providerId, id));
        await tx.delete(modelProviderCredential).where(eq(modelProviderCredential.providerId, id));
        await pruneProviderMappingDraft(tx, mapping, id, [], actor);
        await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: actor.actorId,
            action: "provider.deleted", resourceId: id, revision: revision + 1, requestId: actor.requestId });
        return { id, revision: revision + 1, modelIds };
    });
}

export async function deleteCatalogModel(db: Database, id: string, revision: number, actor: SafetyActor): Promise<CatalogDeletionReceipt> {
    return db.transaction(async tx => {
        const [model] = await tx.select().from(modelCatalog).where(eq(modelCatalog.publicId, id)).for("update");
        if (!model || model.deletedAt) throw missing();
        if (model.revision !== revision || revision >= 2_147_483_647) throw conflict();
        const [provider] = await tx.select({ id: modelProvider.id }).from(modelProvider)
            .where(and(eq(modelProvider.id, model.providerId), isNull(modelProvider.deletedAt))).for("share");
        if (!provider) throw missing();
        await assertNoUnfinishedTasks(tx, [id]);
        await activeAdmin(tx, actor);
        const now = new Date();
        await tx.update(modelCatalog).set({ deletedAt: now, enabled: false, revision: revision + 1, updatedAt: now }).where(eq(modelCatalog.id, model.id));
        await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: actor.actorId,
            action: "model.deleted", resourceId: id, revision: revision + 1, requestId: actor.requestId });
        return { id, revision: revision + 1, modelIds: [id] };
    });
}
