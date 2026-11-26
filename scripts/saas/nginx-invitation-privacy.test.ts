import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const configs = ["nginx.conf", "deploy/agent-zh-api/nginx-agent.zh-api.com.example.conf", "deploy/agent-zh-api/nginx-chat-staging.example.conf"];
const token = "11111111-1111-4111-8111-111111111111";

function block(source: string, marker: string) {
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const open = source.indexOf("{", start);
    let depth = 1, end = open + 1;
    while (depth && end < source.length) {
        if (source[end] === "{") depth++;
        if (source[end] === "}") depth--;
        end++;
    }
    expect(depth).toBe(0);
    return source.slice(open + 1, end - 1);
}

function privateLogs(source: string) {
    expect(source).toContain("access_log off;");
    expect(source).toContain("error_log /dev/null crit;");
}

test("all shipped SPA entry configs keep invitation requests in a private log context", () => {
    for (const filename of configs) {
        const source = readFileSync(new URL(`../../${filename}`, import.meta.url), "utf8");
        const servers = source.split(/^server \{/m).slice(1).map((part) => block(`server {${part}`, "server {"));
        for (const server of servers) {
            const base = block(server, "location / {");
            const privateLocation = base.match(/location ~\* ([^\s]+) \{/);
            expect(privateLocation).not.toBeNull();
            const pattern = new RegExp(privateLocation![1], "i");
            const privateBlock = block(base, privateLocation![0]);
            privateLogs(privateBlock);
            // nginx matches the once-normalized URI, unlike the original request line.
            for (const pathname of [`/canvas/join/${token}`, `/CANVAS/JOIN/${token}`, `/%63anvas/%6aoin/${token}`]) {
                expect(pattern.test(decodeURIComponent(pathname))).toBe(true);
            }
            for (const pathname of ["/canvas", "/assets", "/config.js", "/canvas/joined/example"]) expect(pattern.test(pathname)).toBe(false);
            if (server.includes("listen 80;")) {
                expect(base).toContain("return 301 https://$host$request_uri;");
                expect(privateBlock).toContain("return 301 https://$host$request_uri;");
                expect(pattern.test(`/api/v1/canvas/share/${token}/join`)).toBe(true);
            } else {
                // A direct index file keeps the private context even when index.html is missing.
                expect(privateBlock).toContain("try_files /index.html =404;");
                expect(privateBlock).not.toContain("try_files $uri");
                expect(base).toContain("try_files $uri $uri/ /index.html;");
            }
        }
    }
});

test("API invitation locations declare the same proxy handler and inherit headers and limits", () => {
    for (const filename of configs.slice(1)) {
        const source = readFileSync(new URL(`../../${filename}`, import.meta.url), "utf8");
        const api = block(source, "location /api/ {");
        const marker = api.match(/location ~\* ([^\s]+) \{/);
        expect(marker).not.toBeNull();
        const pattern = new RegExp(marker![1], "i");
        const privateBlock = block(api, marker![0]);
        privateLogs(privateBlock);
        const parentProxy = api.slice(0, api.indexOf(marker![0])).match(/proxy_pass\s+(http:\/\/127\.0\.0\.1:401[12]);/);
        expect(parentProxy).not.toBeNull();
        // Named regex children do not inherit proxy_pass or its content handler.
        expect(privateBlock.match(/proxy_pass\s+([^;]+);/)?.[1]).toBe(parentProxy![1]);
        expect(privateBlock).not.toMatch(/proxy_set_header|proxy_http_version|proxy_read_timeout|client_max_body_size|return|try_files/);
        expect(api).toContain("proxy_set_header X-Canvas-Peer-IP $remote_addr;");
        expect(api).toContain("proxy_set_header Origin $http_origin;");
        expect(api).toContain("proxy_read_timeout 60s;");
        expect(api).toMatch(/proxy_pass http:\/\/127\.0\.0\.1:401[12];/);
        for (const pathname of [`/api/v1/canvas/share/${token}/join`, `/api/v1/canvas/SHARE/${token}/join/`, `/api/v1/canvas/%73hare/${token}/join`]) {
            expect(pattern.test(decodeURIComponent(pathname))).toBe(true);
        }
        for (const pathname of ["/api/v1/session", "/api/v1/canvases", `/api/v1/canvas/${token}/share`]) expect(pattern.test(pathname)).toBe(false);
    }
});
