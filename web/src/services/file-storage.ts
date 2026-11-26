import localforage from "localforage";
import { nanoid } from "nanoid";

import { withLocalProxy } from "@/stores/use-config-store";
import { accountScopedStoreName, captureAccountLocalScope, subscribeAccountLocalScope } from "@/services/saas/account-local-scope";

export type UploadedFile = { url: string; storageKey: string; bytes: number; mimeType: string; width?: number; height?: number; durationMs?: number };

const stores = new Map<string, ReturnType<typeof localforage.createInstance>>();
function captureStorage() {
    const owner = captureAccountLocalScope();
    const name = accountScopedStoreName("media_files", owner.scope);
    const cached = stores.get(name);
    if (cached) return { ...owner, store: cached };
    const created = localforage.createInstance({ name: "infinite-canvas", storeName: name });
    stores.set(name, created);
    return { ...owner, store: created };
}
const objectUrls = new Map<string, string>();

subscribeAccountLocalScope(() => {
    objectUrls.forEach((url) => URL.revokeObjectURL(url));
    objectUrls.clear();
});

export async function uploadMediaFile(input: string | Blob, prefix = "file"): Promise<UploadedFile> {
    const operation = captureStorage();
    const blob = typeof input === "string" ? await (await fetch(withLocalProxy(input))).blob() : input;
    operation.assertCurrent();
    const storageKey = `${prefix}:${nanoid()}`;
    let url: string | undefined;
    try {
        await operation.store.setItem(storageKey, blob);
        operation.assertCurrent();
        url = URL.createObjectURL(blob);
        const meta = blob.type.startsWith("video/") ? await readVideoMeta(url) : blob.type.startsWith("audio/") ? await readAudioMeta(url) : {};
        operation.assertCurrent();
        objectUrls.set(storageKey, url);
        return { url, storageKey, bytes: blob.size, mimeType: blob.type || "application/octet-stream", ...meta };
    } catch (error) {
        if (url) URL.revokeObjectURL(url);
        await operation.store.removeItem(storageKey).catch(() => undefined);
        throw error;
    }
}

export async function resolveMediaUrl(storageKey?: string, fallback = "") {
    const operation = captureStorage();
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const blob = await operation.store.getItem<Blob>(storageKey);
    operation.assertCurrent();
    if (!blob) return fallback;
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getMediaBlob(storageKey: string) {
    const operation = captureStorage();
    const blob = await operation.store.getItem<Blob>(storageKey);
    operation.assertCurrent();
    return blob;
}

export async function setMediaBlob(storageKey: string, blob: Blob) {
    const operation = captureStorage();
    await operation.store.setItem(storageKey, blob);
    operation.assertCurrent();
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function deleteStoredMedia(keys: Iterable<string>) {
    const operation = captureStorage();
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await operation.store.removeItem(key);
            operation.assertCurrent();
        }),
    );
}

export async function cleanupUnusedMedia(usedData: unknown) {
    const operation = captureStorage();
    const usedKeys = collectMediaStorageKeys(usedData);
    const unused: string[] = [];
    await operation.store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    operation.assertCurrent();
    await Promise.all(unused.map((key) => operation.store.removeItem(key)));
    operation.assertCurrent();
}

export function collectMediaStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectMediaStorageKeys(child, keys)) : collectMediaStorageKeys(item, keys)));
    return keys;
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1280, height: video.videoHeight || 720, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.src = url;
    });
}

function readAudioMeta(url: string) {
    return new Promise<{ durationMs?: number }>((resolve) => {
        const audio = document.createElement("audio");
        const done = () => resolve({ durationMs: Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : undefined });
        audio.onloadedmetadata = done;
        audio.onerror = done;
        audio.src = url;
    });
}
