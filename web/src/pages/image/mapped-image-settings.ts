import type { PersonalMediaParameters } from "@/stores/use-creation-media-launch";
import type { ImageMappingModel, ImageMappingCombination } from "@/services/saas/mapped-image-generation";
import { chooseImageMapping, selectedImageMapping as resolveImageMapping } from "@/services/saas/mapped-image-generation";
import { validImageGenerationCount } from "../../../../packages/shared/src/model-price-publications";

type WorkbenchImageCombination = ImageMappingCombination & { execution: Extract<ImageMappingCombination["execution"], { protocol: "openai-image-v1" }> };
export type WorkbenchImageModel = Omit<ImageMappingModel, "combinations"> & { combinations: WorkbenchImageCombination[] };

/** This workbench currently confirms fixed-count requests; native budgets belong to the canvas. */
export function workbenchImageMappings(models: readonly ImageMappingModel[]): WorkbenchImageModel[] {
    return models.flatMap(model => {
        const combinations = model.combinations.filter((item): item is WorkbenchImageCombination => item.execution.protocol === "openai-image-v1");
        return combinations.length ? [{ ...model, combinations, specifications: model.specifications.filter(spec => combinations.some(item => item.specification === spec)) }] : [];
    });
}

export function selectedImageMapping(models: readonly WorkbenchImageModel[], value: PersonalMediaParameters) {
    return models.find(model => model.id === value.mappingModelId)?.combinations.find(item => item.available && item.nodeModelId === value.imageModel &&
        item.specification === value.mappingSpecification && item.execution.parameters.size === value.size && item.execution.parameters.quality === value.quality);
}
export function mappedImageParameters(model: WorkbenchImageModel, choice?: WorkbenchImageCombination): PersonalMediaParameters {
    return { mappingModelId: model.id, ...(choice?.available ? { mappingSpecification: choice.specification, model: choice.nodeModelId,
        imageModel: choice.nodeModelId, ...choice.execution.parameters } : { model: "", imageModel: "" }) };
}
export function chooseWorkbenchImageParameters(model: WorkbenchImageModel, filter: Parameters<typeof chooseImageMapping>[1] = {}, count = "1") {
    const selection = chooseImageMapping(model, filter);
    const choice = resolveImageMapping([model], selection) as WorkbenchImageCombination | undefined;
    return { ...mappedImageParameters(model, choice), count: validImageGenerationCount(Number(count)) ? String(Math.min(Number(count), choice?.maxImages ?? 1)) : "1" };
}
export const initialMappedImageParameters = (model: WorkbenchImageModel) => chooseWorkbenchImageParameters(model);
export function mappedImageReferencePrice(models: readonly WorkbenchImageModel[], value: PersonalMediaParameters) {
    const choice = selectedImageMapping(models, value), count = Number(value.count ?? "1");
    if (choice && validImageGenerationCount(count) && count <= (choice.maxImages ?? 1)) return choice.credits * count;
}
