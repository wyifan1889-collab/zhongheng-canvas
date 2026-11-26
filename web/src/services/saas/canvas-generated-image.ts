import type { createMediaClient } from "../api/media";
import type { GenerationTaskView } from "./generation";
import { geminiImageDimensions } from "../../../../packages/shared/src/generation-gemini-image";

export type CanvasGeneratedImageItem = { cloudMediaId: string; url: string; width: number; height: number; bytes: number; mimeType: "image/png" };
export type CanvasGeneratedImage = CanvasGeneratedImageItem & { taskId: string; images?: CanvasGeneratedImageItem[] };

/** Decode the actual private image. Closing the dialog aborts decoding without a fallback size. */
export function decodeGeneratedImage(url: string, signal: AbortSignal): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
        const image = new Image();
        const cleanup = () => { image.onload = null; image.onerror = null; signal.removeEventListener("abort", abort); };
        const abort = () => { cleanup(); image.src = ""; reject(new Error("图片读取已取消。")); };
        image.onload = () => {
            cleanup();
            if (image.naturalWidth > 0 && image.naturalHeight > 0) resolve({ width: image.naturalWidth, height: image.naturalHeight });
            else reject(new Error("生成图片无法解码，请保留任务记录。"));
        };
        image.onerror = () => { cleanup(); reject(new Error("生成图片无法解码，请保留任务记录。")); };
        if (signal.aborted) { abort(); return; }
        signal.addEventListener("abort", abort, { once: true });
        image.src = url;
    });
}

/** The original canvas takes URL ownership only after its current-context commit, including receipt/storage waits. */
export async function insertGeneratedImage(options: {
    view: GenerationTaskView;
    media: Pick<ReturnType<typeof createMediaClient>, "resolve" | "download">;
    isCurrent: () => boolean;
    signal: AbortSignal;
    commit: (image: CanvasGeneratedImage) => boolean | Promise<boolean>;
    decode?: typeof decodeGeneratedImage;
    createUrl?: (blob: Blob) => string;
    revokeUrl?: (url: string) => void;
}): Promise<boolean> {
    const { view } = options, media = view.result?.resultSnapshot.media;
    const check = () => { if (options.signal.aborted || !options.isCurrent()) throw new Error("账号、画布或窗口已变化，图片未添加。请从原画布的任务记录核对。"); };
    check();
    if (view.task.imageSpecSnapshot?.status === "invalid") throw new Error("原图片规格未通过核对，未添加结果。请保留任务号核对。");
    if (view.task.executionStatus !== "succeeded" || !["saved", "visible"].includes(view.task.deliveryStatus) || view.result?.status !== "succeeded" || view.result.taskId !== view.task.id || !media || media.kind !== "image" || media.contentType !== "image/png") throw new Error("图片尚未保存完成，请先查看任务进度。");
    const native = view.task.geminiImage;
    const count = native ? view.result.consumedUnits : view.task.imageSpecSnapshot?.status === "recorded" ? view.task.imageSpecSnapshot.parameters.n ?? 1 : 1;
    if (native && (view.task.billingStatus !== "captured" || !count || !Number.isSafeInteger(count) || count < 1 ||
        BigInt(count) * BigInt(native.creditsPerImage) > BigInt(native.parameters.budgetCredits))) throw new Error("图片交付与结算仍待核对，请保留原任务。");
    const references = view.result.resultSnapshot.imageMedia ?? [media];
    if (references.length !== count || new Set(references.map(item => item.mediaId)).size !== count ||
        references[0]?.mediaId !== media.mediaId || references.some(item => item.kind !== "image" || item.contentType !== "image/png")) throw new Error("生成图片数量不完整，请保留任务记录。");
    const resolved = await options.media.resolve(references.map(item => item.mediaId));
    check();
    if (resolved.missing.length) throw new Error("生成素材核对未通过，请保留任务记录。");
    const images: CanvasGeneratedImageItem[] = [], urls: string[] = [];
    let committed = false;
    try {
        for (const media of references) {
            const owned = resolved.items.find(item => item.id === media.mediaId);
            if (!owned || owned.kind !== "image" || owned.contentType !== media.contentType || owned.sizeBytes !== media.sizeBytes) throw new Error("生成素材核对未通过，请保留任务记录。");
            const blob = await options.media.download(media.mediaId);
            check();
            if (blob.type !== media.contentType || blob.size !== media.sizeBytes) throw new Error("生成图片内容不完整，请保留任务记录。");
            const url = (options.createUrl ?? URL.createObjectURL)(blob);
            urls.push(url);
            const dimensions = await (options.decode ?? decodeGeneratedImage)(url, options.signal);
            check();
            if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) || dimensions.width <= 0 || dimensions.height <= 0) throw new Error("生成图片尺寸无效。");
            const expectedSize = view.task.imageSpecSnapshot?.status === "recorded" ? view.task.imageSpecSnapshot.parameters.size : undefined;
            if (expectedSize && `${dimensions.width}x${dimensions.height}` !== expectedSize) throw new Error("生成图片与原规格尺寸不一致，未添加结果。");
            if (native) {
                const expected = geminiImageDimensions(native.parameters);
                if (!expected || dimensions.width !== expected.width || dimensions.height !== expected.height) throw new Error("生成图片与原生规格尺寸不一致，未添加结果。");
            }
            images.push({ cloudMediaId: media.mediaId, url, ...dimensions, bytes: blob.size, mimeType: "image/png" });
        }
        check();
        committed = await options.commit({ ...images[0]!, taskId: view.task.id, ...(images.length > 1 ? { images } : {}) });
        return committed;
    } finally {
        if (!committed) for (const url of urls) (options.revokeUrl ?? URL.revokeObjectURL)(url);
    }
}
