import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createAuth } from "@infinite-canvas/auth";
import { verification, user } from "@infinite-canvas/database/schema";
import { createTestDatabase } from "./database";

const origin = "http://localhost:4000";
const email = "otp-user@example.test";
const password = "otp-password-not-real";
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let auth: ReturnType<typeof createAuth>;
const codes: string[] = [];

function request(path: string, body: unknown) {
    return auth.handler(new Request(`${origin}/api/auth${path}`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
    }));
}

beforeAll(async () => {
    database = await createTestDatabase();
    auth = createAuth({
        database: database.db,
        baseURL: origin,
        secret: "test-only-" + crypto.randomUUID() + crypto.randomUUID(),
        sendVerificationEmail: async () => {},
        sendVerificationCode: async ({ code }) => { codes.push(code); },
        sendResetPassword: async () => {},
    });
}, 30_000);

afterAll(async () => { if (database) await database.close(); });

describe("email verification OTP", () => {
    test("sign-up sends a six-digit code, verifies once, and never stores it in plaintext", async () => {
        expect((await request("/sign-up/email", { name: "OTP User", email, password })).status).toBe(200);
        expect(codes).toHaveLength(1);
        const code = codes[0];
        expect(code).toMatch(/^\d{6}$/);
        const stored = await database.db.select().from(verification);
        expect(stored.every((record) => !record.value.includes(code))).toBe(true);

        const before = await database.db.select().from(user).where(eq(user.email, email));
        expect(before[0].emailVerified).toBe(false);
        expect((await request("/email-otp/verify-email", { email, otp: code })).status).toBe(200);
        const after = await database.db.select().from(user).where(eq(user.email, email));
        expect(after[0].emailVerified).toBe(true);
        expect((await request("/email-otp/verify-email", { email, otp: code })).status).toBe(400);
        expect((await request("/sign-in/email", { email, password })).status).toBe(200);
    });
});
