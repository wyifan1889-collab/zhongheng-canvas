import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { TLSSocket } from "node:tls";
import { normalizeChatTtsAudioResult } from "./audio-chat-result";

/**
 * The only HTTP boundary that is allowed to send a platform provider credential
 * upstream.  This module deliberately does not expose an application route or
 * make billing decisions; the generation task layer will own those decisions.
 */

export type ProviderAdapter = "openai-compatible" | "sub2api";

export type ProviderTarget = {
    providerId: string;
    adapter: ProviderAdapter;
    endpoint: string;
    credential: string;
    providerModel?: string;
};

export type ProviderRequest = {
    target: ProviderTarget;
    path: string;
    method?: "GET" | "POST";
    body?: unknown;
    signal?: AbortSignal;
    /** Bound decoded response bytes before parsing on opted-in JSON routes. */
    maxResponseBytes?: number;
};

export type ProviderResponse = {
    status: "succeeded";
    payload: unknown;
    upstreamStatus: number;
};

export type ProviderFailure = {
    status: "failed";
    code: "provider_rejected" | "provider_invalid_response";
    /** Only set when validation proves that fetch was never attempted. */
    requestSent?: false;
};

export type ProviderUnknown = {
    status: "unknown";
    code: "provider_timeout" | "provider_unreachable" | "provider_response_unknown";
    /** Unknown means that a retry may duplicate an upstream request. */
    retryable: false;
};

export type ProviderCallResult = ProviderResponse | ProviderFailure | ProviderUnknown;

export type ProviderAudioResult = { status: "succeeded"; upstreamStatus: 200; contentType: string | null; body: Uint8Array; source?: "audio_chat_data_uri" }
    | ProviderFailure | ProviderUnknown;

/** Video observations never assert a billable failure, including an HTTP rejection. */
export type VideoJsonObservation = { status: "observed"; httpStatus: number; payload: unknown }
    | { status: "unknown"; httpStatus: number | null; reason: "configuration_invalid" | "transport_unknown" | "response_unknown" };
export type VideoContentObservation = { status: "resolved"; httpStatus: 200; contentType: "video/mp4"; body: Uint8Array }
    | { status: "unknown"; httpStatus: number | null; reason: "configuration_invalid" | "transport_unknown" | "response_unknown" };
export type VideoHttpsRequest = typeof httpsRequest;

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** DNS resolver used by the gateway. It is injectable so endpoint validation can
 * be tested without depending on the machine's resolver or network. */
export type ProviderResolver = (hostname: string) => readonly string[] | Promise<readonly string[]>;

const blockedProviderHostnames = new Set([
    "localhost", "localhost.localdomain", "ip6-localhost", "metadata", "metadata.google.internal",
    "metadata.google.com", "metadata.azure.com", "instance-data", "instance-data.ec2.internal",
]);

function ipv4Value(address: string): number | null {
    if (isIP(address) !== 4) return null;
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function ipv4InRange(value: number, start: number, end: number): boolean {
    return value >= start && value <= end;
}

function ipv6Value(address: string): bigint | null {
    if (isIP(address) !== 6) return null;
    const value = address.toLowerCase().split("%", 1)[0];
    const halves = value.split("::");
    if (halves.length > 2) return null;
    const parseWords = (part: string): number[] => {
        if (!part) return [];
        const parts = part.split(":");
        const words: number[] = [];
        for (let index = 0; index < parts.length; index += 1) {
            const partValue = parts[index];
            if (partValue.includes(".")) {
                if (index !== parts.length - 1) return [];
                const ipv4 = ipv4Value(partValue);
                if (ipv4 === null) return [];
                words.push(ipv4 >>> 16, ipv4 & 0xffff);
                continue;
            }
            if (!/^[0-9a-f]{1,4}$/.test(partValue)) return [];
            words.push(Number.parseInt(partValue, 16));
        }
        return words;
    };
    const left = parseWords(halves[0]);
    const right = parseWords(halves.length === 2 ? halves[1] : "");
    if (left.length + right.length > 8 || (halves.length === 1 && left.length !== 8)) return null;
    const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill(0), ...right] : left;
    if (words.length !== 8) return null;
    return words.reduce((result, word) => (result << 16n) | BigInt(word), 0n);
}

