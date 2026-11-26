import { describe, expect, test } from "bun:test";
import { createTurnstileVerifier } from "@infinite-canvas/auth/captcha";
import { createAuthMailer, verifySmtpConnection } from "@infinite-canvas/auth/mail";
import { readAccountConfig, readSmtpConfig } from "../src/config";

const origin = "https://canvas.example.test";
const request = (token?: string) => new Request(`${origin}/api/auth/sign-in/email`, {
    headers: token ? { "x-captcha-response": token } : {},
});

describe("external service adapters without external requests", () => {
    test("Turnstile requires a token and binds successful verification to hostname and action", async () => {
        let calls = 0;
        let verdict: unknown = { success: true, hostname: "canvas.example.test", action: "account" };
        const fetcher = (async (url, init) => {
            calls++;
            expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
            expect(init?.redirect).toBe("error");
            expect(init?.body).toBeInstanceOf(URLSearchParams);
            expect((init!.body as URLSearchParams).get("response")).toBe("synthetic-captcha-token");
            return Response.json(verdict);
        }) as typeof fetch;
        const verify = createTurnstileVerifier({ secret: "synthetic-secret", hostname: "canvas.example.test", timeoutMs: 1000 }, fetcher);
        expect(await verify(request())).toBe(false);
        expect(calls).toBe(0);
        expect(await verify(request("synthetic-captcha-token"))).toBe(true);
        for (const invalid of [
            { success: false, "error-codes": ["timeout-or-duplicate"] },
            { success: true, hostname: "untrusted.example", action: "account" },
            { success: true, hostname: "canvas.example.test", action: "other" },
            { success: true },
        ]) {
            verdict = invalid;
            expect(await verify(request("synthetic-captcha-token"))).toBe(false);
        }
    });
    test("Turnstile errors are sanitized and never retried", async () => {
        let calls = 0;
        const verify = createTurnstileVerifier({ secret: "synthetic-secret", hostname: "canvas.example.test", timeoutMs: 1000 },
            (async () => { calls++; throw new Error("private-request-token-and-secret"); }) as typeof fetch);
        await expect(verify(request("test-token"))).rejects.toThrow("人机验证服务暂不可用");
        expect(calls).toBe(1);
    });
    test("official local Turnstile test key accepts its fixed local-development verdict", async () => {
        let calls = 0;
        const verify = createTurnstileVerifier({
            secret: "1x0000000000000000000000000000000AA", hostname: "127.0.0.1", timeoutMs: 1000,
        }, (async () => { calls++; return Response.json({ success: true, hostname: "example.com" }); }) as typeof fetch);
        expect(await verify(new Request("http://127.0.0.1/api/auth/sign-in/email", {
            headers: { "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX" },
        }))).toBe(true);
        expect(calls).toBe(0);
    });
    test("a hanging captcha request is aborted by the supplied test deadline", async () => {
        const verify = createTurnstileVerifier({ secret: "synthetic-secret", hostname: "canvas.example.test", timeoutMs: 5 },
            ((_url, init) => new Promise((_resolve, reject) => {
                init!.signal!.addEventListener("abort", () => reject(new Error("test-only-timeout")), { once: true });
            })) as typeof fetch);
        await expect(verify(request("test-token"))).rejects.toThrow("人机验证服务暂不可用");
    });
    test("verification and reset emails contain only platform-owned links and plain text", async () => {
        const sent: Record<string, unknown>[] = [];
        const sender = createAuthMailer({ sendMail: async (message) => { sent.push(message as Record<string, unknown>); } }, "noreply@example.test", origin);
        await sender.sendVerificationEmail({ to: "alice@example.test", url: `${origin}/api/auth/verify-email?token=synthetic` });
        await sender.sendVerificationCode({ to: "alice@example.test", code: "123456", type: "email-verification" });
        await sender.sendResetPassword({ to: "alice@example.test", url: `${origin}/api/auth/reset-password/synthetic` });
        expect(sent).toHaveLength(3);
        expect(sent[0]).toMatchObject({ to: "alice@example.test", disableFileAccess: true, disableUrlAccess: true });
        expect(sent[0]).not.toHaveProperty("html");
        expect(String(sent[0].text)).toContain("如果链接已失效，请重新发送验证邮件。");
        expect(String(sent[2].text)).toContain("重置链接仅限单次使用，请尽快完成；如果链接已过期，请重新申请。");
        await expect(sender.sendVerificationEmail({ to: "alice@example.test", url: "https://untrusted.example/api/auth/verify-email" })).rejects.toThrow();
        await expect(sender.sendVerificationCode({ to: "alice@example.test", code: "12345", type: "email-verification" })).rejects.toThrow();
        expect(sent).toHaveLength(3);
    });
    test("mail failures expose no credentials and do not automatically resend", async () => {
        let calls = 0;
        const sender = createAuthMailer({ sendMail: async () => { calls++; throw new Error("smtp-password-and-host"); } }, "noreply@example.test", origin);
        await expect(sender.sendVerificationEmail({ to: "alice@example.test", url: `${origin}/api/auth/verify-email?token=synthetic` }))
            .rejects.toThrow("邮件服务暂不可用");
        expect(calls).toBe(1);
    });
    test("SMTP preflight verifies and closes without sending a message", async () => {
        let verified = 0, closed = 0;
        await verifySmtpConnection({ host: "smtp.example.test", port: 465, secure: true, user: "test-user", password: "private-password", from: "noreply@example.test", origin, connectionTimeoutMs: 1000, socketTimeoutMs: 1000 }, () => ({
            async verify() { verified++; },
            close() { closed++; },
        }));
        expect(verified).toBe(1); expect(closed).toBe(1);
    });
    test("SMTP preflight sanitizes failures and still closes the transport", async () => {
        let closed = 0;
        await expect(verifySmtpConnection({ host: "smtp.example.test", port: 465, secure: true, user: "test-user", password: "private-password", from: "noreply@example.test", origin, connectionTimeoutMs: 1000, socketTimeoutMs: 1000 }, () => ({
            async verify() { throw new Error("private SMTP password and host"); },
            close() { closed++; },
        }))).rejects.toThrow("SMTP 连接或认证未完成");
        expect(closed).toBe(1);
    });
});

