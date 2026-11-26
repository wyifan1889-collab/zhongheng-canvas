import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import "@/i18n";
import { initialPlatformImageParameters, platformImageReferencePrice } from "@/components/creation/creation-platform-default";
import { workbenchImageMappings } from "@/pages/image/mapped-image-settings";
import { createWorkbenchImageSession } from "@/pages/image/platform-image-workbench";
import { HistoryDetailBody } from "@/pages/generation-history";
import { parseHistoryDetail } from "./generation-history-detail";
import type { GenerationModel } from "./generation";
import type { ImageMappingModel } from "./mapped-image-generation";
import { GEMINI_IMAGE_PROTOCOL as protocol, GEMINI_IMAGE_USAGE as usagePolicy } from "../../../../packages/shared/src/generation-gemini-image";

const id = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
const spec = { imageSize: "512", aspectRatio: "1:1" } as const;
const model: GenerationModel = { id: "native-model", displayName: "Gemini", capability: "image", group: null,
    imagePricing: { protocol, usagePolicy, billingUnit: "image_specs", creditsPerUnit: null, priceVersion: 3,
        imageSpecs: [{ parameters: spec, creditsPerImage: 7 }] } };
const native: ImageMappingModel = { id: "native", displayName: "Gemini", capability: "image", group: "Google", specifications: ["512"],
    combinations: [{ specification: "512", execution: { protocol, parameters: spec }, credits: 7, available: true, nodeModelId: model.id, priceVersion: 3 }] };
const fixed: ImageMappingModel = { ...native, id: "fixed", specifications: ["1K"], combinations: [{ ...native.combinations[0], specification: "1K",
    execution: { protocol: "openai-image-v1", parameters: { size: "1024x1024", quality: "medium" } } }] };

test("fixed-count consumers never match or quote a native budget as an ordinary image specification", async () => {
    expect(initialPlatformImageParameters(model)).toEqual({ model: model.id, imageModel: model.id });
    expect(platformImageReferencePrice([model], { imageModel: model.id })).toBeUndefined();
    expect(workbenchImageMappings([native, fixed])).toEqual([fixed]);
    const scope = { accountId: "synthetic", epoch: 1, projectId: "__image_workbench__" };
    const owner = createWorkbenchImageSession({ scope, getContext: () => scope });
    await expect(owner.prepare({ modelId: model.id, prompt: "synthetic", parameters: {}, count: "1", referenceCount: 0, settingsReviewed: true }, [model])).rejects.toMatchObject({ code: "unsupported_input" });
    expect(owner.getState().quote).toBeNull(); owner.close();
});

const media = (mediaId: string) => ({ mediaId, kind: "image", contentType: "image/png", sizeBytes: 100, etag: "a".repeat(64) });
function history() {
    return { task: { id, projectId: "original-project", modelId: model.id, priceVersion: 3, quotedUnits: 17,
        executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured", billingUnitSnapshot: "image", creditsPerUnitSnapshot: 7,
        geminiImage: { protocol, usagePolicy, parameters: { protocol, ...spec, budgetCredits: 17 }, creditsPerImage: 7 },
        billing: { reservedCredits: "17", capturedCredits: "14", releasedCredits: "3" } },
        result: { taskId: id, status: "succeeded", consumedUnits: 2, resultSnapshot: { kind: "image", media: media(id), imageMedia: [media(id), media(second)] } } };
}

test("global history preserves original native specification, delivered count, budget and all three ledger amounts", () => {
    const parsed = parseHistoryDetail(history(), id)!;
    expect(parsed.task.geminiImage?.parameters).toEqual({ protocol, ...spec, budgetCredits: 17 });
    expect(parsed.result?.resultSnapshot.imageMedia).toHaveLength(2);
    const html = renderToStaticMarkup(<HistoryDetailBody detail={parsed} onPreview={() => {}} onPreviewError={() => {}} />);
    for (const text of ["512", "1:1", "每张单价", "7 积分", "原费用上限", "17 积分", "已交付张数", "原任务实扣", "14", "已退回积分", "3"]) expect(html).toContain(text);
});

test("native history rejects changed budgets, missing/duplicated images and contradictory settlement evidence", () => {
    for (const mutate of [
        (v: any) => { v.task.geminiImage.parameters.budgetCredits = 18; },
        (v: any) => { v.task.creditsPerUnitSnapshot = 8; },
        (v: any) => { v.task.billing.releasedCredits = "10"; },
        (v: any) => { v.task.billing.capturedCredits = "14.1"; },
        (v: any) => { delete v.result.resultSnapshot.imageMedia; },
        (v: any) => { v.result.resultSnapshot.imageMedia[1] = v.result.resultSnapshot.imageMedia[0]; },
        (v: any) => { delete v.task.geminiImage; },
    ]) { const value = history(); mutate(value); expect(parseHistoryDetail(value, id)).toBeNull(); }
    const pending = history(); pending.task.executionStatus = "unknown"; pending.task.deliveryStatus = "unknown"; pending.task.billingStatus = "pending_review";
    pending.task.billing = { reservedCredits: "17", capturedCredits: "0", releasedCredits: "0" };
    expect(parseHistoryDetail({ task: pending.task, result: null }, id)?.task.billing).toEqual(pending.task.billing);
});
