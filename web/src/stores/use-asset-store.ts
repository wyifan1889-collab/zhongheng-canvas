import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { localForageStorage } from "@/lib/localforage-storage";
import { ensureImagePreview, previewUrlFor, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { resolveMediaUrl } from "@/services/file-storage";
import { getAccountLocalScope, accountScopedStoreName, subscribeAccountLocalScope, type AccountLocalScope } from "@/services/saas/account-local-scope";

export type AssetKind = "text" | "image" | "video";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    cleanupImages: (extra?: unknown) => void;
};

// 卡片用缩略图渲染，自定义封面（远程地址或单独上传的封面）保持原样。
export function assetCoverUrl(asset: Asset) {
    const own = asset.kind === "image" ? asset.data.dataUrl : "";
    const cover = asset.coverUrl || own;
    return asset.kind === "image" && cover === own ? previewUrlFor(asset.data.storageKey) || cover : cover;
}

const ASSET_STORE_KEY = "infinite-canvas:asset_store";
let activeAccountId: string | null = null;
let scopeRevision = 0;
let suppressWrites = false;

function scopedAssetKey(accountId: string) {
    return `${ASSET_STORE_KEY}:${accountScopedStoreName("account", { accountId, epoch: 0 })}`;
}

async function hydrateAssets(assets: Asset[]) {
    return Promise.all(
        assets.map(async (asset) => {
            if (asset.kind === "video" && asset.data.storageKey) return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
            if (asset.kind !== "image") return asset;
            if (asset.data.storageKey) {
                void ensureImagePreview(asset.data.storageKey);
                return {
                    ...asset,
                    coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(asset.data.storageKey, asset.coverUrl) : asset.coverUrl,
                    data: { ...asset.data, dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl) },
                };
            }
            if (!asset.data.dataUrl.startsWith("data:image/")) return asset;
            const image = await uploadImage(asset.data.dataUrl);
            return { ...asset, coverUrl: asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl, data: { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, mimeType: image.mimeType } };
        }),
    );
}

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async () => {
        if (!activeAccountId) return null;
        const value = await localForageStorage.getItem(scopedAssetKey(activeAccountId));
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<AssetStore>;
        parsed.state.assets = await hydrateAssets(Array.isArray(parsed.state.assets) ? parsed.state.assets : []);
        return parsed;
    },
    setItem: (_name, value) => activeAccountId && !suppressWrites ? localForageStorage.setItem(scopedAssetKey(activeAccountId), JSON.stringify(value)) : undefined,
    removeItem: (_name) => activeAccountId && !suppressWrites ? localForageStorage.removeItem(scopedAssetKey(activeAccountId)) : undefined,
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            assets: [],
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = nanoid();
                set((state) => ({ assets: [{ ...asset, id, createdAt: now, updatedAt: now } as Asset, ...state.assets] }));
                return id;
            },
            updateAsset: (id, patch) =>
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? ({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                })),
            removeAsset: (id) =>
                set((state) => {
                    const assets = state.assets.filter((asset) => asset.id !== id);
                    get().cleanupImages({ assets });
                    return { assets };
                }),
            replaceAssets: (assets) => set({ assets }),
            cleanupImages: () => {
                // A tab cannot prove a blob is unused by another tab's pending/conflicted draft.
                // Preserve files until collection can coordinate with every writer; even a fresh
                // catalog read races media uploaded immediately before its document is committed.
            },
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            skipHydration: true,
            partialize: (state) => ({ assets: state.assets }) as StorageValue<AssetStore>["state"],
        },
    ),
);

/** Load only the active account's asset catalog. Legacy global data is never auto-imported. */
export async function loadAccountAssets(scope: AccountLocalScope = getAccountLocalScope()) {
    activeAccountId = scope?.accountId ?? null;
    const revision = ++scopeRevision;
    suppressWrites = true;
    useAssetStore.setState({ assets: [], hydrated: false });
    suppressWrites = false;
    if (!activeAccountId) {
        useAssetStore.setState({ hydrated: true });
        return;
    }
    const value = await assetStorage.getItem(ASSET_STORE_KEY);
    if (revision !== scopeRevision) return;
    const assets = value ? (value as StorageValue<AssetStore>).state.assets : [];
    suppressWrites = true;
    useAssetStore.setState({ assets: Array.isArray(assets) ? assets : [], hydrated: true });
    suppressWrites = false;
}

// The account store updates this boundary on login, refresh and sign-out.
subscribeAccountLocalScope((scope) => { void loadAccountAssets(scope); });
