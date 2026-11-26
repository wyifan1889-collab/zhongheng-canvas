import { verifySmtpConnection } from "@infinite-canvas/auth/mail";
import { readSmtpConfig } from "./config";

/**
 * Explicit SMTP preflight. It authenticates the configured transport only;
 * it never sends a verification or reset message.
 */
try {
    const config = readSmtpConfig(process.env);
    await verifySmtpConnection({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
        secure: config.SMTP_SECURE === "true",
        user: config.SMTP_USER,
        password: config.SMTP_PASSWORD,
        from: config.SMTP_FROM,
        origin: config.SAAS_ORIGIN,
        connectionTimeoutMs: config.SMTP_CONNECTION_TIMEOUT_MS,
        socketTimeoutMs: config.SMTP_SOCKET_TIMEOUT_MS,
    });
    console.log("SMTP 连接与认证验证通过；本次未发送测试邮件。");
} catch (error) {
    console.error(error instanceof Error ? error.message : "SMTP 检查未完成。");
    process.exitCode = 1;
}
