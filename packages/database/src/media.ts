import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "./client";
import { mediaObject, storageQuota } from "./schema";

export const INITIAL_STORAGE_QUOTA_BYTES = 1024 * 1024 * 1024;
export type MediaKind = "image" | "video" | "audio";

export type MediaRecord = {
    id: string;
    ownerId: string;
    objectKey: string;
    kind: MediaKind;
    contentType: string;
    sizeBytes: number;
    etag: string;
    createdAt: string;
};

function toRecord(row: typeof mediaObject.$inferSelect): MediaRecord {
    return { ...row, createdAt: row.createdAt.toISOString() };
}

function referencedCloudMediaIds(document: unknown): Set<string> {
    const ids = new Set<string>();
    function walk(value: unknown) {
        if (Array.isArray(value)) { value.forEach(walk); return; }
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value)) {
            if (key === "cloudMediaId" && typeof child === "string" && child.length > 0) ids.add(child.toLowerCase());
            else walk(child);
        }
    }
    walk(document);
    return ids;
}

export function createMediaRepository(db: Database) {
    async function ensureQuota(ownerId: string, quotaBytes = INITIAL_STORAGE_QUOTA_BYTES) {
        await db.insert(storageQuota).values({ userId: ownerId, quotaBytes }).onConflictDoNothing();
        const [quota] = await db.select().from(storageQuota).where(eq(storageQuota.userId, ownerId));
        if (!quota) throw new Error("存储额度记录不存在");
        return quota;
    }

    return {
        ensureQuota,
        async getQuota(ownerId: string, quotaBytes = INITIAL_STORAGE_QUOTA_BYTES) {
            const quota = await ensureQuota(ownerId, quotaBytes);
            return { quotaBytes: quota.quotaBytes, usedBytes: quota.usedBytes, availableBytes: quota.quotaBytes - quota.usedBytes };
        },
        async reserve(ownerId: string, sizeBytes: number, quotaBytes = INITIAL_STORAGE_QUOTA_BYTES) {
            if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error("媒体大小无效");
            await ensureQuota(ownerId, quotaBytes);
            const [row] = await db.update(storageQuota).set({
                usedBytes: sql`${storageQuota.usedBytes} + ${sizeBytes}`,
                updatedAt: new Date(),
            }).where(and(
                eq(storageQuota.userId, ownerId),
                sql`${storageQuota.usedBytes} + ${sizeBytes} <= ${storageQuota.quotaBytes}`,
            )).returning();
            return !!row;
        },
        async release(ownerId: string, sizeBytes: number) {
            if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error("媒体大小无效");
            await db.update(storageQuota).set({
                usedBytes: sql`GREATEST(${storageQuota.usedBytes} - ${sizeBytes}, 0)`,
                updatedAt: new Date(),
            }).where(eq(storageQuota.userId, ownerId));
        },
        async add(ownerId: string, input: Omit<MediaRecord, "ownerId" | "createdAt">) {
            const [row] = await db.insert(mediaObject).values({ ownerId, ...input }).returning();
            if (!row) throw new Error("媒体记录未创建");
            return toRecord(row);
        },
        async get(ownerId: string, id: string) {
            const [row] = await db.select().from(mediaObject).where(and(eq(mediaObject.ownerId, ownerId), eq(mediaObject.id, id)));
            return row ? toRecord(row) : null;
        },
        async resolve(ownerId: string, ids: string[]) {
            if (!ids.length) return [];
            const rows = await db.select().from(mediaObject).where(and(eq(mediaObject.ownerId, ownerId), inArray(mediaObject.id, ids)));
            const byId = new Map(rows.map((row) => [row.id, toRecord(row)]));
            return ids.flatMap((id) => { const item = byId.get(id); return item ? [item] : []; });
        },
        /**
         * Resolve media while holding a key-share lock for the surrounding
         * transaction. A media delete takes the matching update lock, so a
         * cloud draft save cannot commit a reference after deletion wins.
         */
        async resolveForSave(ownerId: string, ids: string[]) {
            if (!ids.length) return [];
            // Acquire locks in a stable order so two concurrent saves that
            // reference the same media set cannot deadlock on traversal order.
            const lockIds = [...new Set(ids)].sort();
            const rows = await db.select().from(mediaObject)
                .where(and(eq(mediaObject.ownerId, ownerId), inArray(mediaObject.id, lockIds)))
                .orderBy(asc(mediaObject.id))
                .for("key share");
            const byId = new Map(rows.map((row) => [row.id, toRecord(row)]));
            return ids.flatMap((id) => { const item = byId.get(id); return item ? [item] : []; });
        },
        /**
         * Call after lockAccess(actorId, canvasId, "write") in the same transaction.
         * existingDocument must be that locked canvas's saved document, never the
         * submitted replacement. An editor may retain its existing references and
         * add their own media, but cannot import another account's unreferenced ID.
         * Missing or disallowed IDs are omitted for the caller's completeness check.
         */
        async resolveForCanvasSave(actorId: string, ids: string[], existingDocument: unknown): Promise<MediaRecord[]> {
            if (!ids.length) return [];
            const lockIds = [...new Set(ids)].sort();
            const references = referencedCloudMediaIds(existingDocument);
            const retainedIds = lockIds.filter((id) => references.has(id.toLowerCase()));
            const rows = await db.select().from(mediaObject)
                .where(and(inArray(mediaObject.id, lockIds), or(
                    eq(mediaObject.ownerId, actorId),
                    retainedIds.length ? inArray(mediaObject.id, retainedIds) : undefined,
                )))
                .orderBy(asc(mediaObject.id))
                .for("key share");
            const byId = new Map(rows.map((row) => [row.id, toRecord(row)]));
            return ids.flatMap((id) => { const item = byId.get(id); return item ? [item] : []; });
        },
        /**
         * Call after lockAccess(actorId, canvasId, "read") in the same transaction.
         * Only IDs referenced by that authoritative saved document are readable;
         * ownership alone does not widen this canvas-scoped lookup. Keep the canvas
         * and media locks until the resolve/download operation has finished.
         */
        async resolveReferenced(ids: string[], document: unknown): Promise<MediaRecord[]> {
            if (!ids.length) return [];
            const references = referencedCloudMediaIds(document);
            const lockIds = [...new Set(ids)].filter((id) => references.has(id.toLowerCase())).sort();
            if (!lockIds.length) return [];
            const rows = await db.select().from(mediaObject)
                .where(inArray(mediaObject.id, lockIds))
                .orderBy(asc(mediaObject.id))
                .for("key share");
            const byId = new Map(rows.map((row) => [row.id, toRecord(row)]));
            return ids.flatMap((id) => { const item = byId.get(id); return item ? [item] : []; });
        },
        async getForDelete(ownerId: string, id: string) {
            const [row] = await db.select().from(mediaObject)
                .where(and(eq(mediaObject.ownerId, ownerId), eq(mediaObject.id, id)))
                .for("update");
            return row ? toRecord(row) : null;
        },
        async list(ownerId: string) {
            const rows = await db.select().from(mediaObject).where(eq(mediaObject.ownerId, ownerId)).orderBy(asc(mediaObject.createdAt), asc(mediaObject.id));
            return rows.map(toRecord);
        },
        async remove(ownerId: string, id: string) {
            const [row] = await db.delete(mediaObject).where(and(eq(mediaObject.ownerId, ownerId), eq(mediaObject.id, id))).returning();
            return row ? toRecord(row) : null;
        },
        /**
         * Remove a media row and return its quota in one database transaction.
         * Keeping these writes atomic prevents a successful object deletion from
         * leaving the account quota permanently charged when the second query
         * fails.
         */
        async removeAndRelease(ownerId: string, id: string) {
            return db.transaction(async (tx) => {
                return removeAndReleaseInTransaction(tx, ownerId, id);
            });
        },
        /** Same operation for callers that already hold a wider transaction. */
        async removeAndReleaseInTransaction(transaction: Database, ownerId: string, id: string) {
            return removeAndReleaseInTransaction(transaction, ownerId, id);
        },
    };
}

async function removeAndReleaseInTransaction(db: Database, ownerId: string, id: string) {
    const [row] = await db.delete(mediaObject)
        .where(and(eq(mediaObject.ownerId, ownerId), eq(mediaObject.id, id)))
        .returning();
    if (!row) return null;
    await db.update(storageQuota).set({
        usedBytes: sql`GREATEST(${storageQuota.usedBytes} - ${row.sizeBytes}, 0)`,
        updatedAt: new Date(),
    }).where(eq(storageQuota.userId, ownerId));
    return toRecord(row);
}
