import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { CanvasDraft, JsonObject, SaveDraftResult } from "@infinite-canvas/shared";
import type { Database } from "./client";
import { canvasDraft } from "./schema";

function toDraft(row: typeof canvasDraft.$inferSelect): CanvasDraft {
    return {
        id: row.id,
        title: row.title,
        revision: row.revision,
        documentVersion: row.documentVersion,
        document: row.document,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function containsCloudMediaId(value: unknown, target: string): boolean {
    if (Array.isArray(value)) return value.some((item) => containsCloudMediaId(item, target));
    if (!value || typeof value !== "object") return false;
    return Object.entries(value).some(([key, child]) =>
        (key === "cloudMediaId" && typeof child === "string" && child.toLowerCase() === target) || containsCloudMediaId(child, target));
}

/** ownerId must come from a verified server session, never an HTTP body. */
export function createDraftRepository(db: Database) {
    return {
        async create(ownerId: string, input: { title: string; document: JsonObject }): Promise<CanvasDraft> {
            const [row] = await db.insert(canvasDraft).values({
                id: crypto.randomUUID(), ownerId, title: input.title, document: input.document,
            }).returning();
            return toDraft(row);
        },
        async createOnce(ownerId: string, input: { creationId: string; title: string; document: JsonObject }) {
            // The caller's transaction must include the success audit. Never overwrite on replay.
            const [row] = await db.insert(canvasDraft).values({
                id: input.creationId, ownerId, title: input.title, document: input.document,
            }).onConflictDoNothing({ target: canvasDraft.id }).returning();
            if (row) return { status: "saved" as const, draft: toDraft(row) };
            // Only test this owner's ID; a collision never exposes another account's data.
            const [existing] = await db.select({ id: canvasDraft.id }).from(canvasDraft)
                .where(and(eq(canvasDraft.id, input.creationId), eq(canvasDraft.ownerId, ownerId)));
            return existing ? { status: "exists" as const } : { status: "not_found" as const };
        },
        async get(ownerId: string, id: string): Promise<CanvasDraft | null> {
            const [row] = await db.select().from(canvasDraft)
                .where(and(eq(canvasDraft.id, id), eq(canvasDraft.ownerId, ownerId)));
            return row ? toDraft(row) : null;
        },
        /**
         * Internal deletion guard: first authorize and lock the media row by owner.
         * Keep the owner argument for existing callers, but scan every canvas since
         * an editor's media may be referenced by another account's shared canvas.
         * Do not lock canvases here: saves lock canvas then media, while deletion
         * already holds the media update lock. A plain read avoids reversing that
         * order and observes a committed save after waiting for its media lock.
         */
        async findMediaReferences(_ownerId: string, mediaId: string) {
            const rows = await db.select({ id: canvasDraft.id, title: canvasDraft.title, revision: canvasDraft.revision, document: canvasDraft.document })
                .from(canvasDraft).where(
                    // Let PostgreSQL/GiN discard documents without a cloud media key;
                    // the JS walk below keeps the existing case-insensitive UUID behavior.
                    sql`${canvasDraft.document} @? '$.**.cloudMediaId'::jsonpath`,
                );
            return rows.filter((row) => containsCloudMediaId(row.document, mediaId.toLowerCase()))
                .map(({ document: _document, ...summary }) => summary);
        },
        async list(ownerId: string) {
            // Summaries only: do not load all documents into the project list.
            const rows = await db.select({
                id: canvasDraft.id, title: canvasDraft.title,
                revision: canvasDraft.revision, updatedAt: canvasDraft.updatedAt,
            }).from(canvasDraft).where(eq(canvasDraft.ownerId, ownerId))
                .orderBy(desc(canvasDraft.updatedAt), canvasDraft.id);
            return rows.map((row) => ({ ...row, updatedAt: row.updatedAt.toISOString() }));
        },
        async listPage(ownerId: string, page: { limit: number; before?: { createdAt: string; id: string } }) {
            // Creation time is immutable, so editing a title does not move records across pages.
            const rows = await db.select({
                id: canvasDraft.id, title: canvasDraft.title, revision: canvasDraft.revision,
                createdAt: canvasDraft.createdAt, updatedAt: canvasDraft.updatedAt,
                cursorTime: sql<string>`to_char(${canvasDraft.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
            }).from(canvasDraft).where(and(
                eq(canvasDraft.ownerId, ownerId),
                page.before ? or(
                    sql`${canvasDraft.createdAt} < ${page.before.createdAt}::timestamptz`,
                    and(sql`${canvasDraft.createdAt} = ${page.before.createdAt}::timestamptz`, lt(canvasDraft.id, page.before.id)),
                ) : undefined,
            )).orderBy(desc(canvasDraft.createdAt), desc(canvasDraft.id)).limit(page.limit + 1);
            const items = rows.slice(0, page.limit);
            const last = items.at(-1);
            return {
                items: items.map(({ cursorTime, ...row }) => ({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })),
                // Keep PostgreSQL microseconds: JS Date would truncate and could skip rows in a page.
                next: rows.length > page.limit && last ? { createdAt: last.cursorTime, id: last.id } : null,
            };
        },
        async save(ownerId: string, id: string, input: {
            expectedRevision: number; title: string; document: JsonObject;
        }): Promise<SaveDraftResult> {
            if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
                throw new Error("画布版本必须是正整数");
            }
            // Version comparison and increment happen in one SQL statement.
            const [saved] = await db.update(canvasDraft).set({
                title: input.title,
                document: input.document,
                revision: sql`${canvasDraft.revision} + 1`,
                updatedAt: new Date(),
            }).where(and(
                eq(canvasDraft.id, id), eq(canvasDraft.ownerId, ownerId),
                eq(canvasDraft.revision, input.expectedRevision),
            )).returning();
            if (saved) return { status: "saved", draft: toDraft(saved) };
            const [current] = await db.select({ revision: canvasDraft.revision }).from(canvasDraft)
                .where(and(eq(canvasDraft.id, id), eq(canvasDraft.ownerId, ownerId)));
            // Missing and another user's records are deliberately indistinguishable.
            return current ? { status: "conflict", currentRevision: current.revision } : { status: "not_found" };
        },
    };
}
