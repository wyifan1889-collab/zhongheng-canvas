// Diagnostic only: in-memory database, synthetic identities, no external services or migrations.
// Run: bun --no-env-file run scripts/saas/review-foundation.ts
import { createTestDatabase } from "../../apps/api/test/database";
import { createAccountApi } from "../../apps/api/src/accounts";
import { createAuth } from "../../packages/auth/src/index";

if (process.env.SAAS_TEST_DATABASE_URL) throw new Error("Review accepts only a fresh in-memory database");
const database = await createTestDatabase();
const origin = "http://localhost:4000";
const secret = "review-only-" + crypto.randomUUID() + crypto.randomUUID();
const mails: { to: string; url: string }[] = [];
const faults: unknown[] = [];
let rateCalls = 0;
let unavailable = false;
let mailUnavailable = false;
const authOptions = {
    secret,
    sendVerificationEmail: async (mail: { to: string; url: string }) => {
        if (mailUnavailable) throw new Error("synthetic-mail-outage");
        mails.push(mail);
    },
    sendResetPassword: async (mail: { to: string; url: string }) => { mails.push(mail); },
};
const accounts = createAccountApi({
    database: database.db, origin, auth: authOptions,
    rates: { consume: async () => {
        rateCalls++;
        if (unavailable) throw new Error("synthetic-rate-store-outage");
        return { allowed: true as const };
    } },
    verifyHuman: async () => true,
    onFault: (event) => { faults.push(event); },
});
function request(path: string, body?: unknown, cookie = "") {
    return accounts(new Request(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { origin, "content-type": "application/json", cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), "198.51.100.100");
}
const query = (text: string, values: unknown[] = []) => database.pool.query({ text, values });
async function ageSession() {
    // Synthetic DB timestamps only; do not change system time or real session policy.
    await query("UPDATE canvas_saas.session SET created_at = now() - interval '2 days', updated_at = now() - interval '2 days', expires_at = now() + interval '5 days'");
}
async function expiry() {
    const result = await query("SELECT extract(epoch from expires_at)::float8 AS expiry FROM canvas_saas.session");
    return Number(result.rows[0].expiry);
}

try {
    const identity = { name: "Review only", email: "review@example.test", password: "synthetic-review-password" };
    if ((await request("/api/auth/sign-up/email", identity)).status !== 200) throw new Error("Synthetic signup setup failed");
    if ((await accounts(new Request(mails[0].url), "198.51.100.100")).status !== 302) throw new Error("Synthetic verification setup failed");
    const login = await request("/api/auth/sign-in/email", { email: identity.email, password: identity.password });
    if (login.status !== 200) throw new Error("Synthetic login setup failed");
    const cookie = login.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");

    await ageSession();
    const before = await expiry();
    const projected = await request("/api/v1/session", undefined, cookie);
    console.log(JSON.stringify({
        check: "facade-session-refresh", status: projected.status,
        databaseExpiryExtended: (await expiry()) > before,
        setCookieCount: projected.headers.getSetCookie().length,
    }));
    await ageSession();
    const rawAuth = createAuth({ database: database.db, baseURL: origin, ...authOptions });
    const rawSession = await rawAuth.api.getSession({ headers: new Headers({ cookie }), asResponse: true });
    console.log(JSON.stringify({ check: "library-session-refresh", status: rawSession.status, setCookieCount: rawSession.headers.getSetCookie().length }));

    unavailable = true;
    for (const [path, body] of [
        ["/api/auth/sign-in/email", { email: identity.email, password: identity.password }],
        ["/api/auth/reset-password", { token: "synthetic-invalid-token", newPassword: "synthetic-new-password" }],
        ["/api/auth/verify-email?token=synthetic-invalid-token", undefined],
        ["/api/auth/sign-out", {}],
    ] as const) {
        rateCalls = 0;
        const response = await request(path, body);
        console.log(JSON.stringify({ check: "rate-store-outage", route: path.split("?")[0], status: response.status, rateCalls }));
    }
    unavailable = false;
    mailUnavailable = true;
    faults.length = 0;
    const failedMail = await request("/api/auth/sign-up/email", { name: "Failure only", email: "review-failure@example.test", password: identity.password });
    console.log(JSON.stringify({ check: "mail-fault-visibility", status: failedMail.status, faultEvents: faults.length }));
} finally {
    await database.close();
}
