import { parseVideoParameters, type VideoParameters } from "../../../packages/shared/src/generation-video";
import { GenerationContractError, type GenerationIntent } from "./generation-contract";

export function parseGenerationVideoRequest(intent: GenerationIntent): { input: { prompt: string; referenceMediaId?: string }; parameters: VideoParameters } {
    const input = intent.inputSnapshot, parameters = parseVideoParameters(intent.parameterSnapshot);
    if (!parameters || typeof input.prompt !== "string" || !input.prompt.trim() ||
        Object.keys(input).some(key => key !== "prompt" && key !== "referenceMediaId") ||
        (parameters.mode === "first_frame" ? typeof input.referenceMediaId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.referenceMediaId) : Object.hasOwn(input, "referenceMediaId"))) {
        throw new GenerationContractError("unsupported_generation", "视频输入或规格不受支持；首帧模式需要一份本人图片，文生模式不接受参考素材");
    }
    return { input: { prompt: input.prompt, ...(parameters.mode === "first_frame" ? { referenceMediaId: input.referenceMediaId as string } : {}) }, parameters };
}
