import OSS from "ali-oss";
import type { ObjectKey, ObjectStorage, PutObjectInput, StoredObject } from "../index";
import { assertPutObjectInput, computeObjectEtag } from "../index";

export type AliyunOSSConfig = {
    region: string;
    accessKeyId: string;
    accessKeySecret: string;
    bucket: string;
    endpoint?: string;
};

function missingObject(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const value = error as { code?: unknown; status?: unknown; statusCode?: unknown };
    return value.code === "NoSuchKey" || value.code === "NoSuchObject" || value.status === 404 || value.statusCode === 404;
}

function contentBytes(content: unknown): Uint8Array {
    if (content instanceof Uint8Array) return new Uint8Array(content);
    if (typeof Buffer !== "undefined" && Buffer.isBuffer(content)) return new Uint8Array(content);
    throw new Error("对象内容无效");
}

/**
 * Private-bucket OSS adapter. It does not expose credentials, bucket URLs or
 * signed URLs through the ObjectStorage contract; URL generation stays an
 * explicit server-only operation on this class.
 */
export class AliyunOSSAdapter implements ObjectStorage {
    private readonly client: OSS;

    constructor(config: AliyunOSSConfig) {
        this.client = new OSS({
            region: config.region,
            accessKeyId: config.accessKeyId,
            accessKeySecret: config.accessKeySecret,
            bucket: config.bucket,
            secure: true,
            ...(config.endpoint ? { endpoint: config.endpoint } : {}),
        });
    }

    async put(input: PutObjectInput): Promise<StoredObject> {
        assertPutObjectInput(input);
        const body = new Uint8Array(input.body);
        await this.client.put(input.key, Buffer.from(body), { mime: input.contentType });
        return {
            key: input.key,
            sizeBytes: body.byteLength,
            contentType: input.contentType,
            etag: await computeObjectEtag(body),
        };
    }

    async get(key: ObjectKey): Promise<{ metadata: StoredObject; body: Uint8Array } | null> {
        try {
            const result = await this.client.get(key);
            const body = contentBytes(result.content);
            const headers = result.res?.headers ?? {};
            const contentType = String(headers["content-type"] ?? "application/octet-stream");
            return {
                metadata: {
                    key,
                    sizeBytes: body.byteLength,
                    contentType,
                    etag: await computeObjectEtag(body),
                },
                body,
            };
        } catch (error) {
            if (missingObject(error)) return null;
            throw error;
        }
    }

    async delete(key: ObjectKey): Promise<void> {
        await this.client.delete(key);
    }

    /** Generate a time-limited private download URL; never persist or expose it as a public URL. */
    createSignedDownloadUrl(key: ObjectKey, expiresSeconds: number): string {
        if (!Number.isSafeInteger(expiresSeconds) || expiresSeconds <= 0) throw new Error("签名链接有效期无效");
        return this.client.signatureUrl(key, { expires: expiresSeconds });
    }
}
