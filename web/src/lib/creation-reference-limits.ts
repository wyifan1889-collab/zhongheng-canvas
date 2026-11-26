import { AGENT_MESSAGE_REFERENCE_LIMIT } from "./agent/message-references";

/** Storage capacity is independent of the limit on one AI request. */
export const CREATION_DRAFT_REFERENCE_LIMIT = 14;

export function creationReferenceSendIssue(count: number, kind: "agent" | "image" | "video" | "audio") {
    if (count > AGENT_MESSAGE_REFERENCE_LIMIT) return `草稿已保留全部 ${count} 个参考素材；单次发送给 AI 最多 ${AGENT_MESSAGE_REFERENCE_LIMIT} 个，请移除多余素材后发送。`;
    if (kind === "video" && count > 7) return "草稿已保留全部参考素材；当前视频能力最多支持 7 张参考图片，请移除多余图片后发送。";
    return null;
}