/** Returns true for addresses that must never be contacted as provider targets. */
export function isBlockedProviderAddress(address: string): boolean {
    const ipv4 = ipv4Value(address);
    if (ipv4 !== null) {
        return ipv4InRange(ipv4, 0x00000000, 0x00ffffff) || // unspecified/current network
            ipv4InRange(ipv4, 0x0a000000, 0x0affffff) || // RFC1918
            ipv4InRange(ipv4, 0x64400000, 0x647fffff) || // RFC6598 shared address space
            ipv4InRange(ipv4, 0x7f000000, 0x7fffffff) || // loopback
            ipv4InRange(ipv4, 0xa9fe0000, 0xa9feffff) || // link-local and metadata
            ipv4InRange(ipv4, 0xac100000, 0xac1fffff) || // RFC1918
            ipv4InRange(ipv4, 0xc0000000, 0xc00000ff) || // special-use
            ipv4InRange(ipv4, 0xc0a80000, 0xc0a8ffff) || // RFC1918
            ipv4InRange(ipv4, 0xc6120000, 0xc613ffff) || // benchmarking
            ipv4InRange(ipv4, 0xe0000000, 0xffffffff); // multicast/reserved
    }
    const ipv6 = ipv6Value(address);
    if (ipv6 === null) return true;
    const prefix = (value: bigint, bits: number): bigint => value >> BigInt(128 - bits);
    // Unspecified, loopback, IPv4-mapped addresses, unique-local, link-local,
    // multicast and the IPv6 metadata endpoint are all non-provider targets.
    if (ipv6 === 0n || ipv6 === 1n || prefix(ipv6, 7) === 0b1111110n || prefix(ipv6, 10) === 0b1111111010n || prefix(ipv6, 8) === 0xffn || ipv6 === BigInt("0xfd000ec20000000000000000000000fe")) return true;
    const mapped = ipv6 >> 32n;
    if (mapped === 0xffffn) return isBlockedProviderAddress(`${Number((ipv6 >> 24n) & 0xffn)}.${Number((ipv6 >> 16n) & 0xffn)}.${Number((ipv6 >> 8n) & 0xffn)}.${Number(ipv6 & 0xffn)}`);
    return false;
}

/** Returns true for hostnames that are locally scoped or well-known metadata names. */
export function isBlockedProviderHostname(hostname: string): boolean {
    const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!normalized || blockedProviderHostnames.has(normalized)) return true;
    if (normalized.endsWith(".localhost") || normalized.endsWith(".local") || normalized.endsWith(".localdomain") || normalized.endsWith(".internal")) return true;
    if (isIP(normalized)) return isBlockedProviderAddress(normalized);
    // Single-label names are resolved through local search domains and are not
    // safe as platform-controlled upstream targets.
    return !normalized.includes(".");
}

const defaultProviderResolver: ProviderResolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/** DNS cannot authorize a late connection after the operation's absolute signal ends. */
function videoAddresses(resolver: ProviderResolver, hostname: string, signal: AbortSignal): Promise<readonly string[]> {
    return new Promise((resolve, reject) => {
        const aborted = () => { signal.removeEventListener("abort", aborted); reject(new Error("video_dns_aborted")); };
        if (signal.aborted) return aborted();
        signal.addEventListener("abort", aborted, { once: true });
        Promise.resolve().then(() => resolver(hostname)).then(value => {
            signal.removeEventListener("abort", aborted);
            signal.aborted ? reject(new Error("video_dns_aborted")) : resolve(value);
        }, error => { signal.removeEventListener("abort", aborted); reject(error); });
    });
}

class ProviderEndpointError extends Error {
    constructor(readonly kind: "invalid" | "unreachable") { super(kind); }
}

