import { useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button, Tooltip } from "@/components/creation/ui";
import { useThemeStore } from "@/stores/use-theme-store";

type TurnstileApi = {
    render: (element: HTMLElement, options: Record<string, unknown>) => string;
    remove: (id: string) => void;
};
declare global { interface Window { turnstile?: TurnstileApi } }

let loading: Promise<TurnstileApi> | undefined;
function loadTurnstile(): Promise<TurnstileApi> {
    if (window.turnstile) return Promise.resolve(window.turnstile);
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.referrerPolicy = "no-referrer";
        const fail = () => { script.remove(); loading = undefined; reject(new Error("captcha-unavailable")); };
        script.onload = () => window.turnstile ? resolve(window.turnstile) : fail();
        script.onerror = fail;
        document.head.appendChild(script);
    });
    return loading;
}

export function Turnstile({ siteKey, onToken, compact = false }: { siteKey: string; onToken: (token: string) => void; compact?: boolean }) {
    const container = useRef<HTMLDivElement>(null);
    const theme = useThemeStore((state) => state.theme);
    const [attempt, setAttempt] = useState(0);
    const [status, setStatus] = useState<"loading" | "ready" | "verified" | "failed">("loading");
    const statusText = compact
        ? { loading: "正在加载验证…", ready: "请完成人机验证", verified: "人机验证已完成。", failed: "验证暂不可用，请重试。" }
        : { loading: "正在加载人机验证；如一直未出现，可关闭后重新打开账户窗口。", ready: "请完成人机验证后提交；验证不会自动提交账户表单。", verified: "人机验证已完成。", failed: "人机验证未完成、已过期或服务不可用，请点击重新验证。" };

    useEffect(() => {
        let disposed = false;
        let widget: string | undefined;
        let api: TurnstileApi | undefined;
        onToken("");
        const failed = () => {
            if (disposed) return;
            onToken("");
            setStatus("failed");
        };
        void loadTurnstile().then((loaded) => {
            if (disposed || !container.current) return;
            api = loaded;
            widget = api.render(container.current, {
                sitekey: siteKey, action: "account", theme, size: "flexible",
                retry: "never", "refresh-expired": "manual", "refresh-timeout": "manual", "response-field": false,
                callback: (token: string) => { if (!disposed) { onToken(token); setStatus("verified"); } },
                "error-callback": failed, "expired-callback": failed, "timeout-callback": failed,
                "unsupported-callback": failed,
            });
            setStatus("ready");
        }).catch(failed);
        return () => { disposed = true; if (api && widget !== undefined) api.remove(widget); };
    }, [siteKey, theme, attempt, onToken]);

    return (
        <div className="mb-4 space-y-2">
            <div ref={container} />
            <div className={compact && status === "verified" ? "sr-only" : "flex flex-wrap items-center gap-2 text-xs text-muted-foreground"} aria-live="polite">
                <span>{statusText[status]}</span>
                {compact ? status !== "verified" && <Tooltip title="重新验证"><Button size="small" type="text" aria-label="重新验证" icon={<RefreshCw className="size-3.5" />} onClick={() => setAttempt((value) => value + 1)} /></Tooltip> : <Button size="small" type="link" onClick={() => setAttempt((value) => value + 1)}>重新验证</Button>}
            </div>
        </div>
    );
}
