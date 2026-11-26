import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { InspirationWrite } from "@infinite-canvas/shared";
import { createInspirationStore, InspirationConflict, parseInspirationWrite, readInspirationFile } from "../src/inspiration-store";

const roots: string[] = [];
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "canvas-inspiration-store-"));
    roots.push(root);
    return { root, file: join(root, "items.json") };
}
afterEach(async () => {
    const tempRoot = await realpath(tmpdir());
    for (const root of roots.splice(0)) {
        const actual = resolve(await realpath(root));
        const within = relative(tempRoot, actual);
        if (!within || within.startsWith("..") || isAbsolute(within) || dirname(actual) !== tempRoot || !basename(actual).startsWith("canvas-inspiration-store-")) {
            throw new Error("Refusing to remove a directory outside this test's temporary workspace");
        }
        if ((await readdir(actual, { withFileTypes: true })).some(entry => entry.isSymbolicLink())) {
            throw new Error("Remove test junctions explicitly before recursive cleanup");
        }
        await rm(actual, { recursive: true, force: true });
    }
});

const item = {
    id: "curated-a", type: "image" as const, title: " 管理员预置图片 ",
    prompt: "保留完整提示词\n第二行", imageUrl: "https://cdn.example.com/inspiration/a.png", tags: ["自然", "蓝色"],
};
const input = (changes: Record<string, unknown> = {}) => ({ expectedRevision: 0, items: [item], ...changes });

