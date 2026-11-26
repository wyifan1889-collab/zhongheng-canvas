import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createWalletRepository, WalletOperationError } from "@infinite-canvas/database/wallet";
import { user, wallet, walletLedger } from "@infinite-canvas/database/schema";
import { createTestDatabase } from "./database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const userId = crypto.randomUUID();
const reservationUserId = crypto.randomUUID();

beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values([
        { id: userId, name: "Wallet test", email: `${userId}@example.test` },
        { id: reservationUserId, name: "Reservation test", email: `${reservationUserId}@example.test` },
    ]);
});
afterAll(async () => { await database?.close(); });

describe("wallet projection and append-only ledger", () => {
    test("lazily creates a zero balance and omits ownership from the view", async () => {
        const repository = createWalletRepository(database.db);
        const result = await repository.get(userId);
        expect(result).toMatchObject({ unit: "credit", availableUnits: "0", reservedUnits: "0", totalUnits: "0", version: 1 });
        expect(result).not.toHaveProperty("userId");
        expect(await repository.listLedger(userId)).toEqual([]);
    });

    test("database trigger rejects ledger mutation while idempotency remains unique", async () => {
        await database.db.insert(walletLedger).values({
            id: crypto.randomUUID(), userId, kind: "grant", deltaAvailableUnits: "10", deltaReservedUnits: "0",
            availableUnitsAfter: "10", reservedUnitsAfter: "0", idempotencyKey: "wallet-test-grant",
        });
        const [row] = await database.db.select().from(walletLedger).where(eq(walletLedger.userId, userId));
        const update = async () => { await database.db.update(walletLedger).set({ referenceId: "must-not-change" }).where(eq(walletLedger.id, row.id)); };
        const remove = async () => { await database.db.delete(walletLedger).where(eq(walletLedger.id, row.id)); };
        const duplicate = async () => { await database.db.insert(walletLedger).values({
            id: crypto.randomUUID(), userId, kind: "grant", deltaAvailableUnits: "1", deltaReservedUnits: "0",
            availableUnitsAfter: "11", reservedUnitsAfter: "0", idempotencyKey: "wallet-test-grant",
        }); };
        await expect(update()).rejects.toThrow();
        await expect(remove()).rejects.toThrow();
        await expect(duplicate()).rejects.toThrow();
    });

    test("reserve, capture and release keep wallet and ledger states atomic", async () => {
        await database.db.insert(wallet).values({ userId: reservationUserId, availableUnits: "10" });
        const repository = createWalletRepository(database.db);
        const reserved = await repository.reserve({ userId: reservationUserId, requestedUnits: 6, idempotencyKey: "generation-1", providerRequestId: "request-1" });
        expect(reserved).toMatchObject({ requestedUnits: "6", capturedUnits: "0", releasedUnits: "0", status: "pending", providerRequestId: "request-1" });
        expect(await repository.reserve({ userId: reservationUserId, requestedUnits: 6, idempotencyKey: "generation-1" })).toMatchObject({ id: reserved.id, status: "pending" });
        await expect(repository.reserve({ userId: reservationUserId, requestedUnits: 5, idempotencyKey: "generation-1" })).rejects.toMatchObject<WalletOperationError>({ code: "idempotency_conflict" });
        await repository.capture({ userId: reservationUserId, reservationId: reserved.id, capturedUnits: 2, idempotencyKey: "generation-1-capture" });
        const released = await repository.release({ userId: reservationUserId, reservationId: reserved.id, releasedUnits: 4, idempotencyKey: "generation-1-release" });
        expect(released).toMatchObject({ capturedUnits: "2", releasedUnits: "4", status: "captured" });
        await expect(repository.release({ userId: reservationUserId, reservationId: reserved.id, releasedUnits: 3, idempotencyKey: "generation-1-release" })).rejects.toMatchObject<WalletOperationError>({ code: "idempotency_conflict" });
        expect(await repository.get(reservationUserId)).toMatchObject({ availableUnits: "8", reservedUnits: "0", totalUnits: "8", version: 4 });
        expect((await repository.listLedger(reservationUserId)).map((item) => item.kind)).toEqual(["release", "capture", "reserve"]);
    });

    test("reservation refuses to overspend and keeps the balance unchanged", async () => {
        const userForFailure = crypto.randomUUID();
        await database.db.insert(user).values({ id: userForFailure, name: "Insufficient test", email: `${userForFailure}@example.test` });
        const repository = createWalletRepository(database.db);
        await expect(repository.reserve({ userId: userForFailure, requestedUnits: 1, idempotencyKey: "generation-insufficient" })).rejects.toMatchObject<WalletOperationError>({ code: "insufficient_balance" });
        expect(await repository.get(userForFailure)).toMatchObject({ availableUnits: "0", reservedUnits: "0", version: 1 });
    });
});
