import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { generationTask, user, wallet, walletLedger, walletReservation } from "@infinite-canvas/database/schema";
import { createTestDatabase } from "./database";

if (process.env.DATABASE_URL || process.env.SAAS_TEST_DATABASE_URL) throw new Error("This suite requires isolated in-memory PGlite");
let database: Awaited<ReturnType<typeof createTestDatabase>>;
beforeAll(async () => { database = await createTestDatabase(); });
afterAll(async () => { await database?.close(); });

async function owner(balance = "10") {
    const id = crypto.randomUUID();
    await database.db.insert(user).values({ id, name: "Synthetic wallet owner", email: `${id}@example.test` });
    await database.db.insert(wallet).values({ userId: id, availableUnits: balance });
    return id;
}
const businessState = () => Promise.all([database.db.select().from(wallet), database.db.select().from(walletLedger), database.db.select().from(walletReservation)]);

for (const operation of ["capture", "release"] as const) test(`${operation} with an explicit task reference replays once without changing funds`, async () => {
    const userId = await owner(), repository = createWalletRepository(database.db), taskId = crypto.randomUUID();
    const reserved = await repository.reserve({ userId, requestedUnits: 4, taskId, idempotencyKey: "reserve-task", referenceType: "generation", referenceId: taskId });
    const common = { userId, reservationId: reserved.id, idempotencyKey: "settle-task", referenceType: "generation", referenceId: taskId };
    const settle = () => operation === "capture" ? repository.capture({ ...common, capturedUnits: 1 }) : repository.release({ ...common, releasedUnits: 1 });
    const first = await settle(), beforeReplay = await businessState();
    expect(await settle()).toEqual(first);
    expect(await businessState()).toEqual(beforeReplay);
    expect(await database.db.select().from(walletLedger).where(eq(walletLedger.userId, userId))).toHaveLength(2);
});

test("0.004 credits capture exactly, unused decimals release, and output is canonical", async () => {
    const userId = await owner("0.01000"), repository = createWalletRepository(database.db);
    const reservation = await repository.reserve({ userId, requestedUnits: "0.00600", idempotencyKey: "fraction" });
    expect(reservation).toMatchObject({ requestedUnits: "0.006", capturedUnits: "0", releasedUnits: "0" });
    expect(await repository.get(userId)).toMatchObject({ availableUnits: "0.004", reservedUnits: "0.006", totalUnits: "0.01" });
    expect(await repository.capture({ userId, reservationId: reservation.id, capturedUnits: "0.0040", idempotencyKey: "fraction-capture" })).toMatchObject({ capturedUnits: "0.004", status: "pending" });
    const released = await repository.release({ userId, reservationId: reservation.id, idempotencyKey: "fraction-release" });
    expect(released).toMatchObject({ capturedUnits: "0.004", releasedUnits: "0.002", status: "captured" });
    const before = await businessState();
    expect(await repository.release({ userId, reservationId: reservation.id, releasedUnits: "0.002000", idempotencyKey: "fraction-release" })).toEqual(released);
    expect(await repository.capture({ userId, reservationId: reservation.id, capturedUnits: "0.004", idempotencyKey: "fraction-capture" })).toEqual(released);
    expect(await businessState()).toEqual(before);
    expect(await repository.get(userId)).toMatchObject({ availableUnits: "0.006", reservedUnits: "0", totalUnits: "0.006", version: 4 });
    expect((await repository.listLedger(userId)).map(({ kind, deltaAvailableUnits, deltaReservedUnits }) => ({ kind, deltaAvailableUnits, deltaReservedUnits }))).toEqual([
        { kind: "release", deltaAvailableUnits: "0.002", deltaReservedUnits: "-0.002" },
        { kind: "capture", deltaAvailableUnits: "0", deltaReservedUnits: "-0.004" },
        { kind: "reserve", deltaAvailableUnits: "-0.006", deltaReservedUnits: "0.006" },
    ]);
});

