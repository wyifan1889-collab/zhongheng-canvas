import { expect, test } from "bun:test";
import type { AgentAttachment, AgentCanvasReference } from "@/stores/use-agent-store";
import { AGENT_MESSAGE_REFERENCE_LIMIT, AgentMessageReferenceError, acknowledgedAgentThreadId, countAgentDraftReferences, normalizeAgentDraftReferences, normalizeAgentMessageReferences, type AgentMessageReferencesInput } from "./message-references";

const image = "data:image/png;base64,c3ludGhldGlj";

test("T3 only an explicit valid turn acknowledgement permits clearing the submitted draft", () => {
    for (const value of [undefined, null, [], "<html>bad proxy</html>", {}, { ok: false, threadId: "thread" }, { ok: true }, { ok: true, threadId: 7 }, { ok: true, threadId: "  " }]) {
        expect(acknowledgedAgentThreadId(value)).toBeNull();
    }
    expect(acknowledgedAgentThreadId({ ok: true, threadId: " thread " })).toBe("thread");
});
const upload = (id: string, patch: Partial<AgentAttachment> = {}): AgentAttachment => ({ id, name: "same.png", type: "image/png", size: 9, width: 2, height: 2, url: "blob:synthetic", dataUrl: image, ...patch });
const reference = (nodeId: string, kind: AgentCanvasReference["kind"] = "image", patch: Partial<AgentCanvasReference> = {}): AgentCanvasReference => ({ nodeId, kind, label: "素材", title: "原标题", ...patch });
const carrier = (nodeId: string, patch: Partial<AgentAttachment> = {}) => upload(`canvas:${nodeId}`, patch);
function rejected(input: AgentMessageReferencesInput, code: AgentMessageReferenceError["code"], draft = false) {
    let failure: unknown;
    try { (draft ? normalizeAgentDraftReferences : normalizeAgentMessageReferences)(input); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AgentMessageReferenceError);
    expect((failure as AgentMessageReferenceError).code).toBe(code);
}

test("T3 missing arrays are empty; twelve independent upload identities remain twelve", () => {
    expect(AGENT_MESSAGE_REFERENCE_LIMIT).toBe(12);
    expect(normalizeAgentMessageReferences()).toEqual({ attachments: [], canvasReferences: [], count: 0 });
    const attachments = Array.from({ length: 12 }, (_, i) => upload(`upload-${i}`));
    const result = normalizeAgentMessageReferences({ attachments });
    expect(result.count).toBe(12);
    expect(result.attachments).toEqual(attachments);
    expect(result.attachments[0]).toBe(attachments[0]);
    rejected({ attachments: [...attachments, upload("upload-13")] }, "limit");
});

test("T3 twelve canvas images pair with twelve normalized carriers without the former six-image cap", () => {
    const canvasReferences = Array.from({ length: 12 }, (_, i) => reference(`node-${i}`));
    const attachments = canvasReferences.map(item => carrier(item.nodeId));
    const result = normalizeAgentMessageReferences({ attachments, canvasReferences });
    expect(result.count).toBe(12);
    expect(result.attachments).toHaveLength(12);
    expect(result.canvasReferences).toEqual(canvasReferences);
    rejected({ attachments: [...attachments, carrier("node-13")], canvasReferences: [...canvasReferences, reference("node-13")] }, "limit");
});

test("T3 mixed image/video/audio/text plus independent uploads share the same twelve-source limit", () => {
    const canvasReferences = (["image", "video", "audio", "text"] as const).flatMap(kind => [reference(`${kind}-a`, kind), reference(`${kind}-b`, kind)]);
    const attachments = [...canvasReferences.filter(item => item.kind === "image").map(item => carrier(item.nodeId)), ...Array.from({ length: 4 }, (_, i) => upload(`upload-${i}`))];
    expect(normalizeAgentMessageReferences({ canvasReferences, attachments }).count).toBe(12);
    rejected({ canvasReferences, attachments: [...attachments, upload("one-more")] }, "limit");
    rejected({ canvasReferences: Array.from({ length: 13 }, (_, i) => reference(`text-${i}`, "text")) }, "limit");
});

