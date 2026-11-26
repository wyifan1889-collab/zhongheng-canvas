import localforage from "localforage";

import { localForageStorage } from "../../lib/localforage-storage";
import type { Asset } from "../../stores/use-asset-store";

const legacyCatalogKey = "infinite-canvas:asset_store";
const legacyImageStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const legacyMediaStore = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });

export type LegacyAssetImportResult = {
    assets: Asset[];
    skipped: number;
    missingMedia: number;
};

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validAsset(value: unknown): value is Asset {
    if (!record(value) || !["text", "image", "video"].includes(String(value.kind)) || typeof value.id !== "string" || typeof value.title !== "string" || !record(value.data)) return false;
    if (value.kind === "text") return typeof value.data.content === "string";
    if (value.kind === "image") return typeof value.data.dataUrl === "string" && typeof value.data.width === "number" && typeof value.data.height === "number" && typeof value.data.bytes === "number" && typeof value.data.mimeType === "string";
    return typeof value.data.url === "string" && typeof value.data.width === "number" && typeof value.data.height === "number" && typeof value.data.bytes === "number" && typeof value.data.mimeType === "string";
}

/** Reads the legacy unscoped catalog only when the user explicitly opens the import flow. */
export async function readLegacyAssetCatalog(): Promise<Asset[]> {
    const raw = await legacyCatalogValue();
    return parseLegacyAssetCatalog(raw);
}

export function parseLegacyAssetCatalog(raw: unknown): Asset[] {
    if (!record(raw) || !record(raw.state) || !Array.isArray(raw.state.assets)) return [];
    return raw.state.assets.filter(validAsset).map((asset) => structuredClone(asset));
}

/**
 * Copies legacy binary files into the current account-scoped stores. The old
 * stores are read-only here and are never deleted or rewritten.
 */
export async function importLegacyAssetFiles(assets: Asset[], isCurrent?: () => boolean): Promise<LegacyAssetImportResult> {
    const checkCurrent = () => { if (isCurrent?.() === false) throw new Error("asset_import_scope_changed"); };
    checkCurrent();
    const [{ uploadImage, setImageBlob }, { setMediaBlob }] = await Promise.all([
        import("../../services/image-storage"),
        import("../../services/file-storage"),
    ]);
    checkCurrent();
    const imported: Asset[] = [];
    let skipped = 0;
    let missingMedia = 0;
    for (const source of assets) {
        checkCurrent();
        if (!validAsset(source)) {
            skipped += 1;
            continue;
        }
        const asset = structuredClone(source);
        if (asset.kind === "image" && asset.data.storageKey) {
            const blob = await legacyImageStore.getItem<Blob>(asset.data.storageKey);
            checkCurrent();
            if (blob) {
                const url = await setImageBlob(asset.data.storageKey, blob);
                checkCurrent();
                asset.data.dataUrl = url;
                if (asset.coverUrl.startsWith("blob:") || asset.coverUrl.startsWith("data:image/")) asset.coverUrl = url;
            } else {
                missingMedia += 1;
                delete asset.data.storageKey;
                if (asset.data.dataUrl.startsWith("blob:")) asset.data.dataUrl = "";
                if (asset.coverUrl.startsWith("blob:")) asset.coverUrl = "";
            }
        } else if (asset.kind === "image" && asset.data.dataUrl.startsWith("data:image/")) {
            const image = await uploadImage(asset.data.dataUrl);
            checkCurrent();
            asset.data = { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType };
            if (asset.coverUrl.startsWith("data:image/")) asset.coverUrl = image.url;
        } else if (asset.kind === "video" && asset.data.storageKey) {
            const blob = await legacyMediaStore.getItem<Blob>(asset.data.storageKey);
            checkCurrent();
            if (blob) {
                asset.data.url = await setMediaBlob(asset.data.storageKey, blob);
                checkCurrent();
            } else {
                missingMedia += 1;
                delete asset.data.storageKey;
                if (asset.data.url.startsWith("blob:")) asset.data.url = "";
            }
        }
        imported.push(asset);
    }
    return { assets: imported, skipped, missingMedia };
}

async function legacyCatalogValue() {
    if (typeof window === "undefined") return null;
    try {
        const localforageValue = await localForageStorage.getItem(legacyCatalogKey);
        return localforageValue ? JSON.parse(localforageValue) as unknown : null;
    } catch {
        return null;
    }
}
