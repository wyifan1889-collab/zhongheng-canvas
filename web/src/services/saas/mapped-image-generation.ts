import { createGenerationClient, GenerationError, isGeminiGenerationParameters, sameGenerationParameters, type GenerationIntent, type GenerationModel } from "./generation";
import { mappingExecutionKey, type MappingExecution } from "../../../../packages/shared/src/model-mapping-execution";
import type { MappingCatalogCombination, MappingCatalogModel } from "./model-mapping-catalog";
import { imageSizePresets, mediaRatioOptions, parsePixelSize } from "@/lib/media-size";
import { imageGenerationSpec } from "../../../../packages/shared/src/model-price-publications";
import { GEMINI_IMAGE_PROTOCOL } from "../../../../packages/shared/src/generation-gemini-image";

export type ImageMappingCombination = MappingCatalogCombination & { execution: Exclude<MappingExecution, { protocol: "yunfei-grok-video-v1" }>; maxImages?: number };
export type ImageMappingModel = Omit<MappingCatalogModel, "capability" | "combinations"> & { capability: "image"; combinations: ImageMappingCombination[] };
export type ImageMappingSelection = Readonly<{ modelId?: string; specification?: string; combination?: string }>;
export const imageMappingChoiceKey = (choice: ImageMappingCombination) => JSON.stringify([choice.specification, mappingExecutionKey(choice.execution)]);
export function selectedImageMapping(models: ImageMappingModel[], selection?: ImageMappingSelection) {
    return models.find(model => model.id === selection?.modelId)?.combinations.find(item => item.available
        && item.specification === selection?.specification && imageMappingChoiceKey(item) === selection?.combination);
}
export function imageMappingAspectRatio(choice: ImageMappingCombination): string {
    if (choice.execution.protocol === GEMINI_IMAGE_PROTOCOL) return choice.execution.parameters.aspectRatio;
    const parameters = choice.execution.parameters;
    for (const presets of Object.values(imageSizePresets)) {
        const match = Object.entries(presets).find(([, size]) => size === parameters.size);
        if (match) return match[0];
    }
    const size = parsePixelSize(parameters.size)!;
    const preset = mediaRatioOptions.find(item => item.width && size.width * item.height === size.height * item.width);
    if (preset) return preset.value;
    let a = size.width, b = size.height;
    while (b) [a, b] = [b, a % b];
    return `${size.width / a}:${size.height / a}`;
}
export function imageMappingQuality(choice?: ImageMappingCombination) {
    return choice?.execution.protocol === "openai-image-v1" ? choice.execution.parameters.quality : undefined;
}
/** A control change chooses a complete published route, never synthesized pixel dimensions. */
export function chooseImageMapping(model: ImageMappingModel, filter: { specification?: string; aspectRatio?: string; quality?: string } = {}): ImageMappingSelection {
    const available = model.combinations.filter(item => item.available && (!filter.specification || item.specification === filter.specification)
        && (!filter.aspectRatio || imageMappingAspectRatio(item) === filter.aspectRatio));
    const specification = filter.specification ?? model.specifications.find(value => available.some(item => item.specification === value));
    const candidates = available.filter(item => item.specification === specification);
    const matchingQuality = candidates.filter(item => imageMappingQuality(item) === filter.quality);
    const choices = matchingQuality.length ? matchingQuality : candidates;
    const choice = choices.find(item => imageMappingAspectRatio(item) === "1:1") ?? choices[0];
    return choice ? { modelId: model.id, specification: choice.specification, combination: imageMappingChoiceKey(choice) }
        : { modelId: model.id, specification: filter.specification };
}
const changed = () => new GenerationError("catalog_changed", "模型配置或价格已变化，请更新模型列表后重新选择规格并查看费用。", "not-sent");

/** Resolve only explicit published routes, retaining the existing quote, task and recovery contract. */
export function createMappedImageGenerationClient(options: Parameters<typeof createGenerationClient>[0]) {
    const client = createGenerationClient(options);
    let models: ImageMappingModel[] = [], executableModels: GenerationModel[] = [], sequence = 0;
    function selected(input: GenerationIntent) {
        const parameters = input.parameters;
        return models.flatMap(model => model.combinations).find(item => item.available && item.nodeModelId === input.modelId &&
            (isGeminiGenerationParameters(parameters) ? item.execution.protocol === GEMINI_IMAGE_PROTOCOL &&
                sameGenerationParameters(item.execution.parameters, { aspectRatio: parameters.aspectRatio, imageSize: parameters.imageSize })
                : item.execution.protocol === "openai-image-v1" && (parameters.n ?? 1) <= (item.maxImages ?? 1) && sameGenerationParameters(item.execution.parameters, imageGenerationSpec(parameters))));
    }
    return Object.freeze({ ...client,
        async mappedModels(): Promise<ImageMappingModel[]> {
            const request = ++sequence; models = []; executableModels = [];
            const [mapping, executable] = await Promise.all([client.mappingCatalog(), client.models()]);
            if (request !== sequence) throw changed();
            models = mapping.models.filter(model => model.capability === "image").map((model): ImageMappingModel => ({ ...model, capability: "image", combinations: model.combinations.map((item): ImageMappingCombination => {
                const execution = item.execution;
                if (execution.protocol !== "openai-image-v1" && execution.protocol !== GEMINI_IMAGE_PROTOCOL) throw changed();
                if (item.available) {
                    const node = executable.find(node => node.id === item.nodeModelId), pricing = node?.imagePricing;
                    if (execution.protocol === GEMINI_IMAGE_PROTOCOL && pricing?.protocol === GEMINI_IMAGE_PROTOCOL && pricing.priceVersion === item.priceVersion && pricing.imageSpecs.some(spec =>
                        sameGenerationParameters(spec.parameters, execution.parameters) && spec.creditsPerImage === item.credits)) return { ...item, execution };
                    if (execution.protocol === "openai-image-v1" && pricing?.protocol === execution.protocol && pricing.priceVersion === item.priceVersion && execution.maxImagesPerRequest === node?.maxImagesPerRequest && pricing.imageSpecs.some(spec =>
                        sameGenerationParameters(spec.parameters, execution.parameters) && spec.creditsPerRequest === item.credits)) return { ...item, execution, maxImages: node?.maxImages ?? 1 };
                }
                return { specification: item.specification, execution, credits: item.credits, available: false };
            }) }));
            executableModels = executable.filter(node => models.some(model => model.combinations.some(item => item.available && item.nodeModelId === node.id)));
            return structuredClone(models);
        },
        executableModels: () => structuredClone(executableModels),
        async quote(input: GenerationIntent) {
            const expected = selected(input), request = sequence;
            if (!expected?.available) throw changed();
            const quote = await client.quote(input);
            if (request !== sequence || selected(input) !== expected || quote.priceVersion !== expected.priceVersion || quote.creditsPerUnit !== expected.credits) throw changed();
            if (expected.execution.protocol === GEMINI_IMAGE_PROTOCOL) {
                if (quote.billingUnit !== "image" || !isGeminiGenerationParameters(input.parameters) || quote.quotedUnits !== input.parameters.budgetCredits) throw changed();
            } else if (quote.imageSpec?.protocol !== expected.execution.protocol || quote.imageSpec.maxImagesPerRequest !== expected.execution.maxImagesPerRequest ||
                isGeminiGenerationParameters(input.parameters) || quote.quotedUnits !== expected.credits * (input.parameters.n ?? 1)) throw changed();
            return quote;
        },
    });
}
