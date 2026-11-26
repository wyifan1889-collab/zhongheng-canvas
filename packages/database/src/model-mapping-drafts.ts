import { and, asc, eq, isNull } from "drizzle-orm";
import { mappingBindingKey, parseMappingDraft, parseMappingDraftWrite, pruneMappingProvider, type MappingCatalog, type MappingDraftWrite } from "@infinite-canvas/shared";
import type { Database } from "./client";
import { auditEvent, modelMappingDraft, modelProvider, providerDiscoveredModel } from "./schema";
import { AccountModerationError, assertSafetyActor, type SafetyActor } from "./account-moderation";

export class ModelMappingDraftError extends Error {
    constructor(readonly code: "mapping_invalid" | "mapping_conflict" | "mapping_source_changed" | "account_changed", message: string) { super(message); }
}
const conflict = () => new ModelMappingDraftError("mapping_conflict", "统一配置已有新版本，请保留输入并重新读取核对");
const changed = () => new ModelMappingDraftError("mapping_source_changed", "渠道或型号目录已变化，请重新读取并核对来源后保存");
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Channel sync/deletion take this before model/provider locks, matching draft saves. */
export async function lockModelMappingDraft(tx: Tx) {
    const [row] = await tx.select().from(modelMappingDraft).where(eq(modelMappingDraft.id, "catalog")).for("update");
    const document = parseMappingDraft(row?.document);
    if (!row || !document) throw new Error("Invalid stored model mapping draft");
    return { ...row, document };
}
export async function pruneProviderMappingDraft(tx: Tx, row: Awaited<ReturnType<typeof lockModelMappingDraft>>, providerId: string, models: readonly string[], actor: SafetyActor) {
    const document = pruneMappingProvider(row.document, providerId, models);
    if (document === row.document) return;
    if (row.version >= 2_147_483_647) throw conflict();
    await tx.update(modelMappingDraft).set({ document, version: row.version + 1, updatedAt: new Date() }).where(eq(modelMappingDraft.id, "catalog"));
    await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: actor.actorId, action: "model.mapping.sources.removed", resourceId: providerId, revision: row.version + 1, requestId: actor.requestId });
}
async function active(tx: Tx, actor: SafetyActor) {
    try { await assertSafetyActor(tx, actor, true); }
    catch (error) { if (!(error instanceof AccountModerationError)) throw error; throw new ModelMappingDraftError("account_changed", "管理员会话已变化，请重新登录核对"); }
}

/** One consistent document and directory snapshot; no credentials leave the repository. */
export async function readModelMappingDraft(db: Database, actor: SafetyActor): Promise<MappingCatalog> {
    return db.transaction(async tx => {
        await active(tx, actor);
        const [row] = await tx.select().from(modelMappingDraft).where(eq(modelMappingDraft.id, "catalog"));
        const draft = parseMappingDraft(row?.document);
        if (!row || !draft) throw new Error("Invalid stored model mapping draft");
        const providers = await tx.select({ providerId: modelProvider.id, revision: modelProvider.revision }).from(modelProvider)
            .where(isNull(modelProvider.deletedAt)).orderBy(asc(modelProvider.id));
        const sources = await tx.select({ providerId: modelProvider.id, providerName: modelProvider.displayName, providerModel: providerDiscoveredModel.providerModel,
            providerEnabled: modelProvider.enabled, available: providerDiscoveredModel.available }).from(providerDiscoveredModel)
            .innerJoin(modelProvider, eq(modelProvider.id, providerDiscoveredModel.providerId)).where(isNull(modelProvider.deletedAt))
            .orderBy(asc(modelProvider.id), asc(providerDiscoveredModel.providerModel));
        return { version: row.version, draft, providers, sources };
    }, { isolationLevel: "repeatable read" });
}

/** Atomic draft CAS only. Saving never updates model_catalog, prices or tasks. */
export async function saveModelMappingDraft(db: Database, raw: MappingDraftWrite, actor: SafetyActor) {
    const input = parseMappingDraftWrite(raw);
    if (!input) throw new ModelMappingDraftError("mapping_invalid", "模型、规格、来源或价格草稿不完整，请核对后保存");
    return db.transaction(async tx => {
        const [row] = await tx.select().from(modelMappingDraft).where(eq(modelMappingDraft.id, "catalog")).for("update");
        if (!row || row.version !== input.expectedVersion) throw conflict();
        const previous = parseMappingDraft(row.document);
        if (!previous) throw new Error("Invalid stored model mapping draft");
        const oldBindings = new Map(previous.bindings.map(binding => [mappingBindingKey(binding), binding]));
        // Match discovery/deletion's provider lock; deterministic order prevents cross-channel deadlocks.
        for (const expected of [...input.providers].sort((a, b) => a.providerId.localeCompare(b.providerId))) {
            const [provider] = await tx.select({ revision: modelProvider.revision, deletedAt: modelProvider.deletedAt, adapter: modelProvider.adapter, endpoint: modelProvider.endpoint }).from(modelProvider)
                .where(eq(modelProvider.id, expected.providerId)).for("share");
            const revision = provider && !provider.deletedAt ? provider.revision : null;
            if (revision !== expected.revision) throw changed();
            const inventory = revision === null ? [] : await tx.select({ name: providerDiscoveredModel.providerModel, available: providerDiscoveredModel.available })
                .from(providerDiscoveredModel).where(eq(providerDiscoveredModel.providerId, expected.providerId)).for("share");
            for (const binding of input.draft.bindings.filter(item => item.providerId === expected.providerId)) {
                const old = oldBindings.get(mappingBindingKey(binding));
                const retained = old?.modelId === binding.modelId && old.specification === binding.specification &&
                    previous.models.find(model => model.id === old.modelId)?.capability === input.draft.models.find(model => model.id === binding.modelId)?.capability;
                if (!inventory.some(item => item.name === binding.providerModel && item.available) && !retained) throw changed();
                if (binding.execution && revision !== null) {
                    if (provider.adapter !== "openai-compatible") throw new ModelMappingDraftError("mapping_invalid", "该渠道接口与参数组合协议不一致");
                    if (binding.execution.protocol === "yunfei-grok-video-v1" && !/\/v1\/?$/.test(new URL(provider.endpoint).pathname))
                        throw new ModelMappingDraftError("mapping_invalid", "当前视频协议需要明确的 /v1 接口根地址");
                }
            }
        }
        await active(tx, actor);
        const version = row.version + 1;
        await tx.update(modelMappingDraft).set({ version, document: input.draft, updatedAt: new Date() }).where(and(eq(modelMappingDraft.id, "catalog"), eq(modelMappingDraft.version, row.version)));
        await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: actor.actorId, action: "model.mapping.draft.saved", resourceId: "catalog", revision: version, requestId: actor.requestId });
        return { version, draft: input.draft };
    });
}
