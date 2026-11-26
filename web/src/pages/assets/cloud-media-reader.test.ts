import { expect, test } from "bun:test";
import { CloudMediaError, type CloudMedia, type CloudMediaPage, type CloudMediaQuota } from "@/services/api/media";
import { createCloudAssetReader, type CloudAssetState } from "./cloud-media-reader";

const quota: CloudMediaQuota = { quotaBytes: 100, usedBytes: 3, availableBytes: 97 };
const blob = new Blob(["png"], { type: "image/png" });
const item = (id = "one"): CloudMedia => ({ id, kind: "image", contentType: "image/png", sizeBytes: 3, createdAt: "2026-10-29T00:00:00Z", url: `/api/v1/media/${id}` });
const page = (items = [item()]): CloudMediaPage => ({ items, quota });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
function fixture() {
    const owner = { accountId: "asset-owner", epoch: 3 }, current = { scope: { ...owner } as typeof owner | null, enabled: true };
    const states: CloudAssetState[] = [], created: string[] = [], revoked: string[] = [];
    const calls = { list: 0, download: [] as string[], upload: 0, remove: [] as string[] };
    const hooks = {
        list: async (): Promise<CloudMediaPage> => page(), download: async (_id: string): Promise<Blob> => blob,
        upload: async (_file: Blob) => ({ media: item("uploaded"), quota }), remove: async (_id: string) => quota,
        create: (_blob: Blob) => `blob:asset-${created.length + 1}`,
    };
    const reader = createCloudAssetReader({
        client: { list: () => { calls.list++; return hooks.list(); }, download: (id) => { calls.download.push(id); return hooks.download(id); },
            upload: (file) => { calls.upload++; return hooks.upload(file); }, remove: (id) => { calls.remove.push(id); return hooks.remove(id); } },
        isCurrent: () => current.enabled && current.scope?.accountId === owner.accountId && current.scope.epoch === owner.epoch,
        onState: state => states.push(state), loadFailed: "读取失败",
        createObjectURL: value => { const url = hooks.create(value); created.push(url); return url; }, revokeObjectURL: url => revoked.push(url),
    });
    return { reader, hooks, calls, states, created, revoked, current };
}

test("list failure remains an error until manual retry succeeds, without an empty-success or automatic retry", async () => {
    const f = fixture(); f.hooks.list = async () => { throw new Error("private-transport"); };
    await f.reader.read();
    expect(f.reader.snapshot()).toMatchObject({ items: [], loading: false, error: "读取失败" });
    await settle(); expect(f.calls.list).toBe(1);
    const wait = deferred<CloudMediaPage>(); f.hooks.list = () => wait.promise;
    const retry = f.reader.read(); await f.reader.read(); await f.reader.read();
    expect(f.calls.list).toBe(2); expect(f.reader.snapshot()).toMatchObject({ loading: true, error: "读取失败" });
    wait.resolve(page()); await retry; await settle();
    expect(f.reader.snapshot().error).toBeNull(); expect(f.reader.snapshot().items).toEqual([item()]); f.reader.dispose();
});

test("same-scope refresh failure retains usable rows and safe API failure text", async () => {
    const f = fixture(); await f.reader.read(); await settle();
    f.hooks.list = async () => { throw new CloudMediaError("rate_limited", "请稍后手动重试。", 429); };
    await f.reader.read();
    expect(f.reader.snapshot().error).toBe("请稍后手动重试。"); expect(f.reader.snapshot().items).toEqual([item()]);
    expect(f.reader.snapshot().previews.one.status).toBe("ready"); expect(f.calls.list).toBe(2); f.reader.dispose();
});

test("a failed card settles independently while another download is pending and supports one manual retry", async () => {
    const f = fixture(), slow = deferred<Blob>();
    f.hooks.list = async () => page([item("one"), item("two")]);
    f.hooks.download = id => id === "one" ? Promise.reject(new Error("one failed")) : slow.promise;
    await f.reader.read(); await settle();
    expect(f.reader.snapshot().previews.one.status).toBe("error"); expect(f.reader.snapshot().previews.two.status).toBe("loading");
    const retry = deferred<Blob>(); f.hooks.download = () => retry.promise;
    const pending = f.reader.preview("one"); await f.reader.preview("one");
    expect(f.calls.download).toEqual(["one", "two", "one"]);
    retry.resolve(blob); await pending; slow.resolve(blob); await settle();
    expect(f.reader.snapshot().previews.one.status).toBe("ready"); expect(f.reader.snapshot().previews.two.status).toBe("ready");
    await f.reader.preview("one"); expect(f.calls.download).toHaveLength(3); f.reader.dispose();
});

