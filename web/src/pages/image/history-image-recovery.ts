import { z } from "zod/v4";
import { CloudMediaError, createMediaClient } from "@/services/api/media";
import { GenerationError } from "@/services/saas/generation";
import { createGenerationHistoryClient, type GenerationHistoryScope } from "@/services/saas/generation-history";
import { parseHistoryReturnQuery, type HistoryDetail } from "@/services/saas/generation-history-detail";
import { decodeGeneratedImage } from "@/services/saas/canvas-generated-image";
import { geminiImageDimensions } from "../../../../packages/shared/src/generation-gemini-image";

export function readImageRecoveryIntent(state: unknown) {
    const parsed = z.object({ fromGenerationHistory: z.object({ taskId: z.uuid(), type: z.literal("image"), query: z.unknown().optional() }) }).safeParse(state);
    return parsed.success ? { taskId: parsed.data.fromGenerationHistory.taskId,
        query: parseHistoryReturnQuery(parsed.data.fromGenerationHistory.query) } : null;
}

export type ImageRecoveryState = { phase: "loading" | "ready" | "error"; detail?: HistoryDetail; url?: string; error?: string; authenticationRequired?: boolean };

/** Reads one existing task. This reader has no submission, receipt store or persistence. */
export function createHistoryImageRecovery(options: {
    scope: GenerationHistoryScope; getScope: () => GenerationHistoryScope | null; taskId: string; onState: (state: ImageRecoveryState) => void;
    client?: Pick<ReturnType<typeof createGenerationHistoryClient>, "detail">;
    mediaClient?: (signal: AbortSignal) => Pick<ReturnType<typeof createMediaClient>, "resolve" | "download">;
    decode?: typeof decodeGeneratedImage; createUrl?: (blob: Blob) => string; revokeUrl?: (url: string) => void;
}) {
    let state: ImageRecoveryState = { phase: "loading" }, operation: AbortController | null = null, stopped = false, blocked = false;
    const sameScope = () => { const scope = options.getScope(); return scope?.accountId === options.scope.accountId && scope.epoch === options.scope.epoch; };
    const current = () => !stopped && !blocked && sameScope();
    const revoke = options.revokeUrl ?? URL.revokeObjectURL;
    const clear = () => { operation?.abort(); operation = null; if (state.url) revoke(state.url); state = { phase: "loading" }; };
    const publish = (next: ImageRecoveryState) => { state = next; options.onState(next); };
    const client = options.client ?? createGenerationHistoryClient(options);
    return {
        dispose() { stopped = true; clear(); },
        syncScope() { if (!sameScope()) { stopped = true; clear(); options.onState(state); } },
        async read() {
            if (!current()) return;
            clear(); const abort = new AbortController(); operation = abort;
            const active = () => current() && operation === abort && !abort.signal.aborted;
            publish({ phase: "loading" });
            let url: string | undefined;
            try {
                const detail = await client.detail(options.taskId, abort.signal);
                if (!active()) return;
                if (detail.task.id !== options.taskId || detail.result && detail.result.taskId !== options.taskId) throw new Error("原任务编号无法核实。");
                const media = detail.result?.resultSnapshot.media;
                if (detail.task.executionStatus !== "succeeded" || !["saved", "visible"].includes(detail.task.deliveryStatus) || detail.result?.status !== "succeeded") {
                    publish({ phase: "ready", detail }); return;
                }
                if (detail.result.resultSnapshot.kind !== "image" || media?.kind !== "image" || media.mediaId !== options.taskId || media.contentType !== "image/png" || !/^[0-9a-f]{64}$/.test(media.etag)) throw new Error("原图片交付证据不完整，请保留任务编号核对。");
                const privateMedia = options.mediaClient?.(abort.signal) ?? createMediaClient(() => active() ? options.scope.accountId : null,
                    (input, init) => fetch(input, { ...init, signal: abort.signal }));
                const resolved = await privateMedia.resolve([media.mediaId]);
                if (!active()) return;
                const owned = resolved.items[0];
                if (resolved.missing.length || resolved.items.length !== 1 || !owned || owned.id !== media.mediaId || owned.url !== `/api/v1/media/${media.mediaId}` || owned.kind !== media.kind || owned.contentType !== media.contentType || owned.sizeBytes !== media.sizeBytes) throw new Error("原图片归属或元数据无法核实。");
                const blob = await privateMedia.download(media.mediaId);
                if (!active()) return;
                if (blob.type !== media.contentType || blob.size !== media.sizeBytes) throw new Error("原图片内容不完整。");
                const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
                if (!active()) return;
                if ([...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("") !== media.etag) throw new Error("原图片完整性核对失败。");
                url = (options.createUrl ?? URL.createObjectURL)(blob);
                const dimensions = await (options.decode ?? decodeGeneratedImage)(url, abort.signal);
                if (!active()) return;
                const expected = detail.task.imageSpecSnapshot;
                if (expected?.status === "invalid" || expected?.status === "recorded" && `${dimensions.width}x${dimensions.height}` !== expected.parameters.size) throw new Error("原图片与规格记录不一致。");
                if (detail.task.geminiImage) {
                    const native = geminiImageDimensions(detail.task.geminiImage.parameters);
                    if (detail.task.billingStatus !== "captured" || !native || native.width !== dimensions.width || native.height !== dimensions.height) throw new Error("原生图片的规格或结算尚未核实。");
                }
                publish({ phase: "ready", detail, url }); url = undefined;
            } catch (cause) {
                if (!active()) return;
                if ((cause instanceof GenerationError || cause instanceof CloudMediaError) && (cause.status === 401 || ["account_changed", "context_changed", "account_context_required"].includes(cause.code))) blocked = true;
                publish({ phase: "error", authenticationRequired: blocked,
                    error: blocked ? "登录状态已变化，请重新确认登录后打开原任务。" : cause instanceof Error ? cause.message : "原任务读取未完成，请手动重试。" });
            } finally { if (url) revoke(url); if (operation === abort) operation = null; }
        },
    };
}
