import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { CanvasDraft } from "@infinite-canvas/shared";
import type { Database } from "./client";
import { canvasDraft, canvasMembers, canvasShares, user, type CanvasRole, type CanvasShareRole } from "./schema";

export type CanvasAccess = { role: CanvasRole; ownerId: string; readOnly: boolean };
export type CanvasShareView = { id: string; canvasId: string; token: string; role: CanvasShareRole; createdBy: string; expiresAt: string | null; createdAt: string };
export type CanvasMemberView = { canvasId: string; userId: string; role: CanvasRole; invitedBy: string | null; joinedAt: string | null };

function memberView(row: typeof canvasMembers.$inferSelect): CanvasMemberView {
    return { canvasId: row.canvasId, userId: row.userId, role: row.role, invitedBy: row.invitedBy, joinedAt: row.joinedAt?.toISOString() ?? null };
}
function shareView(row: typeof canvasShares.$inferSelect): CanvasShareView {
    return { id: row.id, canvasId: row.canvasId, token: row.token, role: row.role, createdBy: row.createdBy,
        expiresAt: row.expiresAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() };
}
function draftView(row: typeof canvasDraft.$inferSelect): CanvasDraft {
    return { id: row.id, title: row.title, revision: row.revision, documentVersion: row.documentVersion, document: row.document,
        createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
function identity(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function shareRole(value: unknown): value is CanvasShareRole { return value === "viewer" || value === "editor"; }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every method requires a surrounding transaction. The canvas lock comes first,
 * before member/share/media locks, and must remain held through the caller's work.
 * Tokens belong only in the owner response, never audit records or error text.
 */
export function createCanvasSharingRepository(db: Database) {
    async function lockCanvas(canvasId: string, mode: "read" | "write") {
        const [row] = await db.select({ id: canvasDraft.id, ownerId: canvasDraft.ownerId }).from(canvasDraft)
            .where(eq(canvasDraft.id, canvasId)).for(mode === "read" ? "share" : "update");
        if (!row) return null;
        const [mirror] = await db.select({ userId: canvasMembers.userId }).from(canvasMembers).where(and(
            eq(canvasMembers.canvasId, row.id), eq(canvasMembers.userId, row.ownerId), eq(canvasMembers.role, "owner"), isNotNull(canvasMembers.joinedAt),
        ));
        return mirror ? row : null;
    }
    async function lockOwner(actorId: string, canvasId: string, mode: "read" | "write") {
        if (!identity(actorId) || !identity(canvasId)) return null;
        const canvas = await lockCanvas(canvasId, mode);
        return canvas?.ownerId === actorId ? canvas : null;
    }
    return {
        async lockAccess(actorId: string, canvasId: string, mode: "read" | "write"): Promise<{ draft: CanvasDraft; access: CanvasAccess } | null> {
            if (!identity(actorId) || !identity(canvasId) || (mode !== "read" && mode !== "write")) return null;
            const canvas = await lockCanvas(canvasId, mode);
            if (!canvas) return null;
            let role: CanvasRole;
            if (canvas.ownerId === actorId) role = "owner";
            else {
                const [member] = await db.select({ role: canvasMembers.role }).from(canvasMembers).where(and(
                    eq(canvasMembers.canvasId, canvasId), eq(canvasMembers.userId, actorId), isNotNull(canvasMembers.joinedAt),
                ));
                if (!member || member.role === "owner") return null;
                role = member.role;
            }
            if (mode === "write" && role === "viewer") return null;
            const [draft] = await db.select().from(canvasDraft).where(eq(canvasDraft.id, canvasId));
            return draft ? { draft: draftView(draft), access: { role, ownerId: canvas.ownerId, readOnly: role === "viewer" } } : null;
        },

        async getShare(actorId: string, canvasId: string) {
            if (!await lockOwner(actorId, canvasId, "read")) return { status: "not_found" as const };
            const [share] = await db.select().from(canvasShares).where(eq(canvasShares.canvasId, canvasId));
            const members = await db.select().from(canvasMembers).where(eq(canvasMembers.canvasId, canvasId)).orderBy(asc(canvasMembers.userId));
            return { status: "found" as const, share: share ? shareView(share) : null, members: members.map(memberView) };
        },

        async shareLink(actorId: string, canvasId: string, input: { role: CanvasShareRole; reset?: boolean }) {
            if (!shareRole(input.role) || (input.reset !== undefined && typeof input.reset !== "boolean")) return { status: "invalid_input" as const };
            if (!await lockOwner(actorId, canvasId, "write")) return { status: "not_found" as const };
            const [existing] = await db.select().from(canvasShares).where(eq(canvasShares.canvasId, canvasId));
            if (existing && !input.reset) return existing.role === input.role
                ? { status: "saved" as const, share: shareView(existing), created: false }
                : { status: "reset_required" as const };
            const [share] = existing
                ? await db.update(canvasShares).set({ token: crypto.randomUUID(), role: input.role }).where(eq(canvasShares.id, existing.id)).returning()
                : await db.insert(canvasShares).values({ id: crypto.randomUUID(), canvasId, token: crypto.randomUUID(), role: input.role, createdBy: actorId }).returning();
            if (!share) throw new Error("画布分享记录未保存");
            return { status: "saved" as const, share: shareView(share), created: !existing };
        },

        async join(actorId: string, token: string) {
            if (!identity(actorId) || typeof token !== "string" || !uuid.test(token)) return { status: "invalid_input" as const };
            const [candidate] = await db.select({ canvasId: canvasShares.canvasId }).from(canvasShares).where(eq(canvasShares.token, token.toLowerCase()));
            if (!candidate || !await lockCanvas(candidate.canvasId, "write")) return { status: "not_found" as const };
            // Reset and join serialize on the same canvas lock. Check time after acquiring it.
            const [share] = await db.select().from(canvasShares).where(and(eq(canvasShares.canvasId, candidate.canvasId), eq(canvasShares.token, token.toLowerCase()),
                or(isNull(canvasShares.expiresAt), gt(canvasShares.expiresAt, sql`clock_timestamp()`))));
            if (!share) return { status: "not_found" as const };
            const [existing] = await db.select().from(canvasMembers).where(and(eq(canvasMembers.canvasId, candidate.canvasId), eq(canvasMembers.userId, actorId)));
            if (existing?.joinedAt) return { status: "joined" as const, canvasId: candidate.canvasId, member: memberView(existing), alreadyJoined: true };
            const role = existing?.role === "viewer" || share.role === "viewer" ? "viewer" : "editor";
            const [member] = existing
                ? await db.update(canvasMembers).set({ role, joinedAt: sql`clock_timestamp()` }).where(and(eq(canvasMembers.canvasId, candidate.canvasId), eq(canvasMembers.userId, actorId))).returning()
                : await db.insert(canvasMembers).values({ canvasId: candidate.canvasId, userId: actorId, role, invitedBy: share.createdBy, joinedAt: sql`clock_timestamp()` }).returning();
            if (!member) throw new Error("画布成员加入未保存");
            return { status: "joined" as const, canvasId: candidate.canvasId, member: memberView(member), alreadyJoined: false };
        },

        async upsertMember(actorId: string, canvasId: string, input: { userId: string; role: CanvasShareRole }) {
            if (!identity(input.userId) || !shareRole(input.role)) return { status: "invalid_input" as const };
            const canvas = await lockOwner(actorId, canvasId, "write");
            if (!canvas) return { status: "not_found" as const };
            if (input.userId === canvas.ownerId) return { status: "owner_protected" as const };
            const [target] = await db.select({ id: user.id }).from(user).where(eq(user.id, input.userId));
            if (!target) return { status: "user_not_found" as const };
            const [member] = await db.insert(canvasMembers).values({ canvasId, userId: input.userId, role: input.role, invitedBy: actorId, joinedAt: null })
                .onConflictDoUpdate({ target: [canvasMembers.canvasId, canvasMembers.userId], set: { role: input.role, invitedBy: actorId } }).returning();
            if (!member) throw new Error("画布成员邀请未保存");
            return { status: "saved" as const, member: memberView(member) };
        },

        async removeMember(actorId: string, canvasId: string, userId: string) {
            if (!identity(userId)) return { status: "invalid_input" as const };
            const canvas = await lockOwner(actorId, canvasId, "write");
            if (!canvas) return { status: "not_found" as const };
            if (userId === canvas.ownerId) return { status: "owner_protected" as const };
            const removed = await db.delete(canvasMembers).where(and(eq(canvasMembers.canvasId, canvasId), eq(canvasMembers.userId, userId))).returning({ userId: canvasMembers.userId });
            return { status: "removed" as const, removed: removed.length > 0 };
        },
    };
}