test("media decode failure revokes only that card and manual retry restores its URL", async () => {
    const f = fixture(); await f.reader.read(); await settle();
    f.reader.previewFailed("one"); f.reader.previewFailed("one");
    expect(f.revoked).toEqual(["blob:asset-1"]); expect(f.reader.snapshot().previews.one.status).toBe("error");
    await f.reader.preview("one"); expect(f.reader.snapshot().previews.one.url).toBe("blob:asset-2");
    f.reader.dispose(); expect(f.revoked).toEqual(["blob:asset-1", "blob:asset-2"]);
});

for (const mutation of ["upload", "remove"] as const) test(`${mutation} replaces the list, revokes old URLs and rejects delayed preview success`, async () => {
    const f = fixture(), old = deferred<Blob>(); let reads = 0;
    f.hooks.list = async () => page([item("one"), item("two")]);
    f.hooks.download = id => id === "two" && ++reads === 1 ? old.promise : Promise.resolve(blob);
    await f.reader.read(); await settle();
    expect(f.reader.snapshot().previews.one.status).toBe("ready");
    if (mutation === "upload") await f.reader.upload(blob); else await f.reader.remove("two");
    await settle(); const created = f.created.length;
    old.resolve(blob); await settle();
    expect(f.created).toHaveLength(created); expect(f.revoked).toContain("blob:asset-1");
    expect(f.reader.snapshot().items.map(row => row.id)).toEqual(mutation === "upload" ? ["uploaded", "one", "two"] : ["one"]);
    f.reader.dispose(); expect(new Set(f.revoked).size).toBe(f.created.length);
});

test("mutations and manual list reads are synchronously guarded against duplicate or overlapping requests", async () => {
    const f = fixture(), upload = deferred<{ media: CloudMedia; quota: CloudMediaQuota }>(); await f.reader.read();
    f.hooks.upload = () => upload.promise;
    const pending = f.reader.upload(blob);
    await f.reader.upload(blob); await f.reader.remove("one"); await f.reader.read();
    expect(f.calls.upload).toBe(1); expect(f.calls.remove).toEqual([]); expect(f.calls.list).toBe(1);
    upload.resolve({ media: item("uploaded"), quota }); await pending; await settle();
    const removing = deferred<CloudMediaQuota>(); f.hooks.remove = () => removing.promise;
    const second = f.reader.remove("one"); await f.reader.remove("one"); await f.reader.upload(blob); await f.reader.read();
    expect(f.calls.remove).toEqual(["one"]); expect(f.calls.upload).toBe(1); expect(f.calls.list).toBe(1);
    removing.resolve(quota); await second; f.reader.dispose();
});

test("failed writes retain previews and permit explicit later recovery without retrying writes", async () => {
    const f = fixture(); await f.reader.read(); await settle();
    f.hooks.upload = async () => { throw new Error("upload failed"); };
    await expect(f.reader.upload(blob)).rejects.toThrow("upload failed");
    expect(f.reader.snapshot().uploading).toBe(false); expect(f.reader.snapshot().previews.one.status).toBe("ready");
    f.hooks.remove = async () => { throw new Error("remove failed"); };
    await expect(f.reader.remove("one")).rejects.toThrow("remove failed");
    expect(f.calls.upload).toBe(1); expect(f.calls.remove).toEqual(["one"]); expect(f.revoked).toEqual([]);
    f.hooks.remove = async () => quota; await f.reader.remove("one"); expect(f.reader.snapshot().items).toEqual([]); f.reader.dispose();
});

