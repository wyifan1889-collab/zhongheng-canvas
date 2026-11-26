import { CanvasNodeType, type CanvasNodeData, type Position } from "@/types/canvas";
import type { UploadedFile } from "@/services/file-storage";
import { parseVideoReceipt, type VideoReceipt } from "@/pages/video/platform-video-workbench";
import { videoMetadata } from "./canvas-node-factory";
import { fitNodeSize } from "./canvas-node-size";

export function appendPlatformVideo(nodes: CanvasNodeData[], center: Position, receipt: VideoReceipt, media: UploadedFile, bounds: { width: number; height: number }) {
    const verified = parseVideoReceipt(receipt), task = verified?.view?.task, result = verified?.view?.result;
    if (!verified || !task || task.id !== verified.taskId || task.executionStatus !== "succeeded" || task.billingStatus !== "captured" ||
        !["saved", "visible"].includes(task.deliveryStatus) || task.video.phase !== "completed" || result?.status !== "succeeded" ||
        result.resultSnapshot.media?.mediaId !== task.id || media.bytes !== result.resultSnapshot.media.sizeBytes || media.mimeType !== "video/mp4") {
        throw new Error("视频交付与原回执无法核对，未添加到画布。");
    }
    const id = `platform-video-${task.id}`;
    if (nodes.some(node => node.id === id)) return { nodes, id, added: false };
    const size = fitNodeSize(media.width || 1280, media.height || 720, bounds.width, bounds.height);
    const node: CanvasNodeData = { id, type: CanvasNodeType.Video, title: verified.intent.input.prompt.slice(0, 32) || "平台视频",
        position: { x: center.x - size.width / 2, y: center.y - size.height / 2 }, ...size,
        metadata: { ...videoMetadata(media), prompt: verified.intent.input.prompt, model: task.modelId, cloudMediaId: task.id } };
    return { nodes: [...nodes, node], id, added: true };
}