test("T3 duplicate node and carrier identities keep the first data and reach the engine only once", () => {
    const firstReference = reference(" node ", "image", { previewUrl: "blob:first", text: "original text" });
    const firstAttachment = carrier("node", { id: " canvas: node ", width: 7 });
    Object.freeze(firstReference); Object.freeze(firstAttachment);
    const result = normalizeAgentMessageReferences({
        canvasReferences: [firstReference, reference("node", "image", { title: "其他标题", previewUrl: "blob:other" })],
        attachments: [firstAttachment, carrier("node", { name: "other.png", width: 90, url: "blob:other" })],
    });
    expect(result.count).toBe(1);
    expect(result.canvasReferences).toEqual([{ ...firstReference, nodeId: "node" }]);
    expect(result.attachments).toEqual([{ ...firstAttachment, id: "canvas:node" }]);
    expect(firstReference.nodeId).toBe(" node ");
    expect(firstAttachment.id).toBe(" canvas: node ");
});

test("T3 raw repeated sources may exceed twelve entries but normalize before the limit", () => {
    const unique = Array.from({ length: 12 }, (_, i) => upload(`upload-${i}`));
    expect(normalizeAgentMessageReferences({ attachments: [...unique, ...unique] }).attachments).toHaveLength(12);
    const refs = Array.from({ length: 12 }, (_, i) => reference(`text-${i}`, "text"));
    expect(normalizeAgentMessageReferences({ canvasReferences: [...refs, ...refs] }).count).toBe(12);
});

test("T3 duplicate node kinds and duplicate attachment payload or type conflicts reject instead of overwriting", () => {
    for (const draft of [false, true]) {
        rejected({ canvasReferences: [reference(" node ", "text"), reference("node", "video")] }, "reference_conflict", draft);
        rejected({ attachments: [upload("same"), upload(" same ", { dataUrl: image + "changed" })] }, "attachment_conflict", draft);
        rejected({ attachments: [upload("same"), upload("same", { type: "image/jpeg" })] }, "attachment_conflict", draft);
        rejected({ canvasReferences: [reference("node")], attachments: [carrier("node"), carrier("node", { dataUrl: image + "changed" })] }, "attachment_conflict", draft);
    }
});

test("T3 forged canvas identities cannot make independent sources disappear from the count", () => {
    for (const draft of [false, true]) {
        rejected({ attachments: [carrier("missing")] }, "invalid_pair", draft);
        rejected({ canvasReferences: [reference("node", "text")], attachments: [carrier("node")] }, "invalid_pair", draft);
        rejected({ canvasReferences: [reference("node")], attachments: [carrier("")] }, "invalid_attachment", draft);
        const normalized = (draft ? normalizeAgentDraftReferences : normalizeAgentMessageReferences)({ canvasReferences: [reference("node")], attachments: [carrier(" node")] });
        expect(normalized.attachments[0].id).toBe("canvas:node");
        expect(normalized.count).toBe(1);
    }
    rejected({ canvasReferences: [reference("a"), reference("b")], attachments: [carrier("a"), carrier("a")] }, "missing_carrier");
});

test("T3 same-data independent uploads keep their identities and never remove a canvas carrier", () => {
    const canvasReferences = [reference("node")];
    const attachments = [upload("first"), upload("second"), carrier("node")];
    const result = normalizeAgentMessageReferences({ canvasReferences, attachments });
    expect(result.count).toBe(3);
    expect(result.attachments).toEqual(attachments);
    expect(result.attachments.map(item => item.id)).toEqual(["first", "second", "canvas:node"]);
});

test("T3 draft images need no carrier until send; draft count exposes thirteen without truncation", () => {
    const canvasReferences = Array.from({ length: 12 }, (_, i) => reference(`image-${i}`));
    expect(normalizeAgentDraftReferences({ canvasReferences }).count).toBe(12);
    rejected({ canvasReferences }, "missing_carrier");
    const oversized = [...canvasReferences, reference("image-13")];
    expect(countAgentDraftReferences({ canvasReferences: oversized })).toBe(13);
    rejected({ canvasReferences: oversized }, "limit", true);
});

test("T3 validating a proposed draft batch never mutates or silently truncates the original draft", () => {
    const attachments = Object.freeze(Array.from({ length: 11 }, (_, i) => Object.freeze(upload(`upload-${i}`))));
    const first = normalizeAgentDraftReferences({ attachments: [...attachments, upload("new-a")] });
    expect(first.count).toBe(12);
    rejected({ attachments: [...first.attachments, upload("new-b")] }, "limit", true);
    rejected({ attachments: [...attachments, upload("new-a"), upload("new-b")] }, "limit", true);
    expect(attachments).toHaveLength(11);
    expect(first.attachments).toHaveLength(12);
});

