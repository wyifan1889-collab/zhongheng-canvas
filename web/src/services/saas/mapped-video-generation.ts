import { GenerationError } from "./generation";
import { createVideoGenerationClient, sameVideoParameters, type VideoGenerationIntent } from "./video-generation";
import { mappingExecutionKey, type MappingExecution } from "../../../../packages/shared/src/model-mapping-execution";
import type { MappingCatalogCombination, MappingCatalogModel } from "./model-mapping-catalog";

export type VideoMappingCombination = MappingCatalogCombination & { execution: Extract<MappingExecution, { protocol: "yunfei-grok-video-v1" }> };
export type VideoMappingModel = Omit<MappingCatalogModel, "capability" | "combinations"> & { capability: "video"; combinations: VideoMappingCombination[] };
export const videoMappingChoiceKey = (choice: VideoMappingCombination) => JSON.stringify([choice.specification, mappingExecutionKey(choice.execution)]);
const changed = () => new GenerationError("catalog_changed", "视频模型配置或价格已变化，请更新模型列表后重新选择规格。", "not-sent");

/** Explicit mapping only. Return the original quote object so its one-use authority stays with the video client. */
export function createMappedVideoGenerationClient(options: Parameters<typeof createVideoGenerationClient>[0]) {
    const client = createVideoGenerationClient(options);
    let models: VideoMappingModel[] = [], sequence = 0;
    const selected = (input: VideoGenerationIntent) => models.flatMap(model => model.combinations).find(item =>
        item.available && item.nodeModelId === input.modelId && sameVideoParameters(item.execution.parameters, input.parameters));
    return Object.freeze({ ...client,
        async mappedModels(signal?: AbortSignal): Promise<VideoMappingModel[]> {
            const request = ++sequence; models = [];
            const [mapping, executable] = await Promise.all([client.mappingCatalog(signal), client.models(signal)]);
            if (request !== sequence) throw changed();
            models = mapping.models.filter(model => model.capability === "video").map((model): VideoMappingModel => ({ ...model, capability: "video", combinations: model.combinations.map((item): VideoMappingCombination => {
                const execution = item.execution as VideoMappingCombination["execution"];
                if (item.available) {
                    const pricing = executable.find(node => node.id === item.nodeModelId)?.videoPricing;
                    if (pricing?.priceVersion === item.priceVersion && pricing.protocol === execution.protocol && pricing.videoSpecs.some(spec =>
                        sameVideoParameters(spec.parameters, execution.parameters) && spec.creditsPerVideo === item.credits)) return { ...item, execution };
                }
                return { specification: item.specification, execution, credits: item.credits, available: false };
            }) }));
            return structuredClone(models);
        },
        async quote(input: VideoGenerationIntent, signal?: AbortSignal) {
            const expected = selected(input), request = sequence;
            if (!expected?.available) throw changed();
            const quote = await client.quote(input, signal);
            if (request !== sequence || selected(input) !== expected || quote.priceVersion !== expected.priceVersion || quote.reservedCredits !== expected.credits) throw changed();
            return quote;
        },
    });
}
