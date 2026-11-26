import { createHmac } from "node:crypto";
import { and, asc, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { Database } from "./client";
import { decryptProviderCredential, encryptProviderCredential } from "./provider-credentials";
import { auditEvent, modelCatalog, modelProvider, modelProviderCredential, providerDiscoveredModel, providerDiscoveryReceipt } from "./schema";
import { AccountModerationError, assertSafetyActor } from "./account-moderation";
import { assertNoUnfinishedTasks } from "./catalog-deletion";
import { lockModelMappingDraft, pruneProviderMappingDraft } from "./model-mapping-drafts";

export type ProviderWrite = {
    displayName: string; adapter: "openai-compatible" | "sub2api"; endpoint: string;
    enabled: boolean; apiKey?: string; revision: number; discoveryReceiptId?: string;
};
export type DiscoveryActor = { actorId: string; sessionId: string; sessionExpiresAt: Date };
type Target = { providerId: string; adapter: ProviderWrite["adapter"]; endpoint: string; credential: string };
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

export class ProviderDiscoveryError extends Error {
    constructor(readonly code: "provider_revision_conflict" | "provider_discovery_required" | "provider_discovery_invalid" | "provider_credential_required" | "account_changed", message: string) { super(message); }
}
const conflict = () => new ProviderDiscoveryError("provider_revision_conflict", "渠道已更新，请重新读取渠道配置和模型目录后保存");
const invalidReceipt = () => new ProviderDiscoveryError("provider_discovery_invalid", "读取结果已失效或与当前配置不一致，请重新测试并读取模型");

function fingerprint(secret: string, target: Target): string {
    return createHmac("sha256", secret).update("infinite-canvas/provider-discovery/v1\0")
        .update(JSON.stringify([target.providerId, target.adapter, target.endpoint, target.credential])).digest("hex");
}

async function activeActor(tx: Tx, actor: DiscoveryActor): Promise<void> {
    try { await assertSafetyActor(tx, { ...actor, requestId: "provider-discovery" }, true); }
    catch (error) {
        if (!(error instanceof AccountModerationError)) throw error;
        throw new ProviderDiscoveryError("account_changed", "登录状态已变化，请重新确认账号后读取模型");
    }
}

async function currentProvider(db: Database | Tx, providerId: string, lock = false) {
    const query = db.select().from(modelProvider).where(eq(modelProvider.id, providerId));
    const [provider] = await (lock ? query.for("update") : query);
    if (provider?.deletedAt) throw conflict();
    return provider;
}

async function targetFor(db: Database | Tx, secret: string, providerId: string, input: ProviderWrite): Promise<Target> {
    let credential = input.apiKey?.trim();
    if (!credential) {
        const [stored] = await db.select().from(modelProviderCredential).where(eq(modelProviderCredential.providerId, providerId));
        if (stored) credential = decryptProviderCredential(secret, providerId, stored);
    }
    if (!credential) throw new ProviderDiscoveryError("provider_credential_required", "请先填写渠道 API Key");
    return { providerId, adapter: input.adapter, endpoint: input.endpoint, credential };
}

/** Snapshot config and Key under one lock, release it before any network request. */
export async function prepareProviderDiscovery(db: Database, secret: string, providerId: string, input: ProviderWrite, actor: DiscoveryActor): Promise<Target> {
    return db.transaction(async tx => {
        await activeActor(tx, actor);
        const provider = await currentProvider(tx, providerId, true);
        if ((provider?.revision ?? 0) !== input.revision) throw conflict();
        return targetFor(tx, secret, providerId, input);
    });
}

export async function recordProviderDiscovery(db: Database, secret: string, target: Target, revision: number, models: string[], actor: DiscoveryActor) {
    return db.transaction(async tx => {
        await activeActor(tx, actor);
        const provider = await currentProvider(tx, target.providerId, true);
        if ((provider?.revision ?? 0) !== revision) throw conflict();
        const previous = await tx.select().from(providerDiscoveredModel).where(eq(providerDiscoveredModel.providerId, target.providerId));
        const prior = new Set(previous.filter(row => row.available).map(row => row.providerModel));
        const found = new Set(models);
        const bindings = await tx.select({ id: modelCatalog.publicId, displayName: modelCatalog.displayName,
            providerModel: modelCatalog.providerModel, enabled: modelCatalog.enabled })
            .from(modelCatalog).where(and(eq(modelCatalog.providerId, target.providerId), isNull(modelCatalog.deletedAt))).orderBy(asc(modelCatalog.displayName), asc(modelCatalog.publicId));
        const receiptId = crypto.randomUUID();
        await tx.insert(providerDiscoveryReceipt).values({ id: receiptId, actorId: actor.actorId, sessionId: actor.sessionId,
            providerId: target.providerId, revision, targetFingerprint: fingerprint(secret, target), models, expiresAt: actor.sessionExpiresAt });
        return { providerId: target.providerId, receiptId, revision, models,
            added: models.filter(id => !prior.has(id)), missing: [...prior].filter(id => !found.has(id)),
            unchanged: models.filter(id => prior.has(id)).length,
            bindings: bindings.map(row => ({ ...row, found: found.has(row.providerModel) })) };
    });
}

/** Complete inventory replacement and missing-model retirement share one transaction. Prices/tasks stay historical. */
export async function saveDiscoveredProvider(db: Database, secret: string, providerId: string, input: ProviderWrite,
    actor: DiscoveryActor & { requestId: string }) {
    return db.transaction(async tx => {
        if (!input.discoveryReceiptId) {
            await activeActor(tx, actor);
            const provider = await currentProvider(tx, providerId, true);
            if (!provider || input.enabled || input.apiKey?.trim() || input.displayName !== provider.displayName ||
                input.endpoint !== provider.endpoint || input.adapter !== provider.adapter) {
                throw new ProviderDiscoveryError("provider_discovery_required", "保存渠道前请先读取并核对模型目录；仅停用现有渠道可单独操作");
            }
            if (provider.revision !== input.revision || input.revision >= 2_147_483_647) throw conflict();
            await activeActor(tx, actor);
            const [saved] = await tx.update(modelProvider).set({ enabled: false, revision: provider.revision + 1, updatedAt: new Date() }).where(eq(modelProvider.id, providerId)).returning();
            await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: actor.actorId, action: "provider.disabled", resourceId: providerId, revision: saved.revision, requestId: actor.requestId });
            const [credential] = await tx.select({ id: modelProviderCredential.providerId }).from(modelProviderCredential).where(eq(modelProviderCredential.providerId, providerId));
            return { id: saved.id, displayName: saved.displayName, adapter: saved.adapter, endpoint: saved.endpoint, enabled: false,
                revision: saved.revision, credentialConfigured: Boolean(credential), createdAt: saved.createdAt, updatedAt: saved.updatedAt, removedModelIds: [] as string[] };
        }
        const mapping = await lockModelMappingDraft(tx);
        await activeActor(tx, actor);
        const [snapshot] = await tx.select().from(providerDiscoveryReceipt).where(eq(providerDiscoveryReceipt.id, input.discoveryReceiptId));
        if (!snapshot || snapshot.actorId !== actor.actorId || snapshot.sessionId !== actor.sessionId || snapshot.providerId !== providerId ||
            snapshot.revision !== input.revision || snapshot.expiresAt <= new Date()) throw invalidReceipt();
        const missingModels = () => tx.select({ id: modelCatalog.id, publicId: modelCatalog.publicId, revision: modelCatalog.revision }).from(modelCatalog)
            .where(and(eq(modelCatalog.providerId, providerId), isNull(modelCatalog.deletedAt), snapshot.models.length ? notInArray(modelCatalog.providerModel, snapshot.models) : undefined))
            .orderBy(asc(modelCatalog.id));
        // All existing catalog writers/admission lock model before provider. Preserve that order.
        const removing = await missingModels().for("update");
        const provider = await currentProvider(tx, providerId, true);
        if ((provider?.revision ?? 0) !== input.revision || input.revision >= 2_147_483_647) throw conflict();
        const currentMissing = await missingModels();
        // A model created/rebound while acquiring the provider lock must be reviewed in a new attempt.
        if (currentMissing.length !== removing.length || currentMissing.some((item, i) => item.id !== removing[i].id) ||
            removing.some(item => item.revision >= 2_147_483_647)) throw conflict();
        await assertNoUnfinishedTasks(tx, removing.map(item => item.publicId));
        const key = input.apiKey?.trim();
        let receipt: typeof providerDiscoveryReceipt.$inferSelect | undefined;
        if (input.discoveryReceiptId) {
            [receipt] = await tx.select().from(providerDiscoveryReceipt).where(eq(providerDiscoveryReceipt.id, input.discoveryReceiptId)).for("update");
            if (!receipt || receipt.actorId !== actor.actorId || receipt.sessionId !== actor.sessionId || receipt.providerId !== providerId ||
                receipt.revision !== input.revision || receipt.expiresAt <= new Date()) throw invalidReceipt();
            const target = await targetFor(tx, secret, providerId, input);
            if (receipt.targetFingerprint !== fingerprint(secret, target)) throw invalidReceipt();
        }
        await activeActor(tx, actor);
        const now = new Date(), revision = input.revision + 1;
        let saved: typeof modelProvider.$inferSelect;
        if (provider) {
            [saved] = await tx.update(modelProvider).set({ displayName: input.displayName, endpoint: input.endpoint, adapter: input.adapter,
                enabled: input.enabled, revision, updatedAt: now }).where(eq(modelProvider.id, providerId)).returning();
        } else {
            const rows = await tx.insert(modelProvider).values({ id: providerId, displayName: input.displayName, endpoint: input.endpoint,
                adapter: input.adapter, enabled: input.enabled, revision, secretRef: `db:model-provider-credential:${providerId}` })
                .onConflictDoNothing().returning();
            if (!rows[0]) throw conflict();
            saved = rows[0];
        }
        if (key) {
            const encrypted = encryptProviderCredential(secret, providerId, key);
            await tx.insert(modelProviderCredential).values({ providerId, ...encrypted }).onConflictDoUpdate({ target: modelProviderCredential.providerId,
                set: { ...encrypted, updatedAt: now } });
        }
        const [credential] = await tx.select({ id: modelProviderCredential.providerId }).from(modelProviderCredential).where(eq(modelProviderCredential.providerId, providerId));
        if (input.enabled && !credential) throw new ProviderDiscoveryError("provider_credential_required", "启用渠道前必须配置 API Key");
        if (receipt) {
            await tx.delete(providerDiscoveredModel).where(and(eq(providerDiscoveredModel.providerId, providerId),
                receipt.models.length ? notInArray(providerDiscoveredModel.providerModel, receipt.models) : undefined));
            if (receipt.models.length) {
                await tx.insert(providerDiscoveredModel).values(receipt.models.map(providerModel => ({ providerId, providerModel,
                    available: true, firstSeenAt: receipt!.createdAt, lastSeenAt: receipt!.createdAt })))
                    .onConflictDoUpdate({ target: [providerDiscoveredModel.providerId, providerDiscoveredModel.providerModel],
                        set: { available: true, lastSeenAt: receipt.createdAt } });
            }
            if (removing.length) await tx.update(modelCatalog).set({ deletedAt: now, enabled: false, revision: sql`${modelCatalog.revision} + 1`, updatedAt: now })
                .where(inArray(modelCatalog.id, removing.map(item => item.id)));
            await pruneProviderMappingDraft(tx, mapping, providerId, receipt.models, actor);
            await tx.delete(providerDiscoveryReceipt).where(eq(providerDiscoveryReceipt.id, receipt.id));
        }
        await tx.insert(auditEvent).values({ id: crypto.randomUUID(), actorId: actor.actorId, action: "provider.saved",
            resourceId: providerId, revision, requestId: actor.requestId });
        return { id: saved.id, displayName: saved.displayName, adapter: saved.adapter, endpoint: saved.endpoint,
            enabled: saved.enabled, revision: saved.revision, credentialConfigured: Boolean(credential), createdAt: saved.createdAt, updatedAt: saved.updatedAt,
            removedModelIds: removing.map(item => item.publicId) };
    });
}

export async function listDiscoveredProviderModels(db: Database) {
    return db.select({ providerId: providerDiscoveredModel.providerId, providerName: modelProvider.displayName,
        providerEnabled: modelProvider.enabled, providerModel: providerDiscoveredModel.providerModel,
        available: providerDiscoveredModel.available, firstSeenAt: providerDiscoveredModel.firstSeenAt,
        lastSeenAt: providerDiscoveredModel.lastSeenAt, boundModelId: modelCatalog.publicId })
        .from(providerDiscoveredModel).innerJoin(modelProvider, eq(modelProvider.id, providerDiscoveredModel.providerId))
        .leftJoin(modelCatalog, and(eq(modelCatalog.providerId, providerDiscoveredModel.providerId), eq(modelCatalog.providerModel, providerDiscoveredModel.providerModel), isNull(modelCatalog.deletedAt)))
        .where(isNull(modelProvider.deletedAt))
        .orderBy(asc(providerDiscoveredModel.providerId), asc(providerDiscoveredModel.providerModel));
}