test("T3 supplied non-arrays, missing identities and invalid kinds reject rather than disappearing", () => {
    for (const field of ["attachments", "canvasReferences"] as const) {
        for (const value of [null, {}, "not-an-array", false, 12]) rejected({ [field]: value }, "invalid_array", true);
    }
    for (const nodeId of [undefined, null, 7, "", "   "]) rejected({ canvasReferences: [{ ...reference("node", "text"), nodeId }] }, "invalid_reference", true);
    for (const kind of [undefined, "config", 7]) rejected({ canvasReferences: [{ ...reference("node"), kind }] }, "invalid_reference", true);
    for (const id of [undefined, null, 7, "", "   "]) rejected({ attachments: [{ ...upload("one"), id }] }, "invalid_attachment", true);
    for (const type of [7, true, {}, []]) rejected({ attachments: [{ ...upload("one"), type }] }, "invalid_attachment", true);
    for (const dataUrl of [undefined, null, 7, "", "   ", "https://example.invalid/image.png", "data:text/plain;base64,YQ==", "data:image/png,YQ==", "data:image/png;base64,", "data:image/png;base64,a\nb"]) {
        rejected({ attachments: [{ ...upload("one"), dataUrl }] }, "invalid_attachment", true);
    }
    for (const type of [undefined, null, "", "   ", "text/plain", " image/jpeg", "image/jpeg", "image/"]) {
        const original = { ...upload("one"), type };
        const normalized = normalizeAgentMessageReferences({ attachments: [original] });
        expect(normalized.attachments[0].type).toBe(typeof type === "string" && type.startsWith("image/") ? type : "image/png");
        expect(original.type).toBe(type);
    }
    const derivedDuplicates = normalizeAgentMessageReferences({ attachments: [{ ...upload("same"), type: null }, { ...upload("same"), type: "text/plain" }, upload("same")] });
    expect(derivedDuplicates.attachments).toHaveLength(1);
    expect(derivedDuplicates.attachments[0].type).toBe("image/png");
    expect(normalizeAgentMessageReferences({ attachments: [upload("opaque", { dataUrl: "data:image/png;base64,not-valid-base64" })] }).count).toBe(1);
    rejected({ attachments: [null] }, "invalid_attachment", true);
    rejected({ canvasReferences: [null] }, "invalid_reference", true);
});

test("T3 malformed input objects reject, and normalization preserves all unrelated original data", () => {
    for (const input of [null, [], "bad", 1]) rejected(input as unknown as AgentMessageReferencesInput, "invalid_input", true);
    const attachment = { ...upload("one"), extension: { retained: ["opaque"] } };
    const ref = { ...reference("text", "text"), extension: true, text: "literal user text" };
    const result = normalizeAgentMessageReferences({ attachments: [attachment], canvasReferences: [ref] });
    expect(result.attachments[0]).toBe(attachment);
    expect(result.canvasReferences[0]).toBe(ref);
    expect(result.count).toBe(2);
});

test("T3 identities use the existing trimmed 200-character boundary with canvas carrier suffix normalization", () => {
    const id200 = "a".repeat(200), id201 = "a".repeat(201);
    const normalized = normalizeAgentMessageReferences({ attachments: [upload(` ${id200} `)], canvasReferences: [reference(` ${id200} `, "text")] });
    expect(normalized.attachments[0].id).toBe(id200);
    expect(normalized.canvasReferences[0].nodeId).toBe(id200);
    expect(normalized.count).toBe(2);
    for (const draft of [false, true]) {
        rejected({ attachments: [upload(` ${id201} `)] }, "invalid_attachment", draft);
        rejected({ canvasReferences: [reference(` ${id201} `, "text")] }, "invalid_reference", draft);
    }
    const imageId193 = "n".repeat(193), imageId200 = "n".repeat(200), imageId201 = "n".repeat(201);
    const paired = normalizeAgentMessageReferences({ canvasReferences: [reference(` ${imageId193} `)], attachments: [carrier(imageId193, { id: ` canvas:${imageId193} ` })] });
    expect(paired.attachments[0].id).toHaveLength(200);
    expect(paired.count).toBe(1);
    const longest = normalizeAgentMessageReferences({ canvasReferences: [reference(` ${imageId200} `)], attachments: [carrier(imageId200, { id: ` canvas: ${imageId200} ` })] });
    expect(longest.attachments[0].id).toBe(`canvas:${imageId200}`);
    expect(longest.attachments[0].id).toHaveLength(207);
    expect(longest.count).toBe(1);
    expect(normalizeAgentDraftReferences({ canvasReferences: [reference(imageId200)] }).count).toBe(1);
    rejected({ canvasReferences: [reference(imageId200)], attachments: [carrier(imageId201)] }, "invalid_attachment");
});