test("same reference and amount cannot replay a different reservation or owner", async () => {
    const userId = await owner(), otherId = await owner(), repository = createWalletRepository(database.db);
    const first = await repository.reserve({ userId, requestedUnits: "1", idempotencyKey: "first" });
    const second = await repository.reserve({ userId, requestedUnits: 1, idempotencyKey: "second" });
    const common = { userId, idempotencyKey: "shared-key", referenceType: "custom", referenceId: "same-reference" };
    await repository.capture({ ...common, reservationId: first.id, capturedUnits: "0.1" });
    const before = await businessState();
    await expect(repository.capture({ ...common, reservationId: second.id, capturedUnits: "0.1" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(repository.capture({ ...common, userId: otherId, reservationId: first.id, capturedUnits: "0.1" })).rejects.toMatchObject({ code: "reservation_not_found" });
    await expect(repository.capture({ ...common, referenceType: "changed", reservationId: first.id, capturedUnits: "0.1" })).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(await businessState()).toEqual(before);
    expect((await repository.listLedger(userId)).every((entry) => !Object.hasOwn(entry, "metadata"))).toBe(true);
});

test("invalid amounts, excessive settlement and insufficient fractional funds leave no mutation", async () => {
    const userId = await owner("0.004"), repository = createWalletRepository(database.db);
    const invalid: Array<string | number> = [0, -1, 0.004, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "-0.01", "NaN", "Infinity", "1e-3", "00.4", "0", " 1", "1.", ".1"];
    const before = await businessState();
    for (const requestedUnits of invalid) await expect(repository.reserve({ userId, requestedUnits, idempotencyKey: "invalid" })).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(repository.reserve({ userId, requestedUnits: "0.0040000000000000000001", idempotencyKey: "too-much" })).rejects.toMatchObject({ code: "insufficient_balance" });
    expect(await businessState()).toEqual(before);
    const reservation = await repository.reserve({ userId, requestedUnits: "0.004", idempotencyKey: "valid" }), reserved = await businessState();
    for (const capturedUnits of invalid) await expect(repository.capture({ userId, reservationId: reservation.id, capturedUnits, idempotencyKey: "invalid" })).rejects.toMatchObject({ code: "invalid_amount" });
    await expect(repository.capture({ userId, reservationId: reservation.id, capturedUnits: "0.005", idempotencyKey: "too-much" })).rejects.toMatchObject({ code: "reservation_conflict" });
    await expect(repository.release({ userId, reservationId: reservation.id, releasedUnits: "0.005", idempotencyKey: "too-much" })).rejects.toMatchObject({ code: "reservation_conflict" });
    expect(await businessState()).toEqual(reserved);
});

test("DB finite constraints reject all nine NaN/infinity amount fields and preserve append-only entries", async () => {
    const userId = await owner();
    for (const invalid of ["NaN", "Infinity", "-Infinity"]) {
        for (const column of ["availableUnits", "reservedUnits"] as const) {
            await expect(database.db.update(wallet).set({ [column]: invalid }).where(eq(wallet.userId, userId)).execute()).rejects.toThrow();
        }
        for (const column of ["deltaAvailableUnits", "deltaReservedUnits", "availableUnitsAfter", "reservedUnitsAfter"] as const) {
            await expect(database.db.insert(walletLedger).values({ id: crypto.randomUUID(), userId, kind: "grant", deltaAvailableUnits: "1", deltaReservedUnits: "0", availableUnitsAfter: "10", reservedUnitsAfter: "0", idempotencyKey: crypto.randomUUID(), [column]: invalid }).execute()).rejects.toThrow();
        }
        for (const column of ["requestedUnits", "capturedUnits", "releasedUnits"] as const) {
            await expect(database.db.insert(walletReservation).values({ id: crypto.randomUUID(), userId, requestedUnits: "1", capturedUnits: "0", releasedUnits: "0", idempotencyKey: crypto.randomUUID(), [column]: invalid }).execute()).rejects.toThrow();
        }
    }
    expect(await database.db.select().from(walletLedger).where(eq(walletLedger.userId, userId))).toHaveLength(0);
    expect(await database.db.select().from(walletReservation).where(eq(walletReservation.userId, userId))).toHaveLength(0);
    expect(await createWalletRepository(database.db).get(userId)).toMatchObject({ availableUnits: "10", reservedUnits: "0" });
});

test("historical task-reference entries require the actual owner and reservation link; unknown custom refs fail closed", async () => {
    const userId = await owner(), repository = createWalletRepository(database.db);
    for (const mode of ["default", "linked", "unlinked", "custom"] as const) {
        const reservationId = crypto.randomUUID(), taskId = crypto.randomUUID(), referenceType = mode === "custom" ? "custom" : "generation";
        const referenceId = mode === "default" ? reservationId : taskId;
        await database.db.insert(walletReservation).values({ id: reservationId, userId, taskId, requestedUnits: "1", capturedUnits: "0.1", releasedUnits: "0.1", idempotencyKey: mode });
        if (mode === "linked") await database.db.insert(generationTask).values({ id: taskId, ownerId: userId, modelId: "legacy", inputSnapshot: {}, parameterSnapshot: {}, idempotencyKey: mode, requestId: mode, reservationId });
        for (const operation of ["capture", "release"] as const) await database.db.insert(walletLedger).values({ id: crypto.randomUUID(), userId, kind: operation,
            deltaAvailableUnits: operation === "capture" ? "0" : "0.1", deltaReservedUnits: "-0.1", availableUnitsAfter: "9", reservedUnitsAfter: "0.8",
            idempotencyKey: `${operation}:${mode}`, referenceType, referenceId });
        const before = await businessState(), common = { userId, reservationId, idempotencyKey: mode, referenceType, referenceId };
        for (const operation of ["capture", "release"] as const) {
            const result = operation === "capture" ? repository.capture({ ...common, capturedUnits: "0.1" }) : repository.release({ ...common, releasedUnits: "0.1" });
            if (mode === "default" || mode === "linked") expect(await result).toMatchObject({ id: reservationId });
            else await expect(result).rejects.toMatchObject({ code: "idempotency_conflict" });
        }
        expect(await businessState()).toEqual(before);
    }
});

test("append failure rolls fractional wallet and reservation changes back", async () => {
    const userId = await owner("1"), repository = createWalletRepository(database.db);
    await database.db.execute(sql`CREATE FUNCTION canvas_saas.reject_decimal_test_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic ledger failure'; END; $$`);
    await database.db.execute(sql`CREATE TRIGGER reject_decimal_test_ledger BEFORE INSERT ON canvas_saas.wallet_ledger FOR EACH ROW EXECUTE FUNCTION canvas_saas.reject_decimal_test_ledger()`);
    const before = await businessState();
    try {
        await expect(repository.reserve({ userId, requestedUnits: "0.004", idempotencyKey: "atomic" })).rejects.toThrow();
        expect(await businessState()).toEqual(before);
    } finally {
        await database.db.execute(sql`DROP TRIGGER reject_decimal_test_ledger ON canvas_saas.wallet_ledger`);
        await database.db.execute(sql`DROP FUNCTION canvas_saas.reject_decimal_test_ledger()`);
    }
});
