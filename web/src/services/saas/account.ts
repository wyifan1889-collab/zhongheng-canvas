import type { SessionPrincipal } from "../../../../packages/shared/src/index";

export type AccountSite = {
    registration: boolean;
    cloudCanvas: boolean;
    cloudMedia: boolean;
    captcha: { siteKey: string; action: "account" } | null;
};
export type AccountCommand =
    | { action: "sign-in/email"; email: string; password: string; captcha: string }
    | { action: "sign-up/email"; name: string; email: string; password: string; captcha: string }
    | { action: "send-verification-email" | "send-email-otp" | "request-password-reset"; email: string; captcha: string }
    | { action: "verify-email-otp"; email: string; otp: string }
    | { action: "reset-password"; token: string; newPassword: string }
    | { action: "sign-out" | "revoke-sessions" };

export class AccountError extends Error {
    constructor(public code: string, message: string, public status = 0, public retryAfter?: number) {
        super(message);
    }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const unavailable = () => new AccountError("unavailable", "账户服务未接通或暂时不可用，请检查连接后重试。");

/** Only same-origin platform endpoints. No provider credentials, local tokens or automatic retries. */
export function createAccountClient(fetcher: typeof fetch = fetch) {
    async function request(path: string, body?: object, captcha?: string): Promise<unknown> {
        let response: Response;
        try {
            response = await fetcher(path, {
                method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
                redirect: "error", referrerPolicy: "no-referrer",
                headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(captcha ? { "x-captcha-response": captcha } : {}) },
                ...(body ? { body: JSON.stringify(body) } : {}),
            });
        } catch { throw unavailable(); }
        let data: unknown;
        try {
            if (!response.headers.get("content-type")?.includes("application/json")) throw unavailable();
            data = await response.json();
        } catch { throw unavailable(); }
        if (!response.ok) {
            const code = record(data) && record(data.error) && typeof data.error.code === "string" ? data.error.code : "unavailable";
            const seconds = Number(response.headers.get("retry-after"));
            const retryAfter = Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
            if (response.status === 429) throw new AccountError("rate_limited", retryAfter ? `操作过于频繁，请等待 ${retryAfter} 秒后手动重试。` : "操作过于频繁，请稍后手动重试。", 429, retryAfter);
            const messages: Record<string, string> = {
                captcha_failed: "人机验证未通过，请重新验证后再提交。",
                invalid_origin: "账户请求来源不匹配，请联系管理员检查站点配置。",
                mail_unavailable: "邮件发送尚未确认，请稍后重试或检查邮箱服务配置。",
                invalid_token: "重置链接无效或已过期，请重新申请密码重置邮件。",
                email_already_registered: "该邮箱已经注册，请直接登录；如果忘记密码，请使用“忘记密码”。",
                email_pending_verification: "该邮箱已提交注册但尚未验证，不能重复注册；请使用“未收到验证邮件”重新发送验证码。",
                invalid_credentials: "邮箱或密码错误；如果刚注册，请先完成邮箱验证码验证。",
                email_not_verified: "该邮箱尚未验证，请先完成邮箱验证码；没有收到验证码可重新发送。",
                invalid_password: "密码长度需为 8–128 个字符。",
                invalid_verification_code: "验证码错误，请检查邮件中的 6 位验证码。",
                verification_code_expired: "验证码已过期，请重新发送验证码。",
                verification_code_locked: "验证码尝试次数过多，请重新发送验证码后再试。",
                account_unavailable: "该账号当前不可用，请联系管理员。",
                auth_rejected: "账户操作未完成，请检查信息后重试。",
                unauthorized: "当前未登录或登录已失效，请重新登录。",
                invalid_input: "信息格式不正确，请检查后再提交。",
            };
            const message = code === "mail_unavailable" && path.endsWith("/request-password-reset")
                ? "重置邮件发送尚未确认，请稍后重新申请或检查邮箱服务配置。"
                : code === "mail_unavailable" && (path.endsWith("/sign-up/email") || path.endsWith("/send-verification-email") || path.endsWith("/email-otp/send-verification-otp"))
                    ? "验证邮件发送尚未确认；账户可能已建立但仍未验证，请查收邮件或重新发送验证码。"
                    : messages[code];
            // Never display or log a server/proxy exception, raw message, URL or response body.
            const known = Object.hasOwn(messages, code);
            throw new AccountError(known ? code : "unavailable", known ? (message ?? messages[code]) : unavailable().message, response.status);
        }
        return data;
    }
    return {
        async site(): Promise<AccountSite> {
            const data = await request("/api/v1/site");
            if (!record(data) || data.schemaVersion !== 1 || !record(data.features) || typeof data.features.registration !== "boolean") throw unavailable();
            if (data.features.cloudCanvas !== undefined && typeof data.features.cloudCanvas !== "boolean") throw unavailable();
            if (data.features.cloudMedia !== undefined && typeof data.features.cloudMedia !== "boolean") throw unavailable();
            const cloudCanvas = data.features.cloudCanvas === true;
            const cloudMedia = data.features.cloudMedia === true;
            if (data.authentication === undefined) {
                if (data.features.registration) throw unavailable();
                return { registration: false, cloudCanvas: false, cloudMedia: false, captcha: null };
            }
            const auth = data.authentication;
            if (!record(auth) || auth.method !== "email-password" || !record(auth.captcha) || auth.captcha.provider !== "turnstile" || auth.captcha.action !== "account" || typeof auth.captcha.siteKey !== "string" || !auth.captcha.siteKey.trim()) throw unavailable();
            return { registration: data.features.registration, cloudCanvas, cloudMedia, captcha: { siteKey: auth.captcha.siteKey, action: "account" } };
        },
        async session(): Promise<SessionPrincipal | null> {
            let data: unknown;
            try { data = await request("/api/v1/session"); }
            catch (error) {
                if (error instanceof AccountError && error.status === 401 && error.code === "unauthorized") return null;
                throw error;
            }
            if (!record(data) || !record(data.user)) throw unavailable();
            const { id, name, email, role } = data.user;
            if (typeof id !== "string" || !id || typeof name !== "string" || (email !== undefined && (typeof email !== "string" || !email)) || (role !== "user" && role !== "admin")) throw unavailable();
            return { id, name, ...(typeof email === "string" ? { email } : {}), role };
        },
        async submit(command: AccountCommand): Promise<void> {
            let body: object;
            switch (command.action) {
                case "sign-in/email": body = { email: command.email.trim(), password: command.password }; break;
                case "sign-up/email": body = { name: command.name.trim(), email: command.email.trim(), password: command.password }; break;
                case "send-verification-email":
                case "request-password-reset": body = { email: command.email.trim() }; break;
                case "send-email-otp": body = { email: command.email.trim(), type: "email-verification" }; break;
                case "verify-email-otp": body = { email: command.email.trim(), otp: command.otp.trim() }; break;
                case "reset-password": body = { token: command.token, newPassword: command.newPassword }; break;
                case "sign-out": body = {}; break;
                case "revoke-sessions": body = {}; break;
                default: throw new AccountError("invalid_input", "不支持此账户操作。");
            }
            if ("captcha" in command && !command.captcha) throw new AccountError("captcha_failed", "请先完成人机验证。");
            const path = command.action === "send-email-otp" ? "/api/auth/email-otp/send-verification-otp"
                : command.action === "verify-email-otp" ? "/api/auth/email-otp/verify-email" : `/api/auth/${command.action}`;
            const data = await request(path, body, "captcha" in command ? command.captcha : undefined);
            if (!record(data) || data.ok !== true) throw unavailable();
        },
    };
}

export const accountClient = createAccountClient();
