// Fresh subprocess only: real localforage/fake-indexeddb partitions and Blob URLs.
// Delay storage result delivery; mock browser decoding and unrelated app stores.
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { mock } from "bun:test";
import { getAccountLocalScope, setAccountLocalAccount } from "../src/services/saas/account-local-scope";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((finish) => { resolve = finish; });
    return { promise, resolve };
}
let thumbnail: (blob: Blob) => Promise<Blob | undefined> = async () => undefined;
mock.module("../src/stores/use-config-store", () => ({ withLocalProxy: (url: string) => url, clearLocalApiCredentials() {} }));
mock.module("../src/i18n", () => ({ default: { t: (key: string) => key } }));
mock.module("../src/lib/image-thumbnail", () => ({ createImageThumbnail: (blob: Blob) => thumbnail(blob) }));
mock.module("../src/services/saas/account-session-sync", () => ({ createAccountSessionSync: () => ({
    subscribeVisible: () => () => {}, subscribeInvalidated: () => () => {}, publishInvalidated() {}, close() {},
}) }));
Object.defineProperty(globalThis, "window", { value: { setTimeout, clearTimeout }, configurable: true });
Object.defineProperty(globalThis, "Image", { value: class {
    naturalWidth = 64; naturalHeight = 48;
    onload: (() => void) | null = null; onerror: (() => void) | null = null;
    set src(_value: string) { queueMicrotask(() => this.onload?.()); }
}, configurable: true });
const { default: localforage } = await import("localforage");
const originalCreate = localforage.createInstance.bind(localforage);
const partition = (base: string, owner: string | null) => `${base}_${owner ? `account_${owner}` : "anonymous"}`;
const disk = (base: string, owner: string | null) => originalCreate({ name: "infinite-canvas", storeName: partition(base, owner) });
const calls: Array<{ store: string; method: string; key?: string }> = [];
type Gate = { store: string; method: string; key?: string; started: ReturnType<typeof deferred<void>>; release: ReturnType<typeof deferred<void>>; capturedKey?: string; used: boolean };
let gate: Gate | null = null;
function hold(base: string, owner: string | null, method: string, key?: string) {
    gate = { store: partition(base, owner), method, key, started: deferred<void>(), release: deferred<void>(), used: false };
    return gate;
}
localforage.createInstance = ((options: LocalForageOptions) => {
    const instance = originalCreate(options);
    return new Proxy(instance, { get(target, property) {
        const value = Reflect.get(target, property);
        if (typeof value !== "function") return value;
        if (!["getItem", "setItem", "removeItem", "iterate"].includes(String(property))) return value.bind(target);
        return async (...args: unknown[]) => {
            const method = String(property), key = typeof args[0] === "string" ? args[0] : undefined;
            calls.push({ store: options.storeName!, method, key });
            const result = await value.apply(target, args);
            const current = gate;
            if (current && !current.used && current.store === options.storeName && current.method === method && (!current.key || current.key === key)) {
                current.used = true; current.capturedKey = key; current.started.resolve(); await current.release.promise;
            }
            return result;
        };
    } });
}) as typeof localforage.createInstance;
const image = await import("../src/services/image-storage");
const media = await import("../src/services/file-storage");
const mode = process.argv[2], isImage = mode.startsWith("image-");
const base = isImage ? "image_files" : "media_files", key = isImage ? "image:shared-key" : "file:shared-key";
const blob = (value: string) => new Blob([value], { type: "image/png" });
const text = async (url: string) => (await fetch(url)).text();
const outcome = <T>(promise: Promise<T>) => promise.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
const resolveUrl = isImage ? image.resolveImageUrl : media.resolveMediaUrl;

