import type { VideoMappingModel } from "@/services/saas/mapped-video-generation";
import { sameVideoParameters } from "@/services/saas/video-generation";
import type { VideoDraftParameters } from "./video-parameters";

export function selectedVideoMapping(models: readonly VideoMappingModel[], value: VideoDraftParameters) {
    return value.parameters ? models.find(model => model.id === value.mappingModelId)?.combinations.find(item => item.available && item.nodeModelId === value.modelId &&
        item.specification === value.specification && sameVideoParameters(item.execution.parameters, value.parameters!)) : undefined;
}
