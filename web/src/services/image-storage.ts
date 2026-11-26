import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { withLocalProxy } from "@/stores/use-config-store";
import { createImageThumbnail } from "@/lib/image-thumbnail";
import { accountScopedStoreName, captureAccountLocalScope, subscribeAccountLocalScope, type AccountLocalScope } from "@/services/saas/account-local-scope";

export type UploadedImage = {
    url: string;
    storageKey?: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const stores = new Map<string, ReturnType<typeof localforage.createInstance>>();
function store(baseName: string, scope: AccountLocalScope) {
    const name = accountScopedStoreName(baseName, scope);
    const cached = stores.get(name);
    if (cached) return cached;
    const created = localforage.createInstance({ name: "infinite-canvas", storeName: name });
    stores.set(name, created);
    return created;
}
function captureStorage() {
    const owner = captureAccountLocalScope();
    return { ...owner, images: store("image_files", owner.scope), previews: store("image_previews", owner.scope),
        imageLogs: store("image_generation_logs", owner.scope), videoLogs: store("video_generation_logs", owner.scope) };
}
type ImageStorageOperation = ReturnType<typeof captureStorage>;
const objectUrls = new Map<string, string>();
const previewUrls = new Map<string, string>();
const previewListeners = new Set<() => void>();
let previewRevision = 0;
let previewQueue: Promise<unknown> = Promise.resolve();
const IMAGE_PREVIEW_VERSION = 1;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_REMOTE_LOAD_TIMEOUT_MS = 10 * 60_000;
const IMAGE_DECODE_TIMEOUT_MS = 10_000;
const IMAGE_RESPONSE_ERROR = "ImageResponseError";
const IMAGE_TIMEOUT_ERROR = "ImageTimeoutError";

subscribeAccountLocalScope(() => {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    previewUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
    previewUrls.clear();
    previewRevision += 1;
    previewListeners.forEach((listener) => listener());
});

type StoredImagePreview = { version: number; blob?: Blob };

type ImageReadOptions = { signal?: AbortSignal };

export async function uploadImage(input: string | Blob, options?: ImageReadOptions): Promise<UploadedImage> {
    const operation = captureStorage();
    if (typeof input !== "string") return storeImage(input, operation, options);

    let blob: Blob;
    try {
        blob = await fetchImageBlob(input, options);
    } catch (error) {
        operation.assertCurrent();
        if (options?.signal?.aborted || isNamedError(error, IMAGE_RESPONSE_ERROR) || isNamedError(error, IMAGE_TIMEOUT_ERROR) || !/^https?:\/\//i.test(input)) throw error;
        const meta = await loadImageMeta(input, options, IMAGE_REMOTE_LOAD_TIMEOUT_MS);
        operation.assertCurrent();
        if (!meta) throw error;
        return { url: input, width: meta.width, height: meta.height, bytes: 0, mimeType: "" };
    }
    operation.assertCurrent();
    return storeImage(blob, operation, options);
}
async function storeImage(blob: Blob, operation: ImageStorageOperation, options?: ImageReadOptions): Promise<UploadedImage> {
    const storageKey = `image:${nanoid()}`;
    const url = URL.createObjectURL(blob);
    try {
        const meta = await loadImageMeta(url, options);
        operation.assertCurrent();
        if (!meta) throw new Error(i18n.t("common.imageReadFailed"));
        throwIfAborted(options?.signal);
        await operation.images.setItem(storageKey, blob);
        operation.assertCurrent();
        throwIfAborted(options?.signal);
        objectUrls.set(storageKey, url);
        await storeImagePreview(storageKey, blob, operation);
        operation.assertCurrent();
        return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type.startsWith("image/") ? blob.type : "" };
    } catch (error) {
        URL.revokeObjectURL(url);
        if (operation.isCurrent() && objectUrls.get(storageKey) === url) objectUrls.delete(storageKey);
        // This key was created by this operation; cleanup must use its original partition.
        await operation.images.removeItem(storageKey).catch(() => undefined);
        throw error;
    }
}

async function fetchImageBlob(url: string, options?: ImageReadOptions) {
    const controller = new AbortController();
    let timedOut = false;
    const abort = () => controller.abort();
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    const timer = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, IMAGE_DOWNLOAD_TIMEOUT_MS);
    try {
        const response = await fetch(withLocalProxy(url), { signal: controller.signal });
        if (!response.ok) throw namedError(IMAGE_RESPONSE_ERROR);
        return await response.blob();
    } catch (error) {
        if (timedOut) throw namedError(IMAGE_TIMEOUT_ERROR);
        if (options?.signal?.aborted) throw abortReason(options.signal);
        throw error;
    } finally {
        window.clearTimeout(timer);
        options?.signal?.removeEventListener("abort", abort);
    }
}

function loadImageMeta(url: string, options?: ImageReadOptions, timeoutMs = IMAGE_DECODE_TIMEOUT_MS) {
    return new Promise<{ width: number; height: number } | null>((resolve, reject) => {
        if (options?.signal?.aborted) return reject(abortReason(options.signal));
        const image = new Image();
        let settled = false;
        const finish = (value: { width: number; height: number } | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            options?.signal?.removeEventListener("abort", abort);
            image.onload = null;
            image.onerror = null;
            resolve(value);
        };
        const abort = () => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            image.onload = null;
            image.onerror = null;
            reject(abortReason(options!.signal!));
        };
        const timer = window.setTimeout(() => finish(null), timeoutMs);
        options?.signal?.addEventListener("abort", abort, { once: true });
        image.onload = () => finish(image.naturalWidth && image.naturalHeight ? { width: image.naturalWidth, height: image.naturalHeight } : null);
        image.onerror = () => finish(null);
        image.src = url;
    });
}

