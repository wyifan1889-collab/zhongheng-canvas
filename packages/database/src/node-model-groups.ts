import { and, eq, isNull } from "drizzle-orm";
import { NODE_MODEL_GROUP_CAPABILITIES, parseNodeModelGroups, type NodeModelGroups, type NodeModelGroupsWrite } from "@infinite-canvas/shared";
import type { Database } from "./client";
import { auditEvent, modelCatalog, modelNodeGroups, modelPricing, modelProvider, providerDiscoveredModel } from "./schema";
import { AccountModerationError, assertSafetyActor } from "./account-moderation";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Actor = { actorId: string; sessionId: string; sessionExpiresAt: Date; requestId: string };
export type NodeModelWrite = { providerId: string; providerModel: string; displayName: string;
    capability: "text" | "image" | "video" | "audio"; enabled: boolean; groupId: string | null; revision: number };
export class NodeModelConfigurationError extends Error {
    constructor(readonly code: "model_group_conflict" | "model_group_in_use" | "model_group_invalid" | "model_revision_conflict" |
        "model_pricing_binding_conflict" | "provider_not_found" | "account_changed", message: string) { super(message); }
}
const conflict = () => new NodeModelConfigurationError("model_revision_conflict", "模型已更新或该渠道型号已被配置，请重新读取后保存");
const groupConflict = () => new NodeModelConfigurationError("model_group_conflict", "分组已更新，请重新读取后保存");

async function activeActor(tx: Tx, actor: Actor) {
    try { await assertSafetyActor(tx, actor, true); }
    catch (error) {
        if (!(error instanceof AccountModerationError)) throw error;
        throw new NodeModelConfigurationError("account_changed", "登录状态已变化，请重新确认账号后保存");
    }
}

export async function listNodeModelGroups(db: Database | Tx): Promise<NodeModelGroups[]> {
    const rows = await db.select({ capability: modelNodeGroups.capability, version: modelNodeGroups.version, groups: modelNodeGroups.groups })
        .from(modelNodeGroups);
    return NODE_MODEL_GROUP_CAPABILITIES.map(capability => {
        const parsed = parseNodeModelGroups(rows.find(row => row.capability === capability));
        if (!parsed) throw new Error("Invalid stored node model groups");
        return parsed;
    });
}

export async function saveNodeModelGroups(db: Database, input: NodeModelGroupsWrite, actor: Actor): Promise<NodeModelGroups> {
    return db.transaction(async tx => {
        const [current] = await tx.select().from(modelNodeGroups).where(eq(modelNodeGroups.capability, input.capability)).for("update");
        if (!current || current.version !== input.expectedVersion || current.version >= 2_147_483_647) throw groupConflict();
        const kept = new Set(input.groups.map(group => group.id));
        // Model assignments take a shared lock on this same row. Removal cannot
        // race a new assignment, and existing assignments are never detached silently.
        const references = await tx.select({ groupId: modelCatalog.groupId }).from(modelCatalog)
            .innerJoin(modelProvider, eq(modelProvider.id, modelCatalog.providerId))
            .where(and(eq(modelCatalog.capability, input.capability), isNull(modelCatalog.deletedAt), isNull(modelProvider.deletedAt)));
        if (references.some(model => model.groupId !== null && !kept.has(model.groupId))) {
            throw new NodeModelConfigurationError("model_group_in_use", "分组仍被模型使用，请先调整模型归属");
        }
        await activeActor(tx, actor);
        const version = current.version + 1;
        await tx.update(modelNodeGroups).set({ groups: input.groups, version, updatedAt: new Date() }).where(eq(modelNodeGroups.capability, input.capability));
        await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: actor.actorId, action: "model.groups.saved", resourceId: input.capability, revision: version, requestId: actor.requestId });
        return { capability: input.capability, version, groups: input.groups };
    });
}

/** Model identity, presentation and group assignment update atomically; no price writes. */
export async function saveNodeModel(db: Database, publicId: string, input: NodeModelWrite, actor: Actor) {
    return db.transaction(async tx => {
        const [existing] = await tx.select().from(modelCatalog).where(eq(modelCatalog.publicId, publicId)).for("update");
        if (existing?.deletedAt) throw conflict();
        if ((existing?.revision ?? 0) !== input.revision || input.revision >= 2_147_483_647) throw conflict();
        if (existing && existing.providerId !== input.providerId) {
            const [original] = await tx.select({ id: modelProvider.id }).from(modelProvider)
                .where(and(eq(modelProvider.id, existing.providerId), isNull(modelProvider.deletedAt))).for("share");
            if (!original) throw conflict();
        }
        const [provider] = await tx.select({ id: modelProvider.id }).from(modelProvider)
            .where(and(eq(modelProvider.id, input.providerId), isNull(modelProvider.deletedAt))).for("share");
        if (!provider) throw new NodeModelConfigurationError("provider_not_found", "渠道不存在，请重新选择");
        if (!existing || existing.providerId !== input.providerId || existing.providerModel !== input.providerModel) {
            const [source] = await tx.select({ available: providerDiscoveredModel.available }).from(providerDiscoveredModel)
                .where(and(eq(providerDiscoveredModel.providerId, input.providerId), eq(providerDiscoveredModel.providerModel, input.providerModel)));
            if (!source?.available) throw new NodeModelConfigurationError("model_revision_conflict", "渠道目录已变化，该型号不可再配置，请重新读取模型库");
        }
        if (input.groupId !== null) {
            const [groupSet] = await tx.select().from(modelNodeGroups).where(eq(modelNodeGroups.capability, input.capability)).for("share");
            if (!groupSet?.groups.some(group => group.id === input.groupId)) throw new NodeModelConfigurationError("model_group_invalid", "分组不存在或不属于该节点类型，请重新选择");
        }
        if (existing && (existing.providerId !== input.providerId || existing.providerModel !== input.providerModel || existing.capability !== input.capability)) {
            const [price] = await tx.select({ id: modelPricing.id }).from(modelPricing).where(eq(modelPricing.modelId, existing.id)).limit(1);
            if (price) throw new NodeModelConfigurationError("model_pricing_binding_conflict", "该模型已有价格记录，不能更换渠道、渠道型号或节点类型");
        }
        await activeActor(tx, actor);
        const values = { providerId: input.providerId, providerModel: input.providerModel, displayName: input.displayName,
            capability: input.capability, enabled: input.enabled, groupId: input.groupId, revision: input.revision + 1, updatedAt: new Date() };
        if (existing) {
            await tx.update(modelCatalog).set(values).where(eq(modelCatalog.id, existing.id));
        } else {
            const rows = await tx.insert(modelCatalog).values({ ...values, id: crypto.randomUUID(), publicId }).onConflictDoNothing().returning({ id: modelCatalog.id });
            if (!rows.length) throw conflict();
        }
        await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: actor.actorId, action: "model.saved", resourceId: publicId, revision: values.revision, requestId: actor.requestId });
    });
}
