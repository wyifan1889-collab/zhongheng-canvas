import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { AliyunOSSAdapter } from "./adapters/aliyun-oss";

/**
 * Server-side object storage seam.
 *
 * This package deliberately does not know a provider, credentials, public URLs,
 * accounts, quotas or upload policy. A provider adapter must be selected and
 * authorized by the API before this seam can be used for user media.
 */

export type ObjectKey = string & { readonly __objectKey: unique symbol };

export type PutObjectInput = {
    key: ObjectKey;
    body: Uint8Array;
    contentType: string;
};

export type StoredObject = {
    key: ObjectKey;
    sizeBytes: number;
    contentType: string;
    etag: string;
};

export type ObjectStorage = {
    put(input: PutObjectInput): Promise<StoredObject>;
    get(key: ObjectKey): Promise<{ metadata: StoredObject; body: Uint8Array } | null>;
    delete(key: ObjectKey): Promise<void>;
};

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const CONTENT_TYPE = /^[^\r\n]+$/;

/**
 * Validate and brand a provider-independent object key.
 *
 * Keys are opaque identifiers, not URLs: leading slashes, backslashes,
 * traversal segments and control characters are rejected before an adapter
 * sees them. Ownership and authorization remain API responsibilities.
 */
export function objectKey(value: string): ObjectKey {
    if (!value || value.startsWith("/") || value.includes("\\") || value.includes(":") || CONTROL_CHARACTERS.test(value)) {
        throw new Error("对象键无效");
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
        throw new Error("对象键无效");
    }
    return value as ObjectKey;
}

function cloneBytes(body: Uint8Array): Uint8Array {
    return new Uint8Array(body);
}

export function assertPutObjectInput(input: PutObjectInput): void {
    if (!(input.body instanceof Uint8Array)) throw new Error("对象内容无效");
    if (!input.contentType || !CONTENT_TYPE.test(input.contentType)) throw new Error("对象类型无效");
}

/**
 * Test-only storage. It is intentionally in-memory and has no production
 * fallback path, so a missing provider cannot silently lose or expose media.
 */
export function createMemoryObjectStorage(): ObjectStorage {
    const objects = new Map<ObjectKey, { metadata: StoredObject; body: Uint8Array }>();
    return {
        async put(input) {
            assertPutObjectInput(input);
            const body = cloneBytes(input.body);
            const metadata: StoredObject = {
                key: input.key,
                sizeBytes: body.byteLength,
                contentType: input.contentType,
                etag: await computeObjectEtag(body),
            };
            objects.set(input.key, { metadata, body });
            return { ...metadata };
        },
        async get(key) {
            const found = objects.get(key);
            return found ? { metadata: { ...found.metadata }, body: cloneBytes(found.body) } : null;
        },
        async delete(key) {
            objects.delete(key);
        },
    };
}

export async function computeObjectEtag(body: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", body);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type StorageAdapterConfig =
    | { provider: "memory" }
    | { provider: "server-disk"; rootDirectory: string }
    | ({ provider: "aliyun-oss" } & import("./adapters/aliyun-oss").AliyunOSSConfig);

export function createStorageAdapter(config: StorageAdapterConfig): ObjectStorage {
    switch (config.provider) {
        case "memory": return createMemoryObjectStorage();
        case "server-disk": return createFileObjectStorage(config.rootDirectory);
        case "aliyun-oss": {
            // Keep provider loading explicit: memory/server-disk deployments do not need OSS code paths.
            return new AliyunOSSAdapter(config);
        }
        default: throw new Error("对象存储供应商不受支持");
    }
}

function storagePath(root: string, key: ObjectKey, suffix: string): string {
    const candidate = resolve(root, "objects", `${key}${suffix}`);
    const base = resolve(root, "objects");
    const within = relative(base, candidate);
    if (!within || within.startsWith("..") || within.includes(".." + "/") || within.includes(".." + "\\")) {
        throw new Error("对象键无效");
    }
    return candidate;
}

/**
 * Private-disk adapter for a dedicated server directory.
 *
 * It is deliberately not an HTTP file server and never constructs a public
 * URL. Metadata and bytes are written separately with temporary files and
 * renamed into place; a partial record is treated as corruption on read.
 */
export function createFileObjectStorage(rootDirectory: string): ObjectStorage {
    const root = resolve(rootDirectory);
    return {
        async put(input) {
            assertPutObjectInput(input);
            const bodyPath = storagePath(root, input.key, ".bin");
            const metadataPath = storagePath(root, input.key, ".json");
            const body = cloneBytes(input.body);
            const metadata: StoredObject = {
                key: input.key,
                sizeBytes: body.byteLength,
                contentType: input.contentType,
                etag: await computeObjectEtag(body),
            };
            await mkdir(dirname(bodyPath), { recursive: true, mode: 0o750 });
            const suffix = `.${crypto.randomUUID()}.tmp`;
            const temporaryBody = `${bodyPath}${suffix}`;
            const temporaryMetadata = `${metadataPath}${suffix}`;
            try {
                await writeFile(temporaryBody, body, { flag: "wx", mode: 0o640 });
                await writeFile(temporaryMetadata, JSON.stringify(metadata), { flag: "wx", mode: 0o640 });
                await rename(temporaryBody, bodyPath);
                await rename(temporaryMetadata, metadataPath);
            } catch (error) {
                await rm(temporaryBody, { force: true });
                await rm(temporaryMetadata, { force: true });
                throw error;
            }
            return { ...metadata };
        },
        async get(key) {
            const bodyPath = storagePath(root, key, ".bin");
            const metadataPath = storagePath(root, key, ".json");
            let metadata: StoredObject;
            try {
                metadata = JSON.parse(await readFile(metadataPath, "utf8")) as StoredObject;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
                throw new Error("对象存储记录损坏");
            }
            try {
                const body = new Uint8Array(await readFile(bodyPath));
                if (metadata.key !== key || metadata.sizeBytes !== body.byteLength) throw new Error("对象存储记录损坏");
                return { metadata: { ...metadata }, body };
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("对象存储记录损坏");
                throw error instanceof Error && error.message === "对象存储记录损坏" ? error : new Error("对象存储记录损坏");
            }
        },
        async delete(key) {
            await rm(storagePath(root, key, ".bin"), { force: true });
            await rm(storagePath(root, key, ".json"), { force: true });
        },
    };
}
