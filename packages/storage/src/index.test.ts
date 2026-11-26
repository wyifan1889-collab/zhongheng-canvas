import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createFileObjectStorage, createMemoryObjectStorage, createStorageAdapter, objectKey } from "./index";
import { AliyunOSSAdapter } from "./adapters/aliyun-oss";

describe("object storage seam", () => {
    test("accepts opaque scoped keys and keeps provider data server-side", async () => {
        const storage = createMemoryObjectStorage();
        const key = objectKey("account/user-1/project-1/image-1");
        const bytes = new Uint8Array([1, 2, 3]);
        const saved = await storage.put({ key, body: bytes, contentType: "image/png" });

        expect(saved).toMatchObject({ key, sizeBytes: 3, contentType: "image/png" });
        expect(saved.etag).toHaveLength(64);
        bytes[0] = 99;
        const loaded = await storage.get(key);
        expect(loaded?.body).toEqual(new Uint8Array([1, 2, 3]));
        expect(loaded?.metadata.etag).toBe(saved.etag);
    });

    test("does not turn missing objects into successful empty data", async () => {
        const storage = createMemoryObjectStorage();
        expect(await storage.get(objectKey("account/user-1/missing"))).toBeNull();
    });

    test("rejects traversal, URL-like and header-breaking keys/types", () => {
        for (const value of ["", "/absolute", "https://evil", "a\\b", "a/../b", "a//b", "a/./b", "a\u0000b"]) {
            expect(() => objectKey(value)).toThrow("对象键无效");
        }
        const storage = createMemoryObjectStorage();
        const key = objectKey("account/user-1/file");
        expect(storage.put({ key, body: new Uint8Array(), contentType: "text/plain\r\nX-Leak: yes" })).rejects.toThrow("对象类型无效");
    });

    test("delete is explicit and idempotent", async () => {
        const storage = createMemoryObjectStorage();
        const key = objectKey("account/user-1/file");
        await storage.put({ key, body: new Uint8Array([7]), contentType: "application/octet-stream" });
        await storage.delete(key);
        await storage.delete(key);
        expect(await storage.get(key)).toBeNull();
    });

    test("private disk adapter stores bytes and metadata without exposing a URL", async () => {
        const root = await mkdtemp(join(tmpdir(), "infinite-canvas-storage-"));
        try {
            const storage = createFileObjectStorage(root);
            const key = objectKey("account/user-1/project-1/image-1");
            const saved = await storage.put({ key, body: new Uint8Array([4, 5]), contentType: "image/png" });
            expect(saved.sizeBytes).toBe(2);
            expect(await storage.get(key)).toMatchObject({ metadata: saved, body: new Uint8Array([4, 5]) });
            expect(await readFile(join(root, "objects/account/user-1/project-1/image-1.bin"))).toEqual(new Uint8Array([4, 5]));
            await storage.delete(key);
            expect(await storage.get(key)).toBeNull();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("factory selects the explicit provider and OSS signed links stay opt-in", () => {
        const memory = createStorageAdapter({ provider: "memory" });
        expect(memory).toBeDefined();
        const oss = new AliyunOSSAdapter({
            region: "oss-cn-shanghai",
            accessKeyId: "unit-test-id",
            accessKeySecret: "unit-test-secret",
            bucket: "infinite-canvas-dev",
        });
        const url = oss.createSignedDownloadUrl(objectKey("account/user-1/file.txt"), 3600);
        expect(url).toContain("https://");
        expect(url).toContain("infinite-canvas-dev");
        expect(() => oss.createSignedDownloadUrl(objectKey("account/user-1/file.txt"), 0)).toThrow("签名链接有效期无效");
    });
});
