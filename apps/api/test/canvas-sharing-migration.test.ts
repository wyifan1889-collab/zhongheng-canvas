import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { and, eq, sql } from "drizzle-orm";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "@infinite-canvas/database/schema";
import { expectCurrentMigrations } from "./migrations";

if (process.env.DATABASE_URL || process.env.SAAS_DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("Sharing migration test requires in-memory PGlite only");

test("real old migrations upgrade legacy TEXT canvases, backfill owners and enforce final sharing invariants", async () => {
    const migrationsFolder = fileURLToPath(new URL("../../../packages/database/migrations/", import.meta.url));
    const journal = JSON.parse(await fs.readFile(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"));
    const sharingIndex = journal.entries.findIndex((entry: { tag: string }) => entry.tag === "0028_canvas_sharing");
    expect(sharingIndex).toBeGreaterThan(0);
    const temporaryBase = await fs.realpath(os.tmpdir());
    const previous = await fs.mkdtemp(path.join(temporaryBase, "canvas-sharing-migration-"));
    const client = new PGlite();
    try {
        const oldEntries = journal.entries.slice(0, sharingIndex);
        await fs.mkdir(path.join(previous, "meta"));
        await fs.writeFile(path.join(previous, "meta", "_journal.json"), JSON.stringify({ ...journal, entries: oldEntries }));
        await Promise.all(oldEntries.map((entry: { tag: string }) => fs.copyFile(path.join(migrationsFolder, `${entry.tag}.sql`), path.join(previous, `${entry.tag}.sql`))));
        const db = drizzle(client, { schema });
        await migrate(db, { migrationsFolder: previous, migrationsSchema: "canvas_migrations" });
        const owner = "Owner-Text-ID", other = "Other-Text-ID", inviter = "Inviter-Text-ID", legacyId = "Legacy-Text-Canvas";
        // Seed only columns that existed before sharing; the current ORM also includes later migrations.
        for (const id of [owner, other, inviter]) await client.query(
            'INSERT INTO canvas_saas."user" (id, name, email) VALUES ($1, $2, $3)', [id, id, `${id.toLowerCase()}@example.test`]);
        const createdAt = new Date("2026-01-02T03:04:05.678Z");
        await db.insert(schema.canvasDraft).values({ id: legacyId, ownerId: owner, title: "Legacy synthetic canvas", document: {}, createdAt });
        expect((await client.query("SELECT to_regclass('canvas_saas.canvas_members') AS relation")).rows[0]).toEqual({ relation: null });
        await migrate(db, { migrationsFolder, migrationsSchema: "canvas_migrations" });
        await expectCurrentMigrations(client);
        const ownerWhere = and(eq(schema.canvasMembers.canvasId, legacyId), eq(schema.canvasMembers.userId, owner));
        expect(await db.select().from(schema.canvasMembers).where(ownerWhere)).toEqual([
            { canvasId: legacyId, userId: owner, role: "owner", invitedBy: null, joinedAt: createdAt },
        ]);
        const newId = crypto.randomUUID();
        const [created] = await db.insert(schema.canvasDraft).values({ id: newId, ownerId: owner, title: "New synthetic canvas", document: {} }).returning();
        expect(await db.select().from(schema.canvasMembers).where(eq(schema.canvasMembers.canvasId, newId))).toEqual([
            { canvasId: newId, userId: owner, role: "owner", invitedBy: null, joinedAt: created.createdAt },
        ]);
        for (const mutation of [
            () => db.delete(schema.canvasMembers).where(ownerWhere),
            () => db.update(schema.canvasMembers).set({ role: "viewer" }).where(ownerWhere),
            () => db.update(schema.canvasMembers).set({ joinedAt: sql`now() + interval '1 day'` }).where(ownerWhere),
            () => db.update(schema.canvasMembers).set({ userId: other }).where(ownerWhere),
            () => db.insert(schema.canvasMembers).values({ canvasId: legacyId, userId: other, role: "owner", joinedAt: createdAt }),
            () => db.update(schema.canvasDraft).set({ ownerId: other }).where(eq(schema.canvasDraft.id, legacyId)),
        ]) await expect(mutation().execute()).rejects.toThrow();
        await db.insert(schema.canvasMembers).values({ canvasId: legacyId, userId: other, role: "viewer", invitedBy: inviter, joinedAt: null });
        await expect(db.insert(schema.canvasMembers).values({ canvasId: legacyId, userId: other, role: "editor" }).execute()).rejects.toThrow();
        await db.delete(schema.user).where(eq(schema.user.id, inviter));
        expect((await db.select().from(schema.canvasMembers).where(eq(schema.canvasMembers.userId, other)))[0]).toMatchObject({ joinedAt: null, invitedBy: null });
        const share = { id: crypto.randomUUID(), canvasId: legacyId, token: crypto.randomUUID(), role: "viewer" as const, createdBy: owner };
        await db.insert(schema.canvasShares).values(share);
        await expect(db.insert(schema.canvasShares).values({ ...share, id: crypto.randomUUID(), token: crypto.randomUUID() }).execute()).rejects.toThrow();
        await expect(db.insert(schema.canvasShares).values({ ...share, id: crypto.randomUUID(), canvasId: newId }).execute()).rejects.toThrow();
        await db.delete(schema.canvasDraft).where(eq(schema.canvasDraft.id, legacyId));
        expect(await db.select().from(schema.canvasMembers).where(eq(schema.canvasMembers.canvasId, legacyId))).toEqual([]);
        expect(await db.select().from(schema.canvasShares).where(eq(schema.canvasShares.canvasId, legacyId))).toEqual([]);
    } finally {
        try { await client.close(); }
        finally {
            if (path.dirname(previous) !== temporaryBase || !path.basename(previous).startsWith("canvas-sharing-migration-")) throw new Error("Unexpected synthetic migration cleanup target");
            await fs.rm(previous, { recursive: true, force: true });
        }
    }
}, 30_000);
