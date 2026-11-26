import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { sanitizeAnalyticsUrl } from "./analytics";

test("invitation tokens are removed from absolute page locations as well as route paths", () => {
    expect(sanitizeAnalyticsUrl("https://app.example/canvas/join/secret?source=secret#secret")).toBe("https://app.example/canvas/join");
    expect(sanitizeAnalyticsUrl("https://app.example/CANVAS/JOIN/secret?source=secret#secret")).toBe("https://app.example/canvas/join");
    expect(sanitizeAnalyticsUrl("https://app.example/%63anvas/%6aoin/secret?source=secret#secret")).toBe("https://app.example/canvas/join");
});

test("invitation aliases skip provider loading and active providers receive only private paths", () => {
    const source = `
        const paths = ["/canvas/join/private-token", "/CANVAS/JOIN/private-token", "/%63anvas/%6aoin/private-token"];
        const scripts = [];
        globalThis.window = { location: { pathname: paths[0], href: "https://app.example" + paths[0], origin: "https://app.example" },
            __RUNTIME_CONFIG__: { ANALYTICS_GA4_ID: "G-REVIEW", ANALYTICS_BAIDU_ID: "review" } };
        globalThis.document = { createElement: () => ({ setAttribute() {} }), head: { appendChild: (element) => scripts.push(element.src) } };
        const { initAnalytics, trackPageview } = await import(${JSON.stringify(new URL("./analytics.ts", import.meta.url).href)});
        for (const path of paths) { window.location.pathname = path; initAnalytics(); }
        const skipped = scripts.length === 0;
        window.location.pathname = "/canvas"; initAnalytics();
        for (const path of paths) {
            window.location.href = "https://app.example" + path + "?source=private#private";
            trackPageview(path + "?source=private");
        }
        console.log(JSON.stringify({ skipped, scripts: scripts.length,
            ga4: window.dataLayer.filter((entry) => entry[0] === "event").map((entry) => entry[2]), baidu: window._hmt }));
    `;
    const result = Bun.spawnSync([process.execPath, "-e", source], { cwd: fileURLToPath(new URL("../../", import.meta.url)) });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(new TextDecoder().decode(result.stdout));
    expect(data.skipped).toBe(true);
    expect(data.scripts).toBe(2);
    expect(data.ga4).toEqual(Array.from({ length: 3 }, () => ({ page_path: "/canvas/join", page_location: "https://app.example/canvas/join" })));
    expect(data.baidu).toEqual(Array.from({ length: 3 }, () => ["_trackPageview", "/canvas/join"]));
});

describe("analytics URL privacy boundary", () => {
    test("removes provider credentials and account tokens from relative routes", () => {
        expect(sanitizeAnalyticsUrl("/canvas?baseUrl=https%3A%2F%2Fprovider.example&apiKey=secret&view=grid#node-1"))
            .toBe("/canvas?view=grid#node-1");
    });

    test("keeps safe absolute URL structure while removing sensitive values", () => {
        expect(sanitizeAnalyticsUrl("https://app.example/canvas?token=one&tab=2", "https://app.example"))
            .toBe("https://app.example/canvas?tab=2");
    });

    test("does not keep credentials in the URL authority or hash", () => {
        expect(sanitizeAnalyticsUrl("https://user:secret@app.example/canvas?tab=2#access_token=one", "https://app.example"))
            .toBe("https://app.example/canvas?tab=2");
    });
});
