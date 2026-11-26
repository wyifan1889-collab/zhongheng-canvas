import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { user, walletLedger } from "@infinite-canvas/database/schema";
import { createWalletRepository } from "@infinite-canvas/database/wallet";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createTestDatabase } from "./database";

if (process.env.SAAS_TEST_DATABASE_URL || process.env.DATABASE_URL) throw new Error("Only isolated in-memory API fixtures are permitted");
const origin = "http://localhost:4033";
const password = "synthetic-decimal-wallet-password";
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;
let admin = { id: "", cookie: "" }, owner = { id: "", cookie: "" };

function request(path: string, session = admin, body?: unknown, key = crypto.randomUUID()) {
    return app(new Request(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { origin, cookie: session.cookie, "x-canvas-account-id": session.id, "content-type": "application/json", "idempotency-key": key },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), "198.51.100.33");
}

async function register(email: string) {
    const response = await app(new Request(`${origin}/api/auth/sign-up/email`, { method: "POST",
        headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ email, password, name: "Decimal fixture" }) }), "198.51.100.33");
    expect(response.status).toBe(200);
    const [row] = await database.db.select().from(user).where(eq(user.email, email));
    await database.db.update(user).set({ emailVerified: true }).where(eq(user.id, row!.id));
    const login = await app(new Request(`${origin}/api/auth/sign-in/email`, { method: "POST", headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email, password }) }), "198.51.100.33");
    expect(login.status).toBe(200);
    return { id: row!.id, cookie: login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ") };
}

beforeAll(async () => {
    database = await createTestDatabase();
    const secret = `synthetic-decimal-${crypto.randomUUID()}`;
    app = createApp(createAccountApi({ database: database.db, origin,
        auth: { secret, sendVerificationEmail: async () => undefined, sendResetPassword: async () => undefined },
        rates: createRateStore(database.pool, secret), verifyHuman: async () => true, onFault: () => undefined,
    }), "synthetic-site-key");
    admin = await register("decimal-admin@example.test");
    owner = await register("decimal-owner@example.test");
    await database.db.update(user).set({ role: "admin" }).where(eq(user.id, admin.id));
});
afterAll(async () => { await database?.close(); });

test("admin adjustment, fractional settlement and public/admin reads retain the same exact amount", async () => {
    const path = `/api/v1/admin/users/${owner.id}/balance`;
    const key = "decimal-grant";
    const granted = await request(path, admin, { amount: "1.000", reason: "Synthetic test" }, key);
    expect(granted.status).toBe(200);
    expect((await granted.json()).wallet).toMatchObject({ availableUnits: "1", reservedUnits: "0", totalUnits: "1" });
    const replay = await request(path, admin, { amount: "1", reason: "Synthetic test" }, key);
    expect(replay.status).toBe(200);
    expect((await request(path, admin, { amount: "1.001", reason: "Synthetic test" }, key)).status).toBe(409);
    const wallets = createWalletRepository(database.db);
    const held = await wallets.reserve({ userId: owner.id, requestedUnits: "0.01", idempotencyKey: "decimal-reserve" });
    await wallets.capture({ userId: owner.id, reservationId: held.id, capturedUnits: "0.004", idempotencyKey: "decimal-capture" });
    await wallets.release({ userId: owner.id, reservationId: held.id, idempotencyKey: "decimal-release" });
    const response = await request("/api/v1/wallet", owner);
    expect(response.status).toBe(200);
    expect((await response.json()).wallet).toMatchObject({ availableUnits: "0.996", reservedUnits: "0", totalUnits: "0.996" });
    const users = await (await request("/api/v1/admin/users")).json();
    expect(users.items.find((entry: { id: string }) => entry.id === owner.id).wallet).toEqual({ unit: "credit", availableUnits: "0.996", reservedUnits: "0", totalUnits: "0.996" });
    const ledger = await (await request("/api/v1/wallet/ledger", owner)).json();
    expect(ledger.items.find((entry: { kind: string }) => entry.kind === "capture")).toMatchObject({ deltaAvailableUnits: "0", deltaReservedUnits: "-0.004", reservedUnitsAfter: "0.006" });
    expect(ledger.items.find((entry: { kind: string }) => entry.kind === "release")).toMatchObject({ deltaAvailableUnits: "0.006", deltaReservedUnits: "-0.006", availableUnitsAfter: "0.996" });
    expect((await (await request("/api/v1/wallet/ledger", admin)).json()).items).toEqual([]);
});

test("invalid decimals, numeric JSON, overdraft and unauthorized adjustments do not mutate the ledger", async () => {
    const path = `/api/v1/admin/users/${owner.id}/balance`;
    const before = await database.db.select().from(walletLedger);
    for (const amount of [0.004, 1, "NaN", "Infinity", "1e-3", "0", "-0", "01", " 1"]) {
        expect((await request(path, admin, { amount, reason: "Synthetic invalid" })).status).toBe(400);
    }
    expect((await request(path, admin, { amount: "-1", reason: "Synthetic overdraft" })).status).toBe(409);
    expect((await request(path, owner, { amount: "1", reason: "Synthetic unauthorized" })).status).toBe(403);
    expect(await database.db.select().from(walletLedger)).toEqual(before);
});

test("tiny adjustments survive HTTP round trips and signed reversal exactly", async () => {
    const path = `/api/v1/admin/users/${admin.id}/balance`;
    const amount = "0.0000000000000000001";
    const granted = await request(path, admin, { amount, reason: "Synthetic tiny adjustment" });
    expect(granted.status).toBe(200);
    expect((await granted.json()).wallet.availableUnits).toBe(amount);
    const reversed = await request(path, admin, { amount: `-${amount}`, reason: "Synthetic reversal" });
    expect(reversed.status).toBe(200);
    expect((await reversed.json()).wallet.availableUnits).toBe("0");
});