test("a retry list snapshot cannot resurrect a card deleted after upload or roll its quota back", async () => {
    const f = fixture(); f.hooks.list = async () => { throw new Error("initial list failed"); };
    await f.reader.read(); await f.reader.upload(blob); await settle();
    expect(f.reader.snapshot().items).toEqual([item("uploaded")]);
    const wait = deferred<CloudMediaPage>(); f.hooks.list = () => wait.promise;
    const retry = f.reader.read(), deletedQuota = { quotaBytes: 100, usedBytes: 0, availableBytes: 100 };
    f.hooks.remove = async () => deletedQuota;
    expect(await f.reader.remove("uploaded")).toBe(true);
    expect(f.calls.remove).toEqual(["uploaded"]); expect(f.reader.snapshot().items).toEqual([]);
    const count = f.states.length;
    wait.resolve(page([item("uploaded")])); await retry;
    expect(f.states).toHaveLength(count); expect(f.reader.snapshot().items).toEqual([]);
    expect(f.reader.snapshot().quota).toEqual(deletedQuota); expect(f.reader.snapshot().loading).toBe(false); f.reader.dispose();
});

for (const change of ["account", "epoch", "logout", "closed"] as const) for (const failed of [false, true]) test(`late list ${failed ? "failure" : "success"} cannot publish after ${change}`, async () => {
    const f = fixture(), wait = deferred<CloudMediaPage>(); f.hooks.list = () => wait.promise;
    const request = f.reader.read();
    if (change === "closed") f.current.enabled = false;
    else f.current.scope = change === "logout" ? null : { accountId: change === "account" ? "other" : "asset-owner", epoch: change === "epoch" ? 4 : 3 };
    const count = f.states.length;
    if (failed) wait.reject(new Error("late")); else wait.resolve(page());
    await request; expect(f.states).toHaveLength(count); expect(f.reader.snapshot().items).toEqual([]); expect(f.created).toEqual([]); f.reader.dispose();
});

for (const mutation of ["upload", "remove"] as const) test(`late ${mutation} cannot restore assets after cloud closes and a fresh reader is created`, async () => {
    const f = fixture(); await f.reader.read(); await settle();
    const wait = deferred<{ media: CloudMedia; quota: CloudMediaQuota }>(), remove = deferred<CloudMediaQuota>();
    f.hooks.upload = () => wait.promise; f.hooks.remove = () => remove.promise;
    const request = mutation === "upload" ? f.reader.upload(blob) : f.reader.remove("one");
    f.current.enabled = false; f.reader.dispose(); const count = f.states.length;
    f.current.enabled = true; const fresh = fixture(); await fresh.reader.read(); await settle();
    wait.resolve({ media: item("late"), quota }); remove.resolve(quota); expect(await request).toBe(false);
    expect(f.states).toHaveLength(count); expect(f.reader.snapshot().items).toEqual([]); expect(fresh.reader.snapshot().items).toEqual([item()]);
    expect(new Set(f.revoked).size).toBe(f.created.length); fresh.reader.dispose();
});

test("scope change during URL allocation revokes the new URL before any publication", async () => {
    const f = fixture(); f.hooks.create = () => { f.current.scope = null; return "blob:changed-during-create"; };
    await f.reader.read(); await settle();
    expect(f.revoked).toEqual(["blob:changed-during-create"]); expect(f.states.some(state => state.previews.one?.status === "ready")).toBe(false); f.reader.dispose();
});

test("a pending card cannot publish late success or failure after an account or epoch change", async () => {
    for (const failed of [false, true]) {
        const f = fixture(), wait = deferred<Blob>(); f.hooks.download = () => wait.promise;
        await f.reader.read(); const count = f.states.length;
        f.current.scope = { accountId: failed ? "other" : "asset-owner", epoch: failed ? 3 : 4 };
        if (failed) wait.reject(new Error("old card error")); else wait.resolve(blob);
        await settle(); expect(f.states).toHaveLength(count); expect(f.created).toEqual([]); f.reader.dispose();
    }
});

test("dispose revokes every ready URL and refuses late downloads, errors and new operations", async () => {
    const f = fixture(), wait = deferred<Blob>(); f.hooks.list = async () => page([item("one"), item("two")]);
    f.hooks.download = id => id === "one" ? Promise.resolve(blob) : wait.promise;
    await f.reader.read(); await settle(); f.reader.dispose(); const count = f.states.length;
    wait.reject(new Error("late failure")); await settle();
    await f.reader.read(); await f.reader.preview("one"); await f.reader.upload(blob); await f.reader.remove("one");
    expect(f.states).toHaveLength(count); expect(f.calls.list).toBe(1); expect(f.calls.upload).toBe(0); expect(f.calls.remove).toEqual([]); expect(f.revoked).toEqual(f.created);
});
