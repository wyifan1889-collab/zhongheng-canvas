// Analytics loader: disabled by default, with support for enabling multiple providers.
// Only GA4 and Baidu are supported. Both accept IDs only, and their script URLs are assembled here.
// Arbitrary script URLs and inline JavaScript are intentionally rejected to prevent configuration from executing code in visitors' browsers.
// When no IDs are configured, no scripts are injected and no external requests are sent.
// Forks and self-hosted deployments therefore have no analytics by default; the official site provides its IDs through environment variables.

import { ANALYTICS_BAIDU_ID, ANALYTICS_GA4_ID } from "@/constant/runtime-config";
import { analyticsPath, isCanvasJoinPath } from "./analytics-path";

type GtagFn = (...args: unknown[]) => void;

declare global {
    interface Window {
        dataLayer?: unknown[];
        gtag?: GtagFn;
        _hmt?: unknown[][];
    }
}

let initialized = false;
// Track enabled providers so route events are dispatched only where needed.
const active = { ga4: false, baidu: false };

const sensitiveQueryKeys = new Set([
    "apikey",
    "baseurl",
    "auth",
    "accesstoken",
    "password",
    "refreshtoken",
    "secret",
    "token",
]);

function isSensitiveQueryKey(key: string): boolean {
    return sensitiveQueryKeys.has(key.toLowerCase().replace(/[-_]/g, ""));
}

/** Remove credentials and token-like values before a URL reaches an analytics provider. */
export function sanitizeAnalyticsUrl(value: string, origin = "https://analytics.invalid"): string {
    const absolute = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
    try {
        const url = new URL(value, origin);
        if (isCanvasJoinPath(url.pathname)) {
            url.pathname = analyticsPath(url.pathname);
            url.search = "";
            url.hash = "";
        }
        url.username = "";
        url.password = "";
        for (const key of [...url.searchParams.keys()]) {
            if (isSensitiveQueryKey(key)) url.searchParams.delete(key);
        }
        if (url.hash) {
            const hashValue = url.hash.slice(1);
            const hashParams = new URLSearchParams(hashValue);
            const originalHash = hashParams.toString();
            for (const key of [...hashParams.keys()]) {
                if (isSensitiveQueryKey(key)) hashParams.delete(key);
            }
            if (hashParams.toString() !== originalHash) {
                url.hash = hashParams.toString() ? `#${hashParams}` : "";
            }
        }
        if (absolute) return url.toString();
        return `${url.pathname}${url.search ? `?${url.searchParams}` : ""}${url.hash}`;
    } catch {
        // The tracker only receives browser URLs, but fail closed if a future
        // caller supplies an unexpected value.
        return "/";
    }
}

function appendScript(src: string, attrs: Record<string, string> = {}) {
    const el = document.createElement("script");
    el.async = true;
    el.src = src;
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
    document.head.appendChild(el);
    return el;
}

function initGa4(id: string) {
    window.dataLayer = window.dataLayer || [];
    const gtag: GtagFn = (...args) => {
        window.dataLayer!.push(args);
    };
    window.gtag = gtag;
    appendScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`);
    gtag("js", new Date());
    // Disable GA4's automatic page view because SPA route reporting is handled by trackPageview.
    gtag("config", id, { send_page_view: false });
    active.ga4 = true;
}

function initBaidu(id: string) {
    window._hmt = window._hmt || [];
    appendScript(`https://hm.baidu.com/hm.js?${encodeURIComponent(id)}`);
    active.baidu = true;
}

export function initAnalytics() {
    if (initialized || typeof window === "undefined") return;
    if (isCanvasJoinPath(window.location.pathname)) return;
    initialized = true;

    // Initialize providers independently so one failure does not affect the others or the application.
    if (ANALYTICS_GA4_ID) {
        try {
            initGa4(ANALYTICS_GA4_ID);
        } catch {
            /* Ignore analytics initialization errors. */
        }
    }
    if (ANALYTICS_BAIDU_ID) {
        try {
            initBaidu(ANALYTICS_BAIDU_ID);
        } catch {
            /* Ignore analytics initialization errors. */
        }
    }
}

// Report SPA route changes to every enabled analytics provider.
export function trackPageview(path: string) {
    try {
        const safePath = sanitizeAnalyticsUrl(path);
        const safeLocation = typeof window === "undefined" ? safePath : sanitizeAnalyticsUrl(window.location.href, window.location.origin);
        if (active.ga4 && window.gtag) {
            window.gtag("event", "page_view", { page_path: safePath, page_location: safeLocation });
        }
        if (active.baidu && window._hmt) {
            window._hmt.push(["_trackPageview", safePath]);
        }
    } catch {
        /* Ignore analytics reporting errors. */
    }
}