if (mode.endsWith("-read") && !mode.startsWith("preview") || mode.endsWith("anonymous-aba")) {
    const anonymous = mode.endsWith("anonymous-aba"), owner = anonymous ? null : "A";
    await disk(base, owner).setItem(key, blob("account A"));
    await disk(base, "B").setItem(key, blob("account B"));
    setAccountLocalAccount(owner);
    const paused = hold(base, owner, "getItem", key);
    const pending = outcome(resolveUrl(key));
    await paused.started.promise;
    if (anonymous) {
        setAccountLocalAccount("A"); setAccountLocalAccount(null);
        await disk(base, null).setItem(key, blob("account B"));
    } else setAccountLocalAccount("B");
    paused.release.resolve();
    const late = await pending;
    assert.equal(await text(await resolveUrl(key)), "account B", "late A read must not poison the current URL cache");
    assert.ok(late.error, "old lifetime must reject, including anonymous ABA");
} else if (mode === "image-write" || mode === "media-write") {
    await disk(base, "B").setItem(key, blob("account B"));
    await disk("image_previews", "B").setItem(key, { version: 1, blob: blob("B preview") });
    setAccountLocalAccount("A");
    const paused = hold(base, "A", "setItem", key);
    const pending = outcome(isImage ? image.setImageBlob(key, blob("account A")) : media.setMediaBlob(key, blob("account A")));
    await paused.started.promise;
    setAccountLocalAccount("B");
    const current = await resolveUrl(key);
    paused.release.resolve();
    assert.ok((await pending).error);
    assert.equal(await resolveUrl(key), current);
    assert.equal(await text(current), "account B");
    assert.equal(await (await disk(base, "B").getItem<Blob>(key))!.text(), "account B");
    assert.equal(await (await disk("image_previews", "B").getItem<{ blob: Blob }>(key))!.blob.text(), "B preview");
} else if (mode.endsWith("upload-cleanup")) {
    setAccountLocalAccount("A");
    const paused = hold(base, "A", "setItem");
    const pending = outcome(isImage ? image.uploadImage(blob("new A")) : media.uploadMediaFile(blob("new A")));
    await paused.started.promise;
    const createdKey = paused.capturedKey!;
    setAccountLocalAccount("B");
    await disk(base, "B").setItem(createdKey, blob("B must survive"));
    paused.release.resolve();
    assert.ok((await pending).error);
    assert.equal(await disk(base, "A").getItem(createdKey), null, "failed upload cleanup stays in A");
    assert.equal(await (await disk(base, "B").getItem<Blob>(createdKey))!.text(), "B must survive");
} else if (mode === "preview-read") {
    const previewKey = "image:preview";
    for (const owner of ["A", "B"]) await disk("image_previews", owner).setItem(previewKey, { version: 1, blob: blob(owner) });
    setAccountLocalAccount("A");
    const paused = hold("image_previews", "A", "getItem", previewKey);
    const pending = image.ensureImagePreview(previewKey);
    await paused.started.promise;
    setAccountLocalAccount("B");
    const current = await image.ensureImagePreview(previewKey), revision = image.getImagePreviewRevision();
    paused.release.resolve();
    assert.equal(await pending, undefined);
    assert.equal(image.previewUrlFor(previewKey), current);
    assert.equal(image.getImagePreviewRevision(), revision);
    assert.equal(await text(current!), "B");
} else if (mode === "preview-queue" || mode === "preview-write") {
    const first = "image:first", second = "image:second", fence = "image:fence";
    const started = deferred<void>(), release = deferred<void>(), done = deferred<void>();
    thumbnail = async (value) => {
        const source = await value.text();
        if (source === first && mode === "preview-queue") { started.resolve(); await release.promise; }
        if (source === fence) done.resolve();
        return blob(`preview ${source}`);
    };
    for (const name of [first, second]) await disk("image_files", "A").setItem(name, blob(name));
    await disk("image_files", "B").setItem(fence, blob(fence));
    setAccountLocalAccount("A");
    const paused = mode === "preview-write" ? hold("image_previews", "A", "setItem", first) : null;
    await image.ensureImagePreview(first);
    await (paused ? paused.started.promise : started.promise);
    await image.ensureImagePreview(second);
    setAccountLocalAccount("B");
    if (paused) paused.release.resolve(); else release.resolve();
    await image.ensureImagePreview(fence); // FIFO fence completes after both old queued jobs.
    await done.promise;
    assert.equal(await disk("image_previews", "B").getItem(first), null);
    assert.equal(await disk("image_previews", "B").getItem(second), null);
    assert.equal(image.previewUrlFor(first), undefined);
    assert.equal(image.previewUrlFor(second), undefined);
    assert.equal(calls.filter((call) => call.method === "getItem" && call.key === second && call.store.endsWith("_account_B")).length, 0);
    assert.equal(calls.filter((call) => call.method === "getItem" && call.key === second && call.store === "image_files_account_A").length, 0, "old queued job must stop before its read");
} else if (mode.endsWith("cleanup")) {
    for (const owner of ["A", "B"]) await disk(base, owner).setItem(key, blob(owner));
    setAccountLocalAccount("A");
    const paused = hold(base, "A", "iterate");
    const pending = outcome(isImage ? image.cleanupUnusedImages({}) : media.cleanupUnusedMedia({}));
    await paused.started.promise;
    setAccountLocalAccount("B");
    paused.release.resolve();
    assert.ok((await pending).error);
    assert.equal(await (await disk(base, "A").getItem<Blob>(key))!.text(), "A");
    assert.equal(await (await disk(base, "B").getItem<Blob>(key))!.text(), "B");
} else if (mode === "same-account") {
    const { createAccountStore } = await import("../src/stores/use-account-store");
    let principal = { id: "A", email: "a@example.test", name: "A", role: "user" as "user" | "admin" };
    let site = { registration: false, cloudCanvas: true, cloudMedia: true, captcha: { siteKey: "synthetic", action: "account" } };
    let reveal = () => {};
    const account = createAccountStore({ site: async () => site, session: async () => principal, submit: async () => {} }, {
        subscribeVisible(listener) { reveal = listener; return () => {}; }, subscribeInvalidated: () => () => {}, publishInvalidated() {}, close() {},
    });
    await account.getState().initialize();
    await disk("image_files", "A").setItem(key, blob("local image"));
    await disk("media_files", "A").setItem(key, blob("local video"));
    const imageUrl = await image.resolveImageUrl(key), mediaUrl = await media.resolveMediaUrl(key);
    const owner = getAccountLocalScope();
    for (const change of ["role", "cloudCanvas", "cloudMedia"] as const) {
        const before = account.getState().getDraftScope()!;
        if (change === "role") principal = { ...principal, role: "admin" };
        else site = { ...site, [change]: false };
        reveal(); await account.getState().initialize();
        assert.ok(account.getState().getDraftScope()!.epoch > before.epoch);
        assert.deepEqual(getAccountLocalScope(), owner);
        assert.equal(await text(imageUrl), "local image");
        assert.equal(await text(mediaUrl), "local video");
    }
    principal = { ...principal, id: "B" }; reveal(); await account.getState().initialize();
    await assert.rejects(fetch(imageUrl)); await assert.rejects(fetch(mediaUrl));
} else throw new Error(`Unknown fixture mode: ${mode}`);
setAccountLocalAccount(null);
console.log(`Local media scope ${mode} passed`);
