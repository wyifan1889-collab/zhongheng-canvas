import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins/email-otp";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { eq, sql } from "drizzle-orm";
import { APIError, isAPIError } from "better-auth/api";
import type { Database } from "@infinite-canvas/database";
import * as schema from "@infinite-canvas/database/schema";

export type AuthMail = { to: string; url: string };
export type AuthVerificationCodeMail = { to: string; code: string; type: "email-verification" };
export type AuthOptions = {
    database: Database;
    baseURL: string;
    secret: string;
    sendVerificationEmail: (mail: AuthMail) => Promise<void>;
    sendVerificationCode?: (mail: AuthVerificationCodeMail) => Promise<void>;
    sendResetPassword: (mail: AuthMail) => Promise<void>;
};

/** Foundation factory only. Public HTTP routes remain closed until P1 safeguards pass. */
export function createAuth(options: AuthOptions) {
    const origin = new URL(options.baseURL).origin;
    return betterAuth({
        appName: "Infinite Canvas SaaS",
        baseURL: origin,
        basePath: "/api/auth",
        secret: options.secret,
        trustedOrigins: [origin],
        // Better Auth relaxes origin checks in test mode unless explicitly enabled.
        // Keep the same security boundary in tests and future runtime integrations.
        advanced: {
            disableOriginCheck: false, disableCSRFCheck: false,
            useSecureCookies: origin.startsWith("https://"),
            ipAddress: { ipAddressHeaders: ["x-canvas-peer-ip"] },
        },
        // Public access must go through the atomic PostgreSQL guard in accounts.ts.
        rateLimit: { enabled: false },
        // Auth errors can contain token-bearing URLs; the HTTP layer reports only request IDs/codes.
        logger: { disabled: true },
        // better-call otherwise prints unexpected errors even when the auth logger is disabled.
        // Convert them before that fallback; retain normal auth rejection status/semantics.
        onAPIError: { onError: (error) => {
            if (isAPIError(error)) throw error;
            throw new APIError("INTERNAL_SERVER_ERROR", { code: "AUTH_UNAVAILABLE", message: "账户服务暂时不可用" });
        } },
        database: drizzleAdapter(options.database, { provider: "pg", schema, transaction: true }),
        emailAndPassword: {
            enabled: true,
            minPasswordLength: 8,
            maxPasswordLength: 128,
            requireEmailVerification: true,
            autoSignIn: false,
            revokeSessionsOnPasswordReset: true,
            sendResetPassword: ({ user, url }) => options.sendResetPassword({ to: user.email, url }),
        },
        plugins: [emailOTP({
            // Production runtime supplies the OTP mailer and replaces link mail;
            // isolated tests without it keep the legacy link callback.
            overrideDefaultEmailVerification: Boolean(options.sendVerificationCode),
            sendVerificationOnSignUp: true,
            otpLength: 6,
            expiresIn: 300,
            allowedAttempts: 3,
            storeOTP: "hashed",
            sendVerificationOTP: async ({ email, otp, type }) => {
                if (type !== "email-verification" || !options.sendVerificationCode) return;
                await options.sendVerificationCode({ to: email, code: otp, type });
            },
        })],
        emailVerification: options.sendVerificationCode ? {
            // emailOTP's init hook supplies sendVerificationEmail. Do not
            // provide the legacy link callback here: Better Auth's option
            // merge intentionally preserves an explicit user callback.
            sendOnSignUp: true,
            sendOnSignIn: false,
            autoSignInAfterVerification: false,
        } : {
            sendOnSignUp: true,
            sendOnSignIn: false,
            autoSignInAfterVerification: false,
            sendVerificationEmail: ({ user, url }) => options.sendVerificationEmail({ to: user.email, url }),
        },
        user: {
            additionalFields: {
                role: { type: ["user", "admin"], required: true, defaultValue: "user", input: false },
                disabled: { type: "boolean", required: true, defaultValue: false, input: false },
                moderationVersion: { type: "number", required: true, defaultValue: 0, input: false },
            },
        },
        // Keep database-backed revocation authoritative; no session cookie cache.
        session: { cookieCache: { enabled: false }, additionalFields: {
            moderationVersion: { type: "number", required: true, defaultValue: 0, input: false },
        } },
        databaseHooks: {
            session: { create: { before: async (record) => {
                const [owner] = await options.database.select({ disabled: schema.user.disabled, emailVerified: schema.user.emailVerified,
                    moderationVersion: sql<number>`moderation_version` }).from(schema.user).where(eq(schema.user.id, record.userId));
                if (!owner || owner.disabled || !owner.emailVerified || !Number.isInteger(owner.moderationVersion) ||
                    owner.moderationVersion < 0 || owner.moderationVersion > 2_147_483_647) {
                    throw new APIError("FORBIDDEN", { code: "ACCOUNT_UNAVAILABLE", message: "账户不可用" });
                }
                // Capture the version that authorized this login. A session insert
                // delayed past ban/unban remains unusable even after re-enabling.
                return { data: { ...record, moderationVersion: owner.moderationVersion } };
            } } },
        },
    });
}

export async function getPrincipal(auth: ReturnType<typeof createAuth>, headers: Headers) {
    const { response: session, headers: authHeaders } = await auth.api.getSession({ headers, returnHeaders: true });
    const principal = session && session.user.emailVerified && !session.user.disabled &&
        Number.isInteger(session.user.moderationVersion) && session.user.moderationVersion >= 0 &&
        session.user.moderationVersion === session.session.moderationVersion
        ? { id: session.user.id, name: session.user.name, email: session.user.email, role: session.user.role } : null;
    // Return renewal cookies alongside the safe projection; never expose the raw session in JSON.
    // A disabled/unverified/expired account must not receive a renewed authentication cookie.
    const responseHeaders = new Headers();
    if (principal) {
        for (const cookie of authHeaders.getSetCookie()) responseHeaders.append("set-cookie", cookie);
    }
    return { principal, headers: responseHeaders,
        // Server-only context for pending administrative writes; never serialize this object.
        sessionContext: principal && session ? { id: session.session.id, expiresAt: session.session.expiresAt,
            moderationVersion: session.session.moderationVersion } : null };
}
