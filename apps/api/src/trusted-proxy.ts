import { isIP } from "node:net";

/**
 * Bun builds request.url from the local HTTP connection. When TLS terminates at
 * a loopback reverse proxy, the original https scheme therefore has to be
 * restored before origin checks run. This helper only trusts the header when
 * the operator explicitly enables SAAS_TRUSTED_PROXY and the proxy sends the
 * exact single value `https`.
 */
export function restoreTrustedHttpsOrigin(request: Request, trustedProxy: boolean): Request {
    if (!trustedProxy || request.headers.get("x-forwarded-proto")?.trim() !== "https") return request;
    const url = new URL(request.url);
    if (url.protocol === "https:") return request;
    url.protocol = "https:";
    return new Request(url, request);
}

function isLoopbackAddress(address: string): boolean {
    if (address === "::1") return true;
    // Bun may expose an IPv4 peer as an IPv4-mapped IPv6 address.
    if (address.startsWith("::ffff:")) return isLoopbackAddress(address.slice("::ffff:".length));
    const parts = address.split(".");
    return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

/**
 * Resolve the end-user address only across the explicitly trusted local proxy
 * boundary. The proxy must overwrite x-canvas-peer-ip (or the existing x-real-ip compatibility header) from its own `$remote_addr`; arbitrary forwarded headers are never accepted from a direct caller or from a non-loopback socket.
 */
export function resolveTrustedPeerIp(request: Request, socketIp: string | undefined, trustedProxy: boolean): string | undefined {
    if (!socketIp || !isIP(socketIp)) return undefined;
    if (!trustedProxy || !isLoopbackAddress(socketIp)) return socketIp;
    for (const name of ["x-canvas-peer-ip", "x-real-ip"]) {
        const forwarded = request.headers.get(name)?.trim();
        if (forwarded && isIP(forwarded)) return forwarded;
    }
    return socketIp;
}