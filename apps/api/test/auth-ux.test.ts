import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { user } from "@infinite-canvas/database/schema";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createTestDatabase } from "./database";

const origin = "http://localhost:4100";
const email = "auth-ux@example.test";
const password = "auth-ux-password";
let database: Awaited<ReturnType<typeof createTestDatabase>>;
let app: ReturnType<typeof createApp>;
const codes: string[] = [];

function request(path: string, body: unknown, peer = "198.51.100.120") {
    return app(new Request(`${origin}${path}`, {
        method: "POST",
        headers: { origin, "content-type": "application/json", "x-captcha-response": "test-pass" },
        body: JSON.stringify(body),
    }), peer);
}

beforeAll(async () => {
    database = await createTestDatabase();
    app = createApp(createAccountApi({
        database: database.db,
        origin,
        auth: {
            secret: "test-only-" + crypto.randomUUID() + crypto.randomUUID(),
            sendVerificationEmail: async () => {},
            sendVerificationCode: async ({ code }) => { codes.push(code); },
            sendResetPassword: async () => {},
        },
        rates: { consume: async () => ({ allowed: true as const }) },
        verifyHuman: async () => true,
        onFault: () => {},
    }), "public-test-site-key");
}, 30_000);

afterAll(async () => { if (database) await database.close(); });

describe("account registration and login UX", () => {
    test("duplicate sign-up is rejected without sending another verification code", async () => {
        expect((await request("/api/auth/sign-up/email", { name: "UX User", email, password })).status).toBe(200);
        expect(codes).toHaveLength(1);
        const duplicate = await request("/api/auth/sign-up/email", { name: "Changed", email: email.toUpperCase(), password });
        expect(duplicate.status).toBe(409);
        expect(await duplicate.json()).toMatchObject({ error: { code: "email_pending_verification" } });
        expect(codes).toHaveLength(1);
    });

    test("unverified, wrong-password and unknown-email login errors are distinguishable", async () => {
        const pending = await request("/api/auth/sign-in/email", { email, password });
        expect(pending.status).toBe(403);
        expect(await pending.json()).toMatchObject({ error: { code: "email_not_verified" } });

        const unknown = await request("/api/auth/sign-in/email", { email: "missing-auth-ux@example.test", password });
        expect(unknown.status).toBe(401);
        expect(await unknown.json()).toMatchObject({ error: { code: "invalid_credentials" } });
    });

    test("verified account can log in and later sign-up is rejected as registered", async () => {
        const verify = await request("/api/auth/email-otp/verify-email", { email, otp: codes[0] });
        expect(verify.status).toBe(200);
        // Compatibility check for accounts imported by an older build that did
        // not canonicalize email casing at write time.
        await database.db.update(user).set({ email: email.toUpperCase() }).where(eq(user.email, email));
        const login = await request("/api/auth/sign-in/email", { email, password });
        expect(login.status).toBe(200);
        const duplicate = await request("/api/auth/sign-up/email", { name: "Again", email, password });
        expect(duplicate.status).toBe(409);
        expect(await duplicate.json()).toMatchObject({ error: { code: "email_already_registered" } });
    });

    test("concurrent duplicate sign-up resolves to one account and one actionable conflict", async () => {
        const raceEmail = `race-${crypto.randomUUID()}@example.test`;
        const responses = await Promise.all([
            request("/api/auth/sign-up/email", { name: "Race A", email: raceEmail, password }),
            request("/api/auth/sign-up/email", { name: "Race B", email: raceEmail.toUpperCase(), password }),
        ]);
        expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
        const conflict = responses.find((response) => response.status === 409)!;
        expect(await conflict.json()).toMatchObject({ error: { code: "email_pending_verification" } });
    });
});