describe("opt-in runtime configuration", () => {
    const complete = {
        SAAS_ACCOUNTS_ENABLED: "true", SAAS_DATABASE_URL: "postgresql://test:test@127.0.0.1/test_only",
        SAAS_ORIGIN: origin, SAAS_AUTH_SECRET: "test-only-" + "x".repeat(32),
        SMTP_HOST: "smtp.example.test", SMTP_PORT: "465", SMTP_SECURE: "true",
        SMTP_USER: "test-user", SMTP_PASSWORD: "never-log-this-test-password", SMTP_FROM: "noreply@example.test",
        TURNSTILE_SECRET_KEY: "test-secret", TURNSTILE_SITE_KEY: "public-site-key",
        CAPTCHA_TIMEOUT_MS: "1000", SMTP_CONNECTION_TIMEOUT_MS: "1000", SMTP_SOCKET_TIMEOUT_MS: "1000",
    };
    test("account endpoints remain off without the explicit enable flag", () => {
        expect(readAccountConfig({ DATABASE_URL: "must-not-be-used" })).toBeNull();
        expect(readAccountConfig({ ...complete, SAAS_ACCOUNTS_ENABLED: "false" })).toBeNull();
    });
    test("missing services, unsafe origins and invalid durations prevent enablement", () => {
        for (const patch of [
            { TURNSTILE_SECRET_KEY: "" }, { SMTP_PASSWORD: "" }, { SMTP_SOCKET_TIMEOUT_MS: "0" },
            { SAAS_ORIGIN: "http://public.example.test" }, { SAAS_ORIGIN: "https://user:password@example.test" },
            { SAAS_ORIGIN: "https://example.test/unexpected-path" }, { SAAS_AUTH_SECRET: "short" },
        ]) expect(() => readAccountConfig({ ...complete, ...patch })).toThrow();
        try { readAccountConfig({ ...complete, SMTP_PORT: "invalid-never-log-this" }); }
        catch (error) {
            expect(String(error)).toContain("SMTP_PORT");
            expect(String(error)).not.toContain("never-log-this");
        }
        expect(() => readAccountConfig({ ...complete, SAAS_TRUSTED_PROXY: "true", SAAS_ORIGIN: "http://127.0.0.1:4011" }))
            .toThrow("真实 HTTPS 域名");
    });
    test("valid settings use a dedicated database and explicit service deadlines", () => {
        const result = readAccountConfig(complete)!;
        expect(result.SMTP_PORT).toBe(465);
        expect(result.CAPTCHA_TIMEOUT_MS).toBe(1000);
        expect(result.SAAS_DATABASE_URL).toBe(complete.SAAS_DATABASE_URL);
        expect(result.cloudCanvas).toBe(false);
        expect(result.cloudMedia).toBe(false);
        expect(result.payments).toEqual({ enabled: false });
    });
    test("payment opt-in requires explicit safety configuration and a real HTTPS callback origin", () => {
        const payments = { SAAS_PAYMENTS_ENABLED: "true", SAAS_PAYMENTS_TIMEOUT_MS: "1234", SAAS_PAYMENTS_JSON_MAX_BYTES: "4096", SAAS_PAYMENTS_LINK_ORIGINS: "[]" };
        expect(() => readAccountConfig({ ...complete, SAAS_PAYMENTS_ENABLED: "true" })).toThrow("SAAS_PAYMENTS_TIMEOUT_MS");
        for (const value of ["http://127.0.0.1:4011", "https://localhost"]) {
            expect(() => readAccountConfig({ ...complete, ...payments, SAAS_ORIGIN: value })).toThrow("真实 HTTPS 域名");
        }
        expect(readAccountConfig({ ...complete, ...payments })?.payments).toEqual({ enabled: true, timeoutMs: 1234, maxResponseBytes: 4096, paymentLinkOrigins: [] });
    });
    test("trusted proxy is allowed only for a real HTTPS origin", () => {
        const result = readAccountConfig({ ...complete, SAAS_TRUSTED_PROXY: "true" })!;
        expect(result.SAAS_TRUSTED_PROXY).toBe("true");
    });
    test("media can be enabled separately from the unfinished cloud canvas", () => {
        const storage = {
            STORAGE_PROVIDER: "aliyun-oss", ALIYUN_OSS_REGION: "oss-cn-shanghai",
            ALIYUN_OSS_ACCESS_KEY_ID: "test-access-key", ALIYUN_OSS_ACCESS_KEY_SECRET: "test-access-secret",
            ALIYUN_OSS_BUCKET: "infinite-canvas-dev", SAAS_MEDIA_ENABLED: "true",
        };
        const result = readAccountConfig({ ...complete, ...storage })!;
        expect(result.cloudCanvas).toBe(false);
        expect(result.cloudMedia).toBe(true);
        expect(result.storage?.quotaBytes).toBe(1024 * 1024 * 1024);
        expect(() => readAccountConfig({ ...complete, SAAS_MEDIA_ENABLED: "true" })).toThrow("对象存储");
    });
    test("cloud canvas requires complete object storage and remains separately gated", () => {
        const storage = {
            STORAGE_PROVIDER: "aliyun-oss", ALIYUN_OSS_REGION: "oss-cn-shanghai",
            ALIYUN_OSS_ACCESS_KEY_ID: "test-access-key", ALIYUN_OSS_ACCESS_KEY_SECRET: "test-access-secret",
            ALIYUN_OSS_BUCKET: "infinite-canvas-dev", SAAS_CLOUD_CANVAS_ENABLED: "true",
        };
        const result = readAccountConfig({ ...complete, ...storage })!;
        expect(result.cloudCanvas).toBe(true);
        expect(result.cloudMedia).toBe(false);
        expect(result.storage?.provider).toBe("aliyun-oss");
        expect(() => readAccountConfig({ ...complete, SAAS_CLOUD_CANVAS_ENABLED: "true" })).toThrow("对象存储");
        expect(() => readAccountConfig({ ...complete, SAAS_CLOUD_CANVAS_ENABLED: "enabled" })).toThrow("SAAS_CLOUD_CANVAS_ENABLED");
        expect(() => readAccountConfig({ ...complete, ...storage, SAAS_ORIGIN: "http://127.0.0.1:4181" }))
            .toThrow("真实 HTTPS 域名");
        expect(() => readAccountConfig({ ...complete, ...storage, SAAS_ORIGIN: "https://localhost" }))
            .toThrow("真实 HTTPS 域名");
        expect(() => readAccountConfig({ ...complete, ...storage, SAAS_ORIGIN: "https://canvas.example.test" })).not.toThrow();
        expect(() => readAccountConfig({ ...complete, SAAS_CLOUD_CANVAS_ENABLED: "true", STORAGE_PROVIDER: "server-disk", SAAS_STORAGE_ROOT: "C:/canvas-media" }))
            .toThrow("阿里云 OSS");
        expect(() => readAccountConfig({ ...complete, SAAS_MEDIA_ENABLED: "true", STORAGE_PROVIDER: "server-disk", SAAS_STORAGE_ROOT: "C:/canvas-media" }))
            .not.toThrow();
    });
    test("SMTP-only preflight does not require account, database or Turnstile settings", () => {
        const result = readSmtpConfig({
            SAAS_ORIGIN: origin, SMTP_HOST: "smtp.qq.com", SMTP_PORT: "465", SMTP_SECURE: "true",
            SMTP_USER: "owner@example.test", SMTP_PASSWORD: "local-only-authorization-code", SMTP_FROM: "owner@example.test",
            SMTP_CONNECTION_TIMEOUT_MS: "10000", SMTP_SOCKET_TIMEOUT_MS: "30000",
        });
        expect(result.SMTP_HOST).toBe("smtp.qq.com"); expect(result.SMTP_PORT).toBe(465); expect(result.SMTP_SECURE).toBe("true");
    });
    test("the non-secret example records approved waits without enabling accounts", async () => {
        const example = await Bun.file(new URL("../.env.example", import.meta.url)).text();
        const values = Object.fromEntries(example.split(/\r?\n/).filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
            const equals = line.indexOf("=");
            return [line.slice(0, equals), line.slice(equals + 1)];
        }));
        expect(readAccountConfig(values)).toBeNull();
        const result = readAccountConfig({ ...complete,
            CAPTCHA_TIMEOUT_MS: values.CAPTCHA_TIMEOUT_MS,
            SMTP_CONNECTION_TIMEOUT_MS: values.SMTP_CONNECTION_TIMEOUT_MS,
            SMTP_SOCKET_TIMEOUT_MS: values.SMTP_SOCKET_TIMEOUT_MS,
        })!;
        expect(result.CAPTCHA_TIMEOUT_MS).toBe(10_000);
        expect(result.SMTP_CONNECTION_TIMEOUT_MS).toBe(10_000);
        expect(result.SMTP_SOCKET_TIMEOUT_MS).toBe(30_000);
    });
});
