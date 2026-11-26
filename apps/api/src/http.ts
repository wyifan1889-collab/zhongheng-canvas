export class HttpError extends Error {
    constructor(public status: number, public code: string, message: string, public retryAfter?: number) { super(message); }
}

export function json(data: unknown, status = 200, headers?: HeadersInit) {
    const safeHeaders = new Headers(headers);
    safeHeaders.set("content-type", "application/json; charset=utf-8");
    safeHeaders.set("cache-control", "no-store");
    safeHeaders.set("x-content-type-options", "nosniff");
    safeHeaders.set("referrer-policy", "no-referrer");
    return new Response(JSON.stringify(data), { status, headers: safeHeaders });
}

/** Count actual streamed bytes, not only the client-supplied Content-Length. */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json" ||
        request.headers.has("content-encoding")) {
        throw new HttpError(415, "unsupported_media_type", "请使用未压缩的 JSON 请求");
    }
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
        throw new HttpError(413, "payload_too_large", "请求内容超过允许大小，旧画布未被覆盖");
    }
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError(400, "invalid_input", "请求内容为空");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
                void reader.cancel().catch(() => {});
                throw new HttpError(413, "payload_too_large", "请求内容超过允许大小，旧画布未被覆盖");
            }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new HttpError(400, "invalid_input", "JSON 内容无效"); }
}

/** Count streamed bytes for authenticated binary uploads. The caller validates MIME and ownership. */
export async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
    if (request.headers.has("content-encoding")) throw new HttpError(415, "unsupported_media_type", "请使用未压缩的媒体内容");
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
        throw new HttpError(413, "payload_too_large", "媒体超过当前文件大小限制，未上传");
    }
    const reader = request.body?.getReader();
    if (!reader) throw new HttpError(400, "invalid_input", "媒体内容为空");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
                void reader.cancel().catch(() => {});
                throw new HttpError(413, "payload_too_large", "媒体超过当前文件大小限制，未上传");
            }
            chunks.push(value);
        }
    } finally { reader.releaseLock(); }
    if (size <= 0) throw new HttpError(400, "invalid_input", "媒体内容为空");
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
}
