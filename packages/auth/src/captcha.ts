import { z } from "zod";

const verdict = z.object({ success: z.boolean(), hostname: z.string().optional(), action: z.string().optional() });
const localTurnstileTestSecret = "1x0000000000000000000000000000000AA";
const localTurnstileTestToken = "XXXX.DUMMY.TOKEN.XXXX";
const localHostnames = new Set(["localhost", "127.0.0.1", "0.0.0.0"]);

/** Cloudflare validates token expiry and single-use; this server additionally binds host and action. */
export function createTurnstileVerifier(
    config: { secret: string; hostname: string; timeoutMs: number },
    fetcher: typeof fetch = fetch,
) {
    if (!config.secret || !config.hostname || !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1) {
        throw new Error("人机验证配置不完整");
    }
    return async (request: Request) => {
        const token = request.headers.get("x-captcha-response");
        if (!token?.trim()) return false;
        // The official local-development key/token pair is intentionally
        // offline. Do not make a local login depend on Cloudflare being
        // reachable; real keys still go through the provider verification.
        const localTest = config.secret === localTurnstileTestSecret && localHostnames.has(config.hostname) && token.trim() === localTurnstileTestToken;
        if (localTest) return true;
        try {
            const response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
                method: "POST",
                body: new URLSearchParams({ secret: config.secret, response: token }),
                signal: AbortSignal.any([request.signal, AbortSignal.timeout(config.timeoutMs)]),
                redirect: "error",
            });
            if (!response.ok) throw new Error("verification-unavailable");
            const result = verdict.parse(await response.json());
            // Cloudflare's official always-pass test secret returns a fixed example.com
            // hostname and no action. Keep this exception local-only; production keys
            // still require both bindings.
            return result.success && result.hostname === config.hostname && result.action === "account";
        } catch {
            // Do not leak a token-bearing request or provider response through error logging.
            throw new Error("人机验证服务暂不可用");
        }
    };
}
