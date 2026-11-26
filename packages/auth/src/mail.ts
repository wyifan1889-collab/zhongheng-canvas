import nodemailer from "nodemailer";
import type { SendMailOptions } from "nodemailer";
import type { AuthMail, AuthVerificationCodeMail } from "./index";

export type SmtpConfig = {
    host: string; port: number; secure: boolean; user: string; password: string;
    from: string; origin: string; connectionTimeoutMs: number; socketTimeoutMs: number;
};

function createSmtpTransport(config: SmtpConfig) {
    return nodemailer.createTransport({
        host: config.host, port: config.port, secure: config.secure,
        auth: { user: config.user, pass: config.password },
        requireTLS: true, ignoreTLS: false,
        connectionTimeout: config.connectionTimeoutMs,
        greetingTimeout: config.connectionTimeoutMs,
        socketTimeout: config.socketTimeoutMs,
        disableFileAccess: true, disableUrlAccess: true,
        logger: false, debug: false,
    });
}

type VerifiableTransport = { verify(): Promise<unknown>; close(): void };

export function createSmtpMailer(config: SmtpConfig) {
    const transport = createSmtpTransport(config);
    return createAuthMailer(transport, config.from, config.origin);
}

/** Verify connection and SMTP authentication without sending a message. */
export async function verifySmtpConnection(config: SmtpConfig, factory: (config: SmtpConfig) => VerifiableTransport = createSmtpTransport): Promise<void> {
    const transport = factory(config);
    try {
        await transport.verify();
    } catch {
        throw new Error("SMTP 连接或认证未完成，请检查主机、端口、TLS 和授权码配置。");
    } finally {
        transport.close();
    }
}

/** Exported separately to verify messages without connecting to a real SMTP account. */
export function createAuthMailer(transport: { sendMail(message: SendMailOptions): Promise<unknown> }, from: string, origin: string) {
    const expectedOrigin = new URL(origin).origin;
    async function send(mail: AuthMail, purpose: "verification" | "reset") {
        const url = new URL(mail.url);
        const validPath = purpose === "verification" ? url.pathname === "/api/auth/verify-email" : url.pathname.startsWith("/api/auth/reset-password/");
        if (url.origin !== expectedOrigin || url.username || url.password || !validPath) throw new Error("邮件验证地址不受信任");
        try {
            await transport.sendMail({
                from, to: mail.to,
                subject: purpose === "verification" ? "验证你的画布账号邮箱" : "重置你的画布账号密码",
                text: `${purpose === "verification" ? "请打开以下链接验证邮箱" : "请打开以下链接重置密码"}：\n\n${url.href}\n\n${purpose === "reset" ? "重置链接仅限单次使用，请尽快完成；如果链接已过期，请重新申请。" : "如果链接已失效，请重新发送验证邮件。"}\n\n如果不是你本人操作，请忽略此邮件。`,
                disableFileAccess: true, disableUrlAccess: true,
            });
        } catch { throw new Error("邮件服务暂不可用，请稍后重新申请"); }
    }
    async function sendVerificationCode(mail: AuthVerificationCodeMail) {
        if (!/^\d{6}$/.test(mail.code)) throw new Error("邮箱验证码格式无效");
        try {
            await transport.sendMail({
                from, to: mail.to,
                subject: "验证你的画布账号邮箱",
                text: `你的邮箱验证码是：${mail.code}\n\n验证码 5 分钟内有效，最多尝试 3 次。如果不是你本人操作，请忽略此邮件。`,
                disableFileAccess: true, disableUrlAccess: true,
            });
        } catch { throw new Error("邮件服务暂不可用，请稍后重新申请"); }
    }
    return {
        sendVerificationEmail: (mail: AuthMail) => send(mail, "verification"),
        sendVerificationCode,
        sendResetPassword: (mail: AuthMail) => send(mail, "reset"),
    };
}
