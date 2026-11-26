import type { UploadedImage } from "../image-storage";

export type AssetInsertGuard = () => boolean;

export function assertAssetInsertionCurrent(isCurrent: AssetInsertGuard) {
    if (!isCurrent()) throw new Error("账号、画布或素材窗口已变化，素材未添加。");
}

/** The picker passes this same guard to the canvas across the async handoff. */
export async function readCloudAssetData(options: {
    mediaId: string;
    isCurrent: AssetInsertGuard;
    download: (id: string) => Promise<Blob>;
    toDataUrl: (blob: Blob) => Promise<string>;
}) {
    assertAssetInsertionCurrent(options.isCurrent);
    const blob = await options.download(options.mediaId);
    assertAssetInsertionCurrent(options.isCurrent);
    const dataUrl = await options.toDataUrl(blob);
    assertAssetInsertionCurrent(options.isCurrent);
    return dataUrl;
}

/** Keep the original local-image preparation; the canvas owns the final synchronous commit. */
export async function insertCanvasAssetImage(options: {
    image: { dataUrl: string; storageKey?: string };
    isCurrent: AssetInsertGuard;
    upload: (input: string) => Promise<UploadedImage>;
    ensurePreview: (storageKey?: string) => Promise<unknown>;
    readMeta: (url: string) => Promise<{ width: number; height: number }>;
    commit: (image: UploadedImage) => void;
}) {
    assertAssetInsertionCurrent(options.isCurrent);
    const { image } = options;
    const stored = image.storageKey
        ? { url: image.dataUrl, storageKey: image.storageKey, width: 1, height: 1, bytes: 0, mimeType: "image/png" }
        : await options.upload(image.dataUrl);
    assertAssetInsertionCurrent(options.isCurrent);
    await options.ensurePreview(stored.storageKey);
    assertAssetInsertionCurrent(options.isCurrent);
    const dimensions = stored.width === 1 && stored.height === 1 ? await options.readMeta(stored.url) : stored;
    assertAssetInsertionCurrent(options.isCurrent);
    options.commit({ ...stored, width: dimensions.width, height: dimensions.height });
}
