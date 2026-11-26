import { createGenerationClient, GenerationError, sameGenerationParameters, type GenerationClient, type GenerationModel, type GenerationParameters, type GenerationScope } from "@/services/saas/generation";
import { createCanvasImageGenerationController, createGenerationReceiptStore, type GenerationReceiptStore } from "@/services/saas/canvas-image-generation";
import { generationTracker, type GenerationTrackerRegistration } from "@/stores/use-generation-tracker";
import { imageGenerationSpec, validImageGenerationCount } from "../../../../packages/shared/src/model-price-publications";

// An association for workbench task recovery, not a canvas or cloud draft.
export const IMAGE_WORKBENCH_PROJECT_ID = "__image_workbench__";
type Tracker = { getState: () => { register: (value: GenerationTrackerRegistration) => void } };
export type PlatformImageInput = { modelId: string; mappingModelId?: string; mappingSpecification?: string; prompt: string; parameters: GenerationParameters; referenceCount: number; count: string; settingsReviewed: boolean };

/** Reuse the canvas request/receipt protocol; this session never creates canvas nodes. */
export function createWorkbenchImageSession(options: {
    scope: GenerationScope; getContext: () => GenerationScope | null;
    client?: GenerationClient; receipts?: Pick<GenerationReceiptStore, "put" | "list">; tracker?: Tracker; getInput?: () => PlatformImageInput; idempotencyKey?: string; originRoute?: string;
}) {
    let quotedInput: string | null = null;
    const client = options.client ?? createGenerationClient({ scope: options.scope, getScope: options.getContext });
    const controller = createCanvasImageGenerationController({ client, getContext: options.getContext,
        receiptStore: options.receipts ?? createGenerationReceiptStore(undefined, "infinite-canvas-workbench-image-receipts"),
        getIntentCurrent: () => quotedInput === null || !options.getInput || quotedInput === JSON.stringify(options.getInput()),
        createIdempotencyKey: options.idempotencyKey ? () => options.idempotencyKey! : undefined });
    const unsubscribe = controller.subscribe(() => {
        const state = controller.getState(), task = state.view?.task;
        if (!controller.isCurrent() || state.phase !== "tracking" || !task || state.receipt?.taskId !== task.id) return;
        (options.tracker ?? generationTracker).getState().register({ ...options.scope, taskId: task.id, modelId: task.modelId,
            originRoute: options.originRoute ?? "/image", kindHint: "image", executionStatus: task.executionStatus, deliveryStatus: task.deliveryStatus, billingStatus: task.billingStatus });
    });
    return { ...controller, models: () => client.models(),
        async prepare(input: PlatformImageInput, models: GenerationModel[]) {
            if (input.referenceCount) throw new GenerationError("unsupported_input", "此入口仅支持文字生图，请移除参考图后发送。", "not-sent");
            const model = models.find(item => item.id === input.modelId);
            if (model?.imagePricing?.protocol === "gemini-generate-content-v1") throw new GenerationError("unsupported_input", "此模型按实际张数结算，请在画布图片节点确认费用上限后生成。", "not-sent");
            const count = Number(input.count);
            if (!validImageGenerationCount(count) || count > (model?.maxImages ?? 1)) throw new GenerationError("unsupported_input", "张数超出所选模型已开放的范围，请重新选择。", "not-sent");
            const parameters = input.parameters as Parameters<typeof imageGenerationSpec>[0];
            if (!input.settingsReviewed || !model || (model.imagePricing
                ? !model.imagePricing.imageSpecs.some(spec => sameGenerationParameters(spec.parameters, imageGenerationSpec(parameters)))
                : Object.keys(input.parameters).length > 0)) throw new GenerationError("settings_required", "请主动核对并选择当前平台模型及完整规格；原个人参数不能直接作为平台规格。", "not-sent");
            quotedInput = JSON.stringify(input);
            return controller.prepare({ modelId: model.id, prompt: input.prompt, parameters: count === 1 ? input.parameters : { ...parameters, n: count } });
        },
        invalidateQuote() {
            const state = controller.getState();
            if (state.receipt) return;
            quotedInput = null;
            // Typing with no quote must not synchronously publish another React
            // update from every input layout effect (including portal effects).
            if (state.quote || state.phase === "preparing") controller.invalidateQuote();
        },
        close() { unsubscribe(); controller.close(); },
    };
}
export type WorkbenchImageSession = ReturnType<typeof createWorkbenchImageSession>;
