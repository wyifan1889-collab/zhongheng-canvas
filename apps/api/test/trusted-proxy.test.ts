import { describe, expect, test } from "bun:test";
import { resolveTrustedPeerIp, restoreTrustedHttpsOrigin } from "../src/trusted-proxy";

describe("trusted TLS reverse proxy", () => {
    test("restores https only when the explicit trust gate and exact header are present", () => {
        const request = new Request("http://agent.zh-api.com/api/v1/site", {
            headers: { "x-forwarded-proto": "https" },
        });
        expect(new URL(restoreTrustedHttpsOrigin(request, true).url).origin).toBe("https://agent.zh-api.com");
        expect(new URL(restoreTrustedHttpsOrigin(request, false).url).origin).toBe("http://agent.zh-api.com");
        expect(new URL(restoreTrustedHttpsOrigin(new Request(request, { headers: { "x-forwarded-proto": "https,http" } }), true).url).origin).toBe("http://agent.zh-api.com");
    });

    test("uses the proxy-overwritten peer header only across a trusted loopback link", () => {
        const request = new Request("http://agent.zh-api.com/api/v1/site", {
            headers: { "x-canvas-peer-ip": "203.0.113.42", "x-forwarded-for": "198.51.100.99" },
        });
        expect(resolveTrustedPeerIp(request, "127.0.0.1", true)).toBe("203.0.113.42");
        expect(resolveTrustedPeerIp(new Request(request, { headers: { "x-real-ip": "198.51.100.7" } }), "127.0.0.1", true)).toBe("198.51.100.7");
        expect(resolveTrustedPeerIp(request, "::1", true)).toBe("203.0.113.42");
        expect(resolveTrustedPeerIp(request, "192.0.2.10", true)).toBe("192.0.2.10");
        expect(resolveTrustedPeerIp(request, "127.0.0.1", false)).toBe("127.0.0.1");
    });

    test("falls back to the socket peer for missing or malformed proxy headers", () => {
        expect(resolveTrustedPeerIp(new Request("http://agent.zh-api.com"), "127.0.0.1", true)).toBe("127.0.0.1");
        expect(resolveTrustedPeerIp(new Request("http://agent.zh-api.com", { headers: { "x-canvas-peer-ip": "203.0.113.1, 203.0.113.2" } }), "127.0.0.1", true)).toBe("127.0.0.1");
        expect(resolveTrustedPeerIp(new Request("http://agent.zh-api.com", { headers: { "x-canvas-peer-ip": "not-an-ip" } }), "127.0.0.1", true)).toBe("127.0.0.1");
        expect(resolveTrustedPeerIp(new Request("http://agent.zh-api.com", { headers: { "x-canvas-peer-ip": "203.0.113.1" } }), undefined, true)).toBeUndefined();
    });
});