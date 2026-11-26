import type { readPublishedMappingCatalog } from "@infinite-canvas/database/model-mapping-publications";
import { imageSpecFitsPixelBudget } from "./generation-image-limits";
import { GEMINI_IMAGE_PROTOCOL, geminiImageDimensions } from "../../../packages/shared/src/generation-gemini-image";

/** Configuration is not runtime availability. Keep reserved labels while applying existing generation limits. */
export function executableMappingCatalog(catalog: Awaited<ReturnType<typeof readPublishedMappingCatalog>>, runtime: {
    enabled: boolean; imageEnabled: boolean; videoEnabled: boolean; geminiImageEnabled?: boolean; maxVideoDurationMs?: number;
}) {
    return { ...catalog, models: catalog.models.map(model => ({ ...model, combinations: model.combinations.map(combination => {
        const execution = combination.execution;
        const nativeSize = execution.protocol === GEMINI_IMAGE_PROTOCOL ? geminiImageDimensions(execution.parameters) : null;
        const allowed = runtime.enabled && (execution.protocol === "openai-image-v1"
            ? runtime.imageEnabled && imageSpecFitsPixelBudget(execution.parameters)
            : execution.protocol === GEMINI_IMAGE_PROTOCOL ? runtime.imageEnabled && runtime.geminiImageEnabled === true && !!nativeSize && imageSpecFitsPixelBudget({ size: `${nativeSize.width}x${nativeSize.height}` })
            : runtime.videoEnabled && runtime.maxVideoDurationMs !== undefined && execution.parameters.durationSeconds * 1000 <= runtime.maxVideoDurationMs);
        if (allowed && combination.available) return combination;
        const { nodeModelId: _node, priceVersion: _price, ...reserved } = combination;
        return { ...reserved, available: false };
    }) })) };
}