describe("administrator inspiration JSON store", () => {
    test("a missing file is revision zero without creating any file", async () => {
        const { root, file } = await fixture();
        expect(await createInspirationStore(file).read()).toEqual({ revision: 0, items: [] });
        expect(await readdir(root)).toEqual([]);
    });

    test("write and reopen preserve every field, all types and configured order", async () => {
        const { root, file } = await fixture();
        const items = [
            { ...item, id: "audio-first", type: "audio" as const, tags: [] },
            { ...item, id: "video-second", type: "video" as const, imageUrl: "/inspiration-assets/covers/video-1.webp" },
            item,
        ];
        const saved = await createInspirationStore(file).write({ expectedRevision: 0, items });
        expect(saved).toEqual({ revision: 1, items });
        expect(await createInspirationStore(file).read()).toEqual(saved);
        expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ schemaVersion: 1, revision: 1, items });
        expect(Object.keys(JSON.parse(await readFile(file, "utf8")))).toEqual(["schemaVersion", "revision", "items"]);
        expect(await readdir(root)).toEqual(["items.json"]);
        expect(await createInspirationStore(file).write({ expectedRevision: 1, items: [] })).toEqual({ revision: 2, items: [] });
        expect(await createInspirationStore(file).read()).toEqual({ revision: 2, items: [] });
    });

    test("two independent instances cannot overwrite the same base revision", async () => {
        const { root, file } = await fixture();
        const outcomes = await Promise.allSettled([
            createInspirationStore(file).write({ expectedRevision: 0, items: [{ ...item, id: "first" }] }),
            createInspirationStore(file).write({ expectedRevision: 0, items: [{ ...item, id: "second" }] }),
        ]);
        const successes = outcomes.filter(result => result.status === "fulfilled");
        const failures = outcomes.filter(result => result.status === "rejected");
        expect(successes).toHaveLength(1);
        expect(failures).toHaveLength(1);
        expect((failures[0] as PromiseRejectedResult).reason.status).toBe(409);
        expect(["inspiration_busy", "inspiration_revision_conflict"]).toContain((failures[0] as PromiseRejectedResult).reason.code);
        expect(await createInspirationStore(file).read()).toEqual((successes[0] as PromiseFulfilledResult<unknown>).value);
        expect(await readdir(root)).toEqual(["items.json"]);
    });

    test("a held publication lock rejects a second writer, then stale revision reports the current version", async () => {
        const { root, file } = await fixture();
        let entered!: () => void;
        let release!: () => void;
        const atCommit = new Promise<void>(resolve => { entered = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const writing = createInspirationStore(file).write(input(), async publish => {
            entered();
            await gate;
            await publish();
        });
        await atCommit;
        try {
            expect(await createInspirationStore(file).read()).toEqual({ revision: 0, items: [] });
            await expect(createInspirationStore(file).write(input())).rejects.toMatchObject({ status: 409, code: "inspiration_busy" });
        } finally { release(); }
        await writing;
        try {
            await createInspirationStore(file).write(input());
            throw new Error("a stale write unexpectedly succeeded");
        } catch (error) {
            expect(error).toBeInstanceOf(InspirationConflict);
            expect(error).toMatchObject({ status: 409, code: "inspiration_revision_conflict", currentRevision: 1 });
        }
        expect(await readdir(root)).toEqual(["items.json"]);
    });

    test("malformed or unsupported stored JSON fails closed and is never overwritten", async () => {
        const { root, file } = await fixture();
        const invalid = [
            "{", "null", "[]",
            JSON.stringify({ revision: 0, items: [] }),
            JSON.stringify({ schemaVersion: 2, revision: 0, items: [] }),
            JSON.stringify({ schemaVersion: 1, revision: -1, items: [] }),
            JSON.stringify({ schemaVersion: 1, revision: 0, items: [], secret: "not-public" }),
            JSON.stringify({ schemaVersion: 1, revision: 0, items: [{ ...item, ownerId: "private-user" }] }),
        ];
        for (const contents of invalid) {
            await writeFile(file, contents);
            await expect(createInspirationStore(file).read()).rejects.toThrow();
            await expect(createInspirationStore(file).write(input())).rejects.toThrow();
            expect(await readFile(file, "utf8")).toBe(contents);
            expect(await readdir(root)).toEqual(["items.json"]);
        }
    });

    test("bad input is rejected before filesystem writes, without adding new count or text limits", async () => {
        const { root, file } = await fixture();
        const invalid = [
            input({ expectedRevision: -1 }), input({ expectedRevision: 0.5 }), input({ expectedRevision: Number.MAX_SAFE_INTEGER + 1 }),
            input({ revision: 0 }), input({ items: [item, item] }),
            ...[
                { id: " " }, { id: " spaced " }, { type: "text" }, { title: " " }, { prompt: "\n" },
                { tags: [""] }, { tags: "tag" }, { ownerId: "private-user" },
            ].map(changes => input({ items: [{ ...item, ...changes }] })),
        ];
        for (const value of invalid) {
            expect(() => parseInspirationWrite(value)).toThrow();
            await expect(createInspirationStore(file).write(value as InspirationWrite)).rejects.toMatchObject({ status: 400, code: "invalid_input" });
            expect(await readdir(root)).toEqual([]);
        }
        const longPrompt = "完整提示词".repeat(10_000);
        expect(parseInspirationWrite(input({ items: [{ ...item, prompt: longPrompt }] })).items[0].prompt).toBe(longPrompt);
    });

    test("URL validation accepts public HTTPS or the controlled static namespace and rejects private or executable references", () => {
        for (const imageUrl of [
            "https://cdn.example.com/a.png?version=2#preview", "/inspiration-assets/a.png", "/inspiration-assets/collection-a/cover_2.webp",
        ]) {
            expect(parseInspirationWrite(input({ items: [{ ...item, imageUrl }] })).items[0].imageUrl).toBe(imageUrl);
        }
        for (const imageUrl of [
            "http://cdn.example.com/a.png", "javascript:alert(1)", "data:image/png;base64,AA==", "file:///tmp/private.png",
            "https:cdn.example.com/a.png", "https:/cdn.example.com/a.png", "https:///cdn.example.com/a.png",
            "//cdn.example.com/a.png", "https://user:password@cdn.example.com/a.png", "https://localhost/a.png",
            "https://127.0.0.1/a.png", "https://10.0.0.1/a.png", "https://169.254.169.254/a.png", "https://[::1]/a.png",
            "https://[::ffff:127.0.0.1]/a.png", "https://service.internal/a.png", "https://storage.local/a.png",
            "https://example.com/api/v1/media/private-id", "/api/v1/media/private-id", "/inspiration-assets/../private.png",
            "/inspiration-assets/%2e%2e/private.png", "/inspiration-assets/a.png?private=1", "/inspiration-assets/a\\b.png",
            " https://cdn.example.com/a.png", "https://cdn.example.com/a b.png",
        ]) {
            expect(() => parseInspirationWrite(input({ items: [{ ...item, imageUrl }] }))).toThrow();
        }
    });

    test("authorization callback failure leaves the prior JSON intact and removes temporary file and lock", async () => {
        const { root, file } = await fixture();
        const store = createInspirationStore(file);
        await store.write(input());
        const before = await readFile(file, "utf8");
        await expect(store.write({ expectedRevision: 1, items: [] }, async () => {
            throw new Error("administrator session no longer valid");
        })).rejects.toThrow("administrator session no longer valid");
        expect(await readFile(file, "utf8")).toBe(before);
        expect(await readdir(root)).toEqual(["items.json"]);
        expect(await store.write({ expectedRevision: 1, items: [] })).toEqual({ revision: 2, items: [] });
    });

    test("runtime path configuration is optional but explicit paths must be absolute and outside the source tree", async () => {
        const { file } = await fixture();
        expect(readInspirationFile({})).toBeNull();
        expect(readInspirationFile({ SAAS_INSPIRATION_FILE: file })).toBe(resolve(file));
        for (const value of ["", "items.json", "./data/items.json", fileURLToPath(new URL("../../../", import.meta.url)), fileURLToPath(new URL("../items.json", import.meta.url))]) {
            expect(() => readInspirationFile({ SAAS_INSPIRATION_FILE: value })).toThrow("源码目录外的绝对文件路径");
        }
        expect(() => createInspirationStore("relative/items.json")).toThrow("绝对路径");
    });

    test("an external junction into the source tree cannot read or create a runtime catalog", async () => {
        const { root } = await fixture();
        const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
        const alias = join(root, "source-alias");
        const unique = `.inspiration-no-write-${crypto.randomUUID()}`;
        const sourceProbe = join(sourceRoot, unique);
        await expect(lstat(sourceProbe)).rejects.toMatchObject({ code: "ENOENT" });
        await symlink(sourceRoot, alias, "junction");
        try {
            const file = join(alias, unique, "items.json");
            expect(readInspirationFile({ SAAS_INSPIRATION_FILE: file })).toBe(resolve(file));
            const store = createInspirationStore(file);
            await expect(store.read()).rejects.toThrow("不能位于源码目录");
            await expect(store.write(input())).rejects.toThrow("不能位于源码目录");
            await expect(lstat(sourceProbe)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
            await unlink(alias);
        }
        expect(await readdir(root)).toEqual([]);
    });
});
