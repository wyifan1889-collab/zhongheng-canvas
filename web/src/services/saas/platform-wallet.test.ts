import { expect, test } from "bun:test";
import { adjustAdminUserBalance, fetchAdminUsers, fetchPlatformWallet, PlatformServiceError, type AdminBalanceAdjustment, type AdminBalanceAdjustmentResult, type PlatformWallet } from "./platform";
import { addCreditAmounts } from "../../../../packages/shared/src/credit-amounts";

const timestamp = "2026-01-01T00:00:00.000Z";
const id = "11111111-1111-4111-8111-111111111111";
const wallet = (availableUnits = "0.000004", reservedUnits = "0.000002"): PlatformWallet => ({ unit: "credit", availableUnits, reservedUnits,
    totalUnits: addCreditAmounts(availableUnits, reservedUnits), version: 2, createdAt: timestamp, updatedAt: timestamp });
const user = () => ({ id: "synthetic-user", name: "模拟用户", email: "synthetic@example.invalid", role: "user" as const, disabled: false, emailVerified: true, wallet: wallet(), createdAt: timestamp });
const adjustment = (amount: string): AdminBalanceAdjustmentResult => ({ wallet: wallet("9007199254740993.000004", "0"), ledger: { id, kind: "adjustment",
    deltaAvailableUnits: amount, deltaReservedUnits: "0", availableUnitsAfter: "0.000004", reservedUnitsAfter: "0",
    referenceType: "admin_adjustment", referenceId: "synthetic-attempt", createdAt: timestamp } });

async function withReply(reply: unknown, run: (calls: Array<{ path: string; init?: RequestInit }>) => Promise<void>) {
    const previous = globalThis.fetch, calls: Array<{ path: string; init?: RequestInit }> = [];
    globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ path: String(input), init }); return Response.json(reply);
    }, { preconnect: previous.preconnect });
    try { await run(calls); } finally { globalThis.fetch = previous; }
}

test("wallet GET preserves tiny and large decimal strings and copies only the public wallet fields", async () => {
    for (const original of [wallet(), wallet("9007199254740993.000004", "0.000002")]) {
        await withReply({ wallet: { ...original, privateExtra: "not-for-ui" } }, async (calls) => {
            expect(await fetchPlatformWallet()).toEqual(original);
            expect(calls).toHaveLength(1); expect(calls[0].path).toBe("/api/v1/wallet");
            expect(calls[0].init).toMatchObject({ cache: "no-store", credentials: "same-origin" });
        });
    }
});

test("wallet GET rejects numeric, noncanonical, negative or inconsistent money instead of rounding", async () => {
    for (const amount of [0, 1, 0.000004, "1.0", "01", "-0", "1e-6", " 1", "1\n", "NaN", "Infinity", "-0.000001", null]) {
        await withReply({ wallet: { ...wallet(), availableUnits: amount } }, async (calls) => {
            await expect(fetchPlatformWallet()).rejects.toBeInstanceOf(PlatformServiceError); expect(calls).toHaveLength(1);
        });
    }
    await withReply({ wallet: { ...wallet(), totalUnits: "0.000007" } }, async () => {
        await expect(fetchPlatformWallet()).rejects.toBeInstanceOf(PlatformServiceError);
    });
});

test("admin users preserve exact balances and reject a malformed row rather than silently hiding it", async () => {
    const original = user();
    await withReply({ items: [{ ...original, privateExtra: "not-for-ui" }] }, async () => {
        const users = await fetchAdminUsers();
        expect(users).toEqual([{ ...original, wallet: { unit: "credit", availableUnits: "0.000004", reservedUnits: "0.000002", totalUnits: "0.000006" } }]);
        expect(JSON.stringify(users)).not.toContain("not-for-ui");
    });
    await withReply({ items: [original, { ...original, id: "bad-user", wallet: { ...original.wallet, reservedUnits: 0 } }] }, async () => {
        await expect(fetchAdminUsers()).rejects.toBeInstanceOf(PlatformServiceError);
    });
});

test("adjustment POST normalizes user strings without losing tiny signed credits or replay history", async () => {
    for (const [input, normalized] of [["0.00000400", "0.000004"], ["-0.00000400", "-0.000004"]]) {
        const result = adjustment(normalized);
        await withReply({ ...result, privateExtra: "not-for-ui", ledger: { ...result.ledger, privateExtra: "not-for-ui" } }, async (calls) => {
            expect(await adjustAdminUserBalance("synthetic-user", { amount: input, reason: "模拟精确调整" }, "same-attempt")).toEqual(result);
            expect(calls).toHaveLength(1); expect(calls[0].init?.method).toBe("POST");
            expect(JSON.parse(String(calls[0].init?.body))).toEqual({ amount: normalized, reason: "模拟精确调整" });
            expect(new Headers(calls[0].init?.headers).get("idempotency-key")).toBe("same-attempt");
            // An idempotent replay returns its historical ledger alongside the current wallet.
            expect(result.wallet.availableUnits).not.toBe(result.ledger.availableUnitsAfter);
        });
    }
});

test("invalid adjustment inputs never POST and malformed acknowledgements never trigger another request", async () => {
    for (const amount of [1, 0.000004, "0", "-0.00", "1e-6", "0.1\n", "", null]) {
        await withReply(adjustment("0.000004"), async (calls) => {
            await expect(adjustAdminUserBalance("synthetic-user", { amount, reason: "synthetic" } as unknown as AdminBalanceAdjustment, "attempt")).rejects.toBeInstanceOf(PlatformServiceError);
            expect(calls).toHaveLength(0);
        });
    }
    for (const patch of [{ deltaAvailableUnits: 0.000004 }, { deltaAvailableUnits: "0.0000040" }, { deltaAvailableUnits: "0.000005" }, { deltaReservedUnits: "0.000001" }, { availableUnitsAfter: -1 }]) {
        const result = adjustment("0.000004");
        await withReply({ ...result, ledger: { ...result.ledger, ...patch } }, async (calls) => {
            await expect(adjustAdminUserBalance("synthetic-user", { amount: "0.000004", reason: "synthetic" }, "attempt")).rejects.toBeInstanceOf(PlatformServiceError);
            expect(calls).toHaveLength(1);
        });
    }
});
