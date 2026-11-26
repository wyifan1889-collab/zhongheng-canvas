import { expect, test } from "bun:test";
import i18n from "@/i18n";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import type { ReferenceImage } from "@/types/image";
import { creationReferenceCandidates, reindexCreationReferences, removeCreationReference } from "./creation-reference-prompt";

const references: ReferenceImage[] = Array.from({ length: 12 }, (_, index) => ({ id: `upload-${index}`, name: `${index}.png`, type: "image/png", dataUrl: `data:image/png;base64,${index}` }));

test("home mention candidates preserve the actual reference array order and the original image request labels", () => {
    const candidates = creationReferenceCandidates(references);
    expect(candidates).toHaveLength(12);
    expect(candidates.map(item => item.nodeId)).toEqual(references.map(item => item.id));
    expect(candidates.map(item => item.previewUrl)).toEqual(references.map(item => item.dataUrl));
    for (let index = 0; index < references.length; index++) expect(candidates[index].label).toBe(imageReferenceLabel(index));
    const prompt = `保留${candidates[9].label}的主体`;
    expect(buildImageReferencePromptText(prompt, references)).toContain(prompt);
    expect(buildImageReferencePromptText(prompt, references)).toContain(candidates[11].label);
});

test("removing a preceding image updates mentions to the same image, without splitting labels 1 and 10", () => {
    const prompt = `${imageReferenceLabel(0)} + ${imageReferenceLabel(9)} + ${imageReferenceLabel(11)}`;
    const next = removeCreationReference(prompt, references, references[0].id);
    expect(next.references).toEqual(references.slice(1));
    expect(next.prompt).toBe(` + ${imageReferenceLabel(8)} + ${imageReferenceLabel(10)}`);
    expect(creationReferenceCandidates(next.references)[8].id).toBe(references[9].id);
    expect(references).toHaveLength(12);
});

test("deleting the only image removes its mention while preserving the rest of the prompt", () => {
    expect(removeCreationReference(`主体 ${imageReferenceLabel(0)}，保持构图`, references.slice(0, 1), references[0].id)).toEqual({ prompt: "主体 ，保持构图", references: [] });
    expect(removeCreationReference("没有参考图的文本", [], "missing")).toEqual({ prompt: "没有参考图的文本", references: [] });
});

test("removing an unrelated id keeps all references and prompt text unchanged", () => {
    const prompt = `${imageReferenceLabel(11)} 原文`;
    expect(removeCreationReference(prompt, references, "missing")).toEqual({ prompt, references });
});

test("moving the fourteenth source preserves its identity in mentions without changing longer unmatched text", () => {
    const draft = Array.from({ length: 14 }, (_, index) => ({ id: `ordered-${index}`, name: `${index}.png`, type: "image/png", dataUrl: `data:image/png;base64,${index}` }));
    const reordered = [draft[13], ...draft.slice(0, 13)];
    const result = reindexCreationReferences(`${imageReferenceLabel(13)}与${imageReferenceLabel(0)}，印字${imageReferenceLabel(139)}`, draft, reordered);
    expect(result.prompt).toBe(`${imageReferenceLabel(0)}与${imageReferenceLabel(1)}，印字${imageReferenceLabel(139)}`);
    expect(result.references).toEqual(reordered);
    expect(result.references[0].id).toBe(draft[13].id);
    expect(draft[0].id).toBe("ordered-0");
});

test.each(["zh-CN", "en-US"])("fourteen-image drafts renumber the same thirteenth and fourteenth sources after removal in %s", async locale => {
    const previousLocale = i18n.language;
    try {
        await i18n.changeLanguage(locale);
        const draft = Array.from({ length: 14 }, (_, index) => ({ id: `draft-${index}`, name: `${index}.png`, type: "image/png", dataUrl: `data:image/png;base64,${index}` }));
        const next = removeCreationReference(`${imageReferenceLabel(12)}与${imageReferenceLabel(13)}；印字${imageReferenceLabel(139)}`, draft, draft[0].id);
        expect(next.references).toHaveLength(13);
        expect(next.prompt).toBe(`${imageReferenceLabel(11)}与${imageReferenceLabel(12)}；印字${imageReferenceLabel(139)}`);
        expect(creationReferenceCandidates(next.references)[12].nodeId).toBe(draft[13].id);
        expect(draft).toHaveLength(14);
    } finally { await i18n.changeLanguage(previousLocale); }
});

test.each(["zh-CN", "en-US"])("removing images keeps unmatched longer numbered text intact in %s", async locale => {
    const previousLocale = i18n.language;
    try {
        await i18n.changeLanguage(locale);
        const prompt = `包装正面写‘${imageReferenceLabel(9)}’，侧面写‘${imageReferenceLabel(11)}’；保留${imageReferenceLabel(99)}原文。`;
        const next = removeCreationReference(prompt, references.slice(0, 2), references[0].id);
        expect(next.prompt).toBe(prompt);
        expect(next.references).toEqual(references.slice(1, 2));
    } finally { await i18n.changeLanguage(previousLocale); }
});

test.each(["zh-CN", "en-US"])("real double-digit references renumber while unmatched text stays unchanged in %s", async locale => {
    const previousLocale = i18n.language;
    try {
        await i18n.changeLanguage(locale);
        const prompt = `${imageReferenceLabel(9)}与${imageReferenceLabel(11)}；印字${imageReferenceLabel(99)}`;
        const next = removeCreationReference(prompt, references, references[0].id);
        expect(next.prompt).toBe(`${imageReferenceLabel(8)}与${imageReferenceLabel(10)}；印字${imageReferenceLabel(99)}`);
        expect(creationReferenceCandidates(next.references)[8].id).toBe(references[9].id);
    } finally { await i18n.changeLanguage(previousLocale); }
});
