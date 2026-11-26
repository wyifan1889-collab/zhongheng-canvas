import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { matchRoutes } from "react-router-dom";
import { analyticsPath, isCanvasJoinPath } from "./analytics-path";

const token = "11111111-1111-4111-8111-111111111111";
const invitationPaths = [
    `/canvas/join/${token}`, `/CANVAS/JOIN/${token}`, `/%63anvas/%6aoin/${token}`,
    `/canvas/j%6fin/${token}/`, `/canvas/join/${token.replaceAll("-", "%2d")}`,
];

test("invitation paths and their query strings never reach analytics", () => {
    expect(analyticsPath("/canvas/join/secret-token", "?from=secret")).toBe("/canvas/join");
    expect(analyticsPath("/canvas/join", "?token=secret")).toBe("/canvas/join");
    expect(analyticsPath("/generation/history", "?page=2")).toBe("/generation/history?page=2");
});

test("all invitation spellings accepted by the router are private", () => {
    for (const pathname of invitationPaths) {
        expect(matchRoutes([{ path: "/canvas/join/:token" }], pathname)?.[0].params.token).toBe(token);
        expect(isCanvasJoinPath(pathname)).toBe(true);
        expect(analyticsPath(pathname, "?source=private")).toBe("/canvas/join");
    }
    for (const pathname of [`/canvas/%256aoin/${token}`, `/canvas%2fjoin/${token}`, "/canvas/joined/example"]) {
        expect(matchRoutes([{ path: "/canvas/join/:token" }], pathname)).toBeNull();
        expect(isCanvasJoinPath(pathname)).toBe(false);
    }
});

test("the entry document applies no-referrer before loading scripts on invitation aliases", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeDefined();
    for (const pathname of [...invitationPaths, "/canvas", "/generation/history"]) {
        const policies: { name?: string; content?: string }[] = [];
        runInNewContext(script!, { location: { pathname }, document: {
            createElement: () => ({}), head: { appendChild: (element: object) => policies.push(element) },
        } });
        expect(policies).toEqual(isCanvasJoinPath(pathname) ? [{ name: "referrer", content: "no-referrer" }] : []);
    }
});