function providerUrl(endpoint: string, path: string): string {
    const suffix = path.replace(/^\/+/, "");
    let parsed: URL;
    try { parsed = new URL(endpoint); }
    catch { throw new Error("invalid provider endpoint"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash ||
        !suffix || suffix.includes("..") || suffix.includes("\\") || !/^[A-Za-z0-9/_:.%-]+$/.test(suffix)) {
        throw new Error("invalid provider path");
    }
    // Keep the immutable binding unchanged, but append transport paths to the
    // parsed pathname so legal empty ?/# markers cannot swallow the route.
    parsed.search = "";
    parsed.hash = "";
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/${suffix}`;
    return parsed.toString();
}

async function validateProviderEndpoint(url: string, resolver: ProviderResolver): Promise<void> {
    let parsed: URL;
    try { parsed = new URL(url); }
    catch { throw new ProviderEndpointError("invalid"); }
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (isBlockedProviderHostname(hostname)) throw new ProviderEndpointError("invalid");
    if (isIP(hostname)) {
        if (isBlockedProviderAddress(hostname)) throw new ProviderEndpointError("invalid");
        return;
    }
    let addresses: readonly string[];
    try { addresses = await resolver(hostname); }
    catch { throw new ProviderEndpointError("unreachable"); }
    if (!addresses.length || addresses.some((address) => isBlockedProviderAddress(address))) throw new ProviderEndpointError("invalid");
}

function modelIds(payload: unknown): string[] | null {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    if (record.success === false || record.error != null || Array.isArray(record.data) && Array.isArray(record.models)) return null;
    const source = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : null;
    if (!source) return null;
    for (const key of ["pagination", "links"]) if (record[key] != null && (typeof record[key] !== "object" || Array.isArray(record[key]))) return null;
    const pagination = record.pagination as Record<string, unknown> ?? {};
    const links = record.links as Record<string, unknown> ?? {};
    const pagingKeys = ["has_more", "hasMore", "total", "total_count", "page", "current_page", "currentPage", "offset",
        "total_pages", "totalPages", "last_page", "lastPage", "next", "next_page", "next_cursor", "nextPage", "nextCursor", "previous", "prev", "previous_cursor"];
    if (Object.keys(pagination).some(key => !pagingKeys.includes(key)) ||
        Object.keys(links).some(key => !["next", "prev", "previous", "self"].includes(key)) || record.meta != null || record.page_info != null || record.pageInfo != null) return null;
    // An incomplete page must never turn undiscovered models into "missing" entries.
    for (const page of [record, pagination]) {
        for (const key of ["has_more", "hasMore"]) if (Object.hasOwn(page, key) && page[key] !== false) return null;
        for (const key of ["total", "total_count"]) if (Object.hasOwn(page, key) && page[key] !== source.length) return null;
        for (const key of ["page", "current_page", "currentPage"]) if (Object.hasOwn(page, key) && page[key] !== 1) return null;
        for (const key of ["total_pages", "totalPages", "last_page", "lastPage"]) if (Object.hasOwn(page, key) && page[key] !== 1 && !(source.length === 0 && page[key] === 0)) return null;
        if (Object.hasOwn(page, "offset") && page.offset !== 0) return null;
        if (page.next || page.next_page || page.next_cursor || page.nextPage || page.nextCursor || page.previous || page.prev || page.previous_cursor) return null;
    }
    if (links.next || links.prev || links.previous) return null;
    const ids: string[] = [];
    for (const item of source) {
        const id = typeof item === "string" ? item : item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>).id : null;
        if (typeof id !== "string" || !id.trim() || id.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(id)) return null;
        ids.push(id.trim());
    }
    return [...new Set(ids)];
}

function isAbort(error: unknown): boolean {
    return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

type ModelListResult =
    | { status: "succeeded"; models: string[] }
    | ProviderFailure
    | ProviderUnknown;

/** Create a gateway with an injectable fetcher so provider behavior can be tested without a network. */
export function createProviderGateway(
    fetcher: Fetcher = (...args) => globalThis.fetch(...args),
    resolver: ProviderResolver = defaultProviderResolver,
    videoRequest: VideoHttpsRequest = httpsRequest,
) {
    /** A separate transport pins the checked address into the actual TLS connection.
     * Legacy fetch paths retain their existing behavior. No proxy env, redirects,
     * connection pooling, second DNS lookup or fallback address is used here. */
    async function readVideo(input: ProviderRequest & { maxBytes: number }, content: boolean): Promise<VideoJsonObservation | VideoContentObservation> {
        let httpStatus: number | null = null;
        const unknown = (reason: "configuration_invalid" | "transport_unknown" | "response_unknown") => ({ status: "unknown" as const, httpStatus, reason });
        if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0 || !input.signal || input.signal.aborted ||
            typeof input.target.credential !== "string" || !input.target.credential || /[\r\n]/.test(input.target.credential)) return unknown("configuration_invalid");
        let url: URL, address: string;
        try {
            url = new URL(providerUrl(input.target.endpoint, input.path));
            if (!/\/v1\/?$/.test(new URL(input.target.endpoint).pathname) || input.target.adapter !== "openai-compatible" ||
                (content ? input.method !== "GET" || !/^videos\/[^/]+\/content$/.test(input.path)
                    : !((input.method ?? "POST") === "POST" && input.path === "videos" || input.method === "GET" && /^videos\/[^/]+$/.test(input.path)))) return unknown("configuration_invalid");
            const hostname = url.hostname.replace(/^\[|\]$/g, "");
            if (isBlockedProviderHostname(hostname)) return unknown("configuration_invalid");
            const addresses = isIP(hostname) ? [hostname] : await videoAddresses(resolver, hostname, input.signal);
            if (!addresses.length || addresses.some(isBlockedProviderAddress)) return unknown("configuration_invalid");
            address = addresses[0];
        } catch { return unknown("configuration_invalid"); }
        if (input.signal.aborted) return unknown("transport_unknown");
        try {
            return await new Promise<VideoJsonObservation | VideoContentObservation>((resolve) => {
                let settled = false;
                const finish = (value: VideoJsonObservation | VideoContentObservation) => { if (!settled) { settled = true; resolve(value); } };
                const options: RequestOptions = {
                    method: input.method ?? "POST", agent: false, signal: input.signal, family: isIP(address),
                    lookup: (_hostname, _options, callback) => callback(null, address, isIP(address)),
                    headers: { accept: content ? "video/mp4" : "application/json", "accept-encoding": "identity",
                        authorization: `Bearer ${input.target.credential}`, ...(input.body === undefined ? {} : { "content-type": "application/json" }) },
                };
                const request = videoRequest(url, options, (response) => {
                    httpStatus = response.statusCode ?? null;
                    void (async () => {
                        // Certificate verification remains Node's default, for the original host/SNI.
                        // Compare normalized IP values rather than trusting a DNS precheck alone.
                        const remote = response.socket.remoteAddress;
                        const equalAddress = remote && (ipv4Value(address) !== null ?
                            ipv4Value(remote.replace(/^::ffff:/i, "")) === ipv4Value(address) : ipv6Value(remote) === ipv6Value(address));
                        if (!equalAddress || (response.socket as TLSSocket).authorized !== true || httpStatus === null || httpStatus < 200 || httpStatus >= 300 || content && httpStatus !== 200) {
                            response.destroy(); finish(unknown("response_unknown")); return;
                        }
                        const encoding = response.headers["content-encoding"];
                        const rawLength = response.headers["content-length"];
                        const expected = rawLength === undefined ? null : typeof rawLength === "string" && /^\d+$/.test(rawLength) && Number.isSafeInteger(Number(rawLength)) ? Number(rawLength) : -1;
                        const mime = response.headers["content-type"];
                        if (encoding !== undefined && encoding !== "identity" || expected === -1 || expected !== null && expected > input.maxBytes ||
                            typeof mime !== "string" || (content ? mime.trim().toLowerCase() !== "video/mp4" : mime.split(";", 1)[0].trim().toLowerCase() !== "application/json")) {
                            response.destroy(); finish(unknown("response_unknown")); return;
                        }
                        const chunks: Uint8Array[] = []; let size = 0;
                        for await (const chunk of response) {
                            if (input.signal!.aborted) throw new Error("aborted");
                            size += chunk.byteLength;
                            if (size > input.maxBytes) { response.destroy(); finish(unknown("response_unknown")); return; }
                            chunks.push(new Uint8Array(chunk));
                        }
                        if (!response.complete || input.signal!.aborted || !size || expected !== null && expected !== size) { finish(unknown("response_unknown")); return; }
                        const body = new Uint8Array(size); let offset = 0;
                        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
                        if (content) finish({ status: "resolved", httpStatus: 200, contentType: "video/mp4", body });
                        else {
                            try { finish({ status: "observed", httpStatus: httpStatus!, payload: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)) }); }
                            catch { finish(unknown("response_unknown")); }
                        }
                    })().catch(() => { response.destroy(); finish(unknown("response_unknown")); });
                });
                request.once("error", () => finish(unknown("transport_unknown")));
                // Errors after headers must abort the response reader as well (signal is bound above).
                request.end(input.body === undefined ? undefined : JSON.stringify(input.body));
            });
        } catch { return unknown("transport_unknown"); }
    }
    const requestVideoJson = (input: ProviderRequest & { maxBytes: number }) => readVideo(input, false) as Promise<VideoJsonObservation>;
    const requestVideoContent = (input: ProviderRequest & { maxBytes: number }) => readVideo(input, true) as Promise<VideoContentObservation>;
    async function request(input: ProviderRequest): Promise<ProviderCallResult> {
        if (input.maxResponseBytes !== undefined) {
            if ((input.method ?? "POST") !== "POST") return { status: "failed", code: "provider_invalid_response", requestSent: false };
            const response = await readBoundedProviderResponse({ ...input, maxBytes: input.maxResponseBytes }, "application/json");
            if (response.status !== "succeeded") return response;
            const unknown = { status: "unknown", code: "provider_response_unknown", retryable: false } as const;
            if (response.contentType?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return unknown;
            try {
                return { status: "succeeded", upstreamStatus: response.upstreamStatus,
                    payload: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)) };
            } catch { return unknown; }
        }
        let url: string;
        try { url = providerUrl(input.target.endpoint, input.path); }
        catch { return { status: "failed", code: "provider_invalid_response", requestSent: false }; }
        try { await validateProviderEndpoint(url, resolver); }
        catch (error) {
            if (error instanceof ProviderEndpointError && error.kind === "unreachable") {
                return { status: "unknown", code: "provider_unreachable", retryable: false };
            }
            return { status: "failed", code: "provider_invalid_response", requestSent: false };
        }
        const headers = new Headers({
            accept: "application/json",
            authorization: `Bearer ${input.target.credential}`,
        });
        // Never follow an upstream redirect automatically: the redirect target
        // would otherwise bypass the DNS/private-range check and receive the
        // platform credential.
        const init: RequestInit = { method: input.method ?? "POST", headers, signal: input.signal, redirect: "error" };
        if (input.body !== undefined) {
            headers.set("content-type", "application/json");
            init.body = JSON.stringify(input.body);
        }
        let response: Response;
        try { response = await fetcher(url, init); }
        catch (error) {
            return { status: "unknown", code: isAbort(error) ? "provider_timeout" : "provider_unreachable", retryable: false };
        }
        // A server/proxy error or an image POST timeout/conflict does not prove paid work never ran.
        const ambiguousImage = init.method === "POST" && /(?:^|\/)images\/generations$/.test(input.path) &&
            (response.status === 408 || response.status === 409);
        if (response.status >= 500 && response.status < 600 || ambiguousImage) return { status: "unknown", code: "provider_response_unknown", retryable: false };
        if (!response.ok) return { status: "failed", code: "provider_rejected" };
        try {
            return { status: "succeeded", payload: await response.json(), upstreamStatus: response.status };
        } catch (error) {
            if (isAbort(error)) return { status: "unknown", code: "provider_timeout", retryable: false };
            return { status: "failed", code: "provider_invalid_response" };
        }
    }

    /** Bounded POST transport used by audio and native Gemini image responses. */
    async function readBoundedProviderResponse(input: ProviderRequest & { maxBytes: number }, accept: string): Promise<ProviderAudioResult> {
        if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) return { status: "failed", code: "provider_invalid_response", requestSent: false };
        let url: string;
        try { url = providerUrl(input.target.endpoint, input.path); }
        catch { return { status: "failed", code: "provider_invalid_response", requestSent: false }; }
        try { await validateProviderEndpoint(url, resolver); }
        catch (error) {
            return error instanceof ProviderEndpointError && error.kind === "unreachable"
                ? { status: "unknown", code: "provider_unreachable", retryable: false }
                : { status: "failed", code: "provider_invalid_response", requestSent: false };
        }
        let response: Response;
        try {
            response = await fetcher(url, { method: "POST", redirect: "error", signal: input.signal,
                headers: { accept, "content-type": "application/json", authorization: `Bearer ${input.target.credential}` },
                body: JSON.stringify(input.body) });
        } catch (error) {
            return { status: "unknown", code: isAbort(error) ? "provider_timeout" : "provider_unreachable", retryable: false };
        }
        if ([400, 401, 403, 404, 429].includes(response.status)) {
            await response.body?.cancel().catch(() => undefined);
            return { status: "failed", code: "provider_rejected" };
        }
        const rawLength = response.headers.get("content-length");
        const expectedLength = rawLength === null ? null : /^\d+$/.test(rawLength) && Number.isSafeInteger(Number(rawLength)) ? Number(rawLength) : -1;
        // Fetch decodes HTTP compression; Content-Length still describes compressed wire bytes.
        const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
        const compareLength = !encoding || encoding === "identity";
        if (response.status !== 200 || !response.body || expectedLength === -1 || (expectedLength !== null && expectedLength > input.maxBytes)) {
            await response.body?.cancel().catch(() => undefined);
            return { status: "unknown", code: "provider_response_unknown", retryable: false };
        }
        const reader = response.body.getReader();
        try {
            const chunks: Uint8Array[] = [];
            let length = 0;
            while (true) {
                const part = await reader.read();
                if (part.done) break;
                length += part.value.byteLength;
                if (length > input.maxBytes) {
                    await reader.cancel();
                    return { status: "unknown", code: "provider_response_unknown", retryable: false };
                }
                chunks.push(part.value);
            }
            if (compareLength && expectedLength !== null && expectedLength !== length) return { status: "unknown", code: "provider_response_unknown", retryable: false };
            const body = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
            return { status: "succeeded", upstreamStatus: 200, contentType: response.headers.get("content-type"), body };
        } catch (error) {
            await reader.cancel().catch(() => undefined);
            return { status: "unknown", code: isAbort(error) ? "provider_timeout" : "provider_response_unknown", retryable: false };
        } finally { reader.releaseLock(); }
    }

    /** Speech returns complete binary audio. */
    function requestAudio(input: ProviderRequest & { maxBytes: number }): Promise<ProviderAudioResult> {
        return readBoundedProviderResponse(input, "audio/mpeg, audio/wav");
    }

    /** Chat audio is bounded before parsing; JSON/Base64 count towards the same transport budget. */
    async function requestChatAudio(input: ProviderRequest & { maxBytes: number }): Promise<ProviderAudioResult> {
        if (!input.target.providerModel) return { status: "failed", code: "provider_invalid_response", requestSent: false };
        const result = await readBoundedProviderResponse(input, "application/json");
        if (result.status !== "succeeded") return result;
        const unknown = { status: "unknown", code: "provider_response_unknown", retryable: false } as const;
        if (result.contentType?.split(";", 1)[0].trim().toLowerCase() !== "application/json") return unknown;
        try {
            const payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.body));
            return normalizeChatTtsAudioResult(payload, input.target.providerModel, input.maxBytes);
        } catch { return unknown; }
    }

    async function listModels(target: ProviderTarget): Promise<ModelListResult> {
        let base: string;
        try { base = new URL(target.endpoint).pathname.replace(/\/+$/, ""); }
        catch { return { status: "failed", code: "provider_invalid_response", requestSent: false }; }
        const path = /\/v1$/i.test(base) ? "models" : "v1/models";
        const result = await request({ target, path, method: "GET", signal: AbortSignal.timeout(8_000) });
        if (result.status !== "succeeded") return result;
        const models = modelIds(result.payload);
        return models !== null ? { status: "succeeded", models } : { status: "failed", code: "provider_invalid_response" };
    }

    return { request, requestAudio, requestChatAudio, requestVideoJson, requestVideoContent, listModels };
}