function namedError(name: string) {
    const error = new Error(i18n.t("common.imageReadFailed"));
    error.name = name;
    return error;
}

function isNamedError(error: unknown, name: string) {
    return error instanceof Error && error.name === name;
}

function abortReason(signal: AbortSignal) {
    return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

function throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) throw abortReason(signal);
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    const operation = captureStorage();
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await operation.images.getItem<Blob>(storageKey);
    operation.assertCurrent();
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    const operation = captureStorage();
    const blob = await operation.images.getItem<Blob>(storageKey);
    operation.assertCurrent();
    return blob;
}

// 缩略图按图片的 storageKey 另存一份 WebP，只放在本地 IndexedDB 里，不写进节点数据，也不参与导出和 WebDAV 同步。
export function previewUrlFor(storageKey?: string) {
    return storageKey ? previewUrls.get(storageKey) : undefined;
}

// 缩略图在后台补，生成完成后再让用到它的界面重渲染一次。
export function subscribeImagePreviews(listener: () => void) {
    previewListeners.add(listener);
    return () => {
        previewListeners.delete(listener);
    };
}

export function getImagePreviewRevision() {
    return previewRevision;
}

export async function ensureImagePreview(storageKey?: string) {
    const operation = captureStorage();
    if (!storageKey) return undefined;
    const cached = previewUrls.get(storageKey);
    if (cached) return cached;
    const stored = await operation.previews.getItem<StoredImagePreview>(storageKey).catch(() => null);
    // Preview requests are also fire-and-forget; stale work ends silently.
    if (!operation.isCurrent()) return undefined;
    if (stored?.version === IMAGE_PREVIEW_VERSION) return stored.blob ? cacheImagePreview(storageKey, stored.blob) : undefined;
    queueImagePreview(storageKey, operation);
    return undefined;
}

// 缩略图生成排成一队，避免一次打开大量图片时同时解码。
function queueImagePreview(storageKey: string, operation: ImageStorageOperation) {
    previewQueue = previewQueue
        .then(async () => {
            operation.assertCurrent();
            const original = await operation.images.getItem<Blob>(storageKey);
            operation.assertCurrent();
            if (original) await storeImagePreview(storageKey, original, operation);
        })
        .catch(() => undefined);
}

async function storeImagePreview(storageKey: string, original: Blob, operation: ImageStorageOperation) {
    operation.assertCurrent();
    const preview = await createImageThumbnail(original).catch(() => undefined);
    operation.assertCurrent();
    await operation.previews.setItem<StoredImagePreview>(storageKey, { version: IMAGE_PREVIEW_VERSION, blob: preview }).catch(() => undefined);
    operation.assertCurrent();
    return preview ? cacheImagePreview(storageKey, preview) : undefined;
}

function cacheImagePreview(storageKey: string, preview: Blob) {
    const url = URL.createObjectURL(preview);
    previewUrls.set(storageKey, url);
    previewRevision += 1;
    previewListeners.forEach((listener) => listener());
    return url;
}

async function deleteImagePreview(storageKey: string, operation: ImageStorageOperation) {
    operation.assertCurrent();
    const url = previewUrls.get(storageKey);
    if (url) URL.revokeObjectURL(url);
    previewUrls.delete(storageKey);
    await operation.previews.removeItem(storageKey).catch(() => undefined);
    operation.assertCurrent();
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    const operation = captureStorage();
    await operation.images.setItem(storageKey, blob);
    operation.assertCurrent();
    await deleteImagePreview(storageKey, operation);
    await storeImagePreview(storageKey, blob, operation);
    operation.assertCurrent();
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }, options?: ImageReadOptions) {
    const operation = captureStorage();
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    operation.assertCurrent();
    if (!url || url.startsWith("data:")) return url;
    const blob = await fetchImageBlob(url, options);
    operation.assertCurrent();
    const dataUrl = await blobToDataUrl(blob);
    operation.assertCurrent();
    return dataUrl;
}

export async function deleteStoredImages(keys: Iterable<string>) {
    return deleteImages(keys, captureStorage());
}

async function deleteImages(keys: Iterable<string>, operation: ImageStorageOperation) {
    operation.assertCurrent();
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await deleteImagePreview(key, operation);
            operation.assertCurrent();
            await operation.images.removeItem(key);
            operation.assertCurrent();
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const operation = captureStorage();
    const usedKeys = collectImageStorageKeys(usedData);
    await Promise.all([
        operation.imageLogs.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
        operation.videoLogs.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
    ]);
    operation.assertCurrent();
    const unused: string[] = [];
    await operation.images.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    operation.assertCurrent();
    const orphanPreviews: string[] = [];
    await operation.previews.iterate((_value, key) => {
        if (!usedKeys.has(key)) orphanPreviews.push(key);
    });
    operation.assertCurrent();
    await Promise.all([deleteImages(unused, operation), ...orphanPreviews.map((key) => deleteImagePreview(key, operation))]);
    operation.assertCurrent();
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}
