import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import MappingExecutionFields, { executionFromInput, executionInput } from "./components/MappingExecutionFields";
import { addMapping, mappingParameterLabel } from "./model-mapping-plan";
import { emptyMappingDraft } from "../../../../packages/shared/src/model-mapping-drafts";
import { GEMINI_IMAGE_PROTOCOL as protocol } from "../../../../packages/shared/src/generation-gemini-image";
import { GeminiImageHistory } from "../../components/canvas/canvas-platform-image-modal";
import type { GenerationTaskView } from "../../services/saas/generation";

test("admin native editor roundtrips supported fields and rejects a tier from another model", () => {
    const binding = { providerId: "native", providerModel: "gemini-3.1-flash-image-preview", modelId: "flash", specification: "512",
        execution: { protocol, parameters: { imageSize: "512", aspectRatio: "8:1" } } } as const;
    const value = executionInput(binding);
    expect(executionFromInput(value, "image", "512", binding.providerModel)).toEqual(binding.execution);
    expect(executionFromInput(value, "image", "512", "gemini-3-pro-image-preview")).toBeNull();
    expect(mappingParameterLabel(binding)).toBe("512 · 8:1 · 按交付张数");
    const markup = renderToStaticMarkup(<MappingExecutionFields capability="image" specification="512" providerModel={binding.providerModel} value={value} onChange={() => {}} />);
    expect(markup).toContain("原生图片比例"); expect(markup).not.toContain("渠道单次张数上限"); expect(markup).not.toContain("图片返回方式");
    expect(() => addMapping(emptyMappingDraft(), { ...binding, providerModel: "grok-image", providerName: "Synthetic", available: true, providerEnabled: true },
        { id: "flash", displayName: "Flash", capability: "image", group: "Google" }, "512", binding.execution)).toThrow("精确型号");
});
test("original Gemini history shows delivered count and original ledger, without current prices", () => {
    const task = { geminiImage: { protocol, usagePolicy: "delivered_images", parameters: { protocol, aspectRatio: "16:9", imageSize: "1K", budgetCredits: 17 }, creditsPerImage: 7 },
        priceVersion: 3, billing: { reservedCredits: "17", capturedCredits: "14", releasedCredits: "3" } } as GenerationTaskView["task"];
    const markup = renderToStaticMarkup(<GeminiImageHistory task={task} delivered={2} />);
    for (const text of ["1K", "16:9", "每张 7 积分", "原预算 17 积分", "已交付 2 张", "预留 17", "实扣 14", "退回 3"]) expect(markup).toContain(text);
});
