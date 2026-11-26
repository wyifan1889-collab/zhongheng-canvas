import { mkdir, open, readFile, realpath, rename, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { InspirationCatalog, InspirationWrite } from "@infinite-canvas/shared";
import { HttpError } from "./http";
import { isBlockedProviderHostname } from "./provider-gateway";

const text = z.string().refine(value => value.trim().length > 0);
const revision = z.number().int().nonnegative().refine(Number.isSafeInteger);
const imageUrl = z.string().refine(value => {
    // This namespace is served only by the operator's public static host. Never
    // resolve arbitrary local paths or turn private account objects into URLs.
    if (value.startsWith("/inspiration-assets/")) {
        return /^\/inspiration-assets\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/)*[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(value);
    }
    try {
        // Explicit authority avoids WHATWG same-scheme relative interpretation
        // (https:example.com means different URLs with/without a browser base).
        if (!/^https:\/\/[^/]/i.test(value) || value !== value.trim() || /[\s\\]/.test(value)) return false;
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password && !isBlockedProviderHostname(url.hostname) &&
            !/^\/api\/v1\/media(?:\/|$)/i.test(url.pathname);
    } catch { return false; }
});
const items = z.array(z.strictObject({
    id: text.refine(value => value === value.trim()), type: z.enum(["image", "video", "audio"]),
    title: text, prompt: text, imageUrl, tags: z.array(text),
})).refine(values => new Set(values.map(value => value.id)).size === values.length);
const catalogSchema = z.strictObject({ schemaVersion: z.literal(1), revision, items });
const writeSchema = z.strictObject({ expectedRevision: revision, items });
const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
function insideSource(root: string, path: string) {
    const fromSource = relative(root, path);
    return !fromSource || (!fromSource.startsWith(`..${sep}`) && fromSource !== ".." && !isAbsolute(fromSource));
}

async function assertOutsideSource(path: string) {
    // Resolve the nearest existing ancestor as well as an existing file. This
    // catches operator paths whose external-looking parent links into source.
    let ancestor = path;
    const missing: string[] = [];
    while (true) {
        try {
            const actual = resolve(await realpath(ancestor), ...missing);
            if (insideSource(await realpath(sourceRoot), actual)) throw new Error("灵感运行时文件不能位于源码目录");
            return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            missing.unshift(basename(ancestor));
            const parent = dirname(ancestor);
            if (parent === ancestor) throw error;
            ancestor = parent;
        }
    }
}

export function parseInspirationWrite(value: unknown): InspirationWrite {
    const parsed = writeSchema.safeParse(value);
    if (!parsed.success) throw new HttpError(400, "invalid_input", "请核对灵感条目、唯一编号、公开图片地址和当前版本");
    return parsed.data;
}

/** No implicit source-directory writes, dotenv reads, or new storage service. */
export function readInspirationFile(env: Record<string, string | undefined>): string | null {
    const file = env.SAAS_INSPIRATION_FILE;
    if (file === undefined) return null;
    const path = isAbsolute(file) ? resolve(file) : "";
    if (!path || insideSource(sourceRoot, path)) {
        throw new Error("灵感配置无效：SAAS_INSPIRATION_FILE 必须是源码目录外的绝对文件路径");
    }
    return path;
}

export type InspirationStore = ReturnType<typeof createInspirationStore>;

/** All API writers share the same durable directory; mkdir is the inter-process
 * lock. Crashes leave a fail-closed lock, never a timed lease or lost update.
 * Readers observe a complete old/new file through same-directory rename. */
export function createInspirationStore(file: string) {
    if (!isAbsolute(file)) throw new Error("灵感文件必须使用绝对路径");
    const path = resolve(file);
    async function read(): Promise<InspirationCatalog> {
        await assertOutsideSource(path);
        let contents: string;
        try { contents = await readFile(path, "utf8"); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: 0, items: [] };
            throw error;
        }
        const stored = catalogSchema.parse(JSON.parse(contents));
        return { revision: stored.revision, items: stored.items };
    }
    return {
        read,
        async write(input: InspirationWrite, commit: (publish: () => Promise<void>) => Promise<void> = publish => publish()): Promise<InspirationCatalog> {
            const parsed = parseInspirationWrite(input);
            await assertOutsideSource(path);
            await mkdir(dirname(path), { recursive: true, mode: 0o750 });
            const lock = `${path}.lock`;
            try { await mkdir(lock, { mode: 0o750 }); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, "inspiration_busy", "灵感列表正在保存，请重新读取后再试");
                throw error;
            }
            const temporary = `${path}.${crypto.randomUUID()}.tmp`;
            try {
                const current = await read();
                if (current.revision !== parsed.expectedRevision || !Number.isSafeInteger(current.revision + 1)) {
                    throw new InspirationConflict(current.revision);
                }
                const next = { revision: current.revision + 1, items: parsed.items };
                const handle = await open(temporary, "wx", 0o640);
                try {
                    await handle.writeFile(JSON.stringify({ schemaVersion: 1, ...next }, null, 2) + "\n", "utf8");
                    await handle.sync();
                } finally { await handle.close(); }
                // Administrative authorization is checked again immediately
                // around publication, after potentially slow file preparation.
                await commit(() => rename(temporary, path));
                return next;
            } finally {
                try { await rm(temporary, { force: true }); }
                finally { await rmdir(lock); }
            }
        },
    };
}

export class InspirationConflict extends HttpError {
    constructor(readonly currentRevision: number) { super(409, "inspiration_revision_conflict", "灵感列表已有新版本，请重新读取并核对后保存"); }
}
