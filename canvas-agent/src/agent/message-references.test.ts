import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMessageReferences } from "./message-references.js";

// These are synthetic protocol carriers, not image-integrity or provider evidence.
const png = "data:image/png;base64,YQ==";
const otherPng = "data:image/png;base64,Yg==";
type Kind = "image" | "video" | "audio" | "text";
const attachment = (id: string, dataUrl = png, type: string | null = "image/png") => ({ id, name: "synthetic.png", ...(type === null ? {} : { type }), dataUrl });
const reference = (nodeId: string, kind: Kind = "text") => ({ nodeId, kind, label: "Synthetic reference", title: "Synthetic material" });
const uploads = (count: number) => Array.from({ length: count }, (_, index) => attachment(`upload-${index}`));
const references = (count: number, kind: Kind = "text") => Array.from({ length: count }, (_, index) => reference(`node-${index}`, kind));
const carriers = (count: number) => Array.from({ length: count }, (_, index) => attachment(`canvas:node-${index}`));

const accepted: Array<{ name: string; attachments?: unknown; metadata?: unknown; total: number; carriers: number }> = [
    { name: "no arrays", total: 0, carriers: 0 },
    { name: "absent null metadata", metadata: null, total: 0, carriers: 0 },
    { name: "empty arrays", attachments: [], metadata: { canvasReferences: [] }, total: 0, carriers: 0 },
    { name: "twelve independent uploads", attachments: uploads(12), total: 12, carriers: 12 },
    { name: "twelve paired canvas images", attachments: carriers(12), metadata: { canvasReferences: references(12, "image") }, total: 12, carriers: 12 },
    { name: "mixed eight references plus four uploads", attachments: [attachment("canvas:node-0"), attachment("canvas:node-4"), ...uploads(4)],
        metadata: { canvasReferences: Array.from({ length: 8 }, (_, index) => reference(`node-${index}`, (["image", "video", "audio", "text"] as const)[index % 4])) }, total: 12, carriers: 6 },
    { name: "duplicate node identity ignores display differences", metadata: { canvasReferences: [reference(" node-0 "), { ...reference("node-0"), title: "Another display title" }] }, total: 1, carriers: 0 },
    { name: "same upload identity and inferred MIME", attachments: [attachment(" upload-0 ", png, null), attachment("upload-0")], total: 1, carriers: 1 },
    { name: "same canvas identity and carrier", attachments: [attachment(" canvas: node-0 ", png, null), attachment("canvas:node-0")],
        metadata: { canvasReferences: [reference(" node-0 ", "image"), reference("node-0", "image")] }, total: 1, carriers: 1 },
    { name: "same bytes keep two upload identities", attachments: [attachment("upload-a"), attachment("upload-b")], total: 2, carriers: 2 },
    { name: "same bytes keep upload and canvas identities", attachments: [attachment("upload-a"), attachment("canvas:node-0")],
        metadata: { canvasReferences: [reference("node-0", "image")] }, total: 2, carriers: 2 },
    { name: "historical display metadata is not a third reference list", attachments: uploads(12),
        metadata: { attachments: uploads(12).map(({ dataUrl, ...item }) => ({ ...item, url: dataUrl })) }, total: 12, carriers: 12 },
];
for (const scenario of accepted) test(`reference contract accepts ${scenario.name}`, () => {
    const result = normalizeMessageReferences(scenario.attachments, scenario.metadata);
    assert.equal(result.total, scenario.total);
    assert.equal(result.attachments.length, scenario.carriers);
});

for (const scenario of [
    { name: "thirteen independent uploads", attachments: uploads(13), metadata: undefined },
    { name: "thirteen distinct references", attachments: [], metadata: { canvasReferences: references(13) } },
    { name: "thirteen paired canvas images", attachments: carriers(13), metadata: { canvasReferences: references(13, "image") } },
    { name: "eight mixed references plus five uploads", attachments: [attachment("canvas:node-0"), attachment("canvas:node-4"), ...uploads(5)],
        metadata: { canvasReferences: Array.from({ length: 8 }, (_, index) => reference(`node-${index}`, (["image", "video", "audio", "text"] as const)[index % 4])) } },
]) test(`reference contract rejects ${scenario.name} with the shared limit error`, () => {
    assert.throws(() => normalizeMessageReferences(scenario.attachments, scenario.metadata), { message: "参考素材最多 12 个" });
});

const rejected: Array<{ name: string; attachments?: unknown; metadata?: unknown }> = [
    { name: "non-array attachments", attachments: {} },
    { name: "null attachments", attachments: null },
    { name: "non-array canvas references", metadata: { canvasReferences: {} } },
    { name: "null canvas references", metadata: { canvasReferences: null } },
    { name: "array message metadata", metadata: [] },
    { name: "scalar message metadata", metadata: "invalid" },
    { name: "empty attachment id", attachments: [attachment(" ")] },
    { name: "missing attachment id", attachments: [{ dataUrl: png }] },
    { name: "non-object attachment", attachments: [null] },
    { name: "empty reference id", metadata: { canvasReferences: [reference(" ")] } },
    { name: "missing reference id", metadata: { canvasReferences: [{ kind: "text" }] } },
    { name: "non-object reference", metadata: { canvasReferences: [null] } },
    { name: "unsupported reference kind", metadata: { canvasReferences: [{ ...reference("node-0"), kind: "config" }] } },
    { name: "non-string reference kind", metadata: { canvasReferences: [{ ...reference("node-0"), kind: ["image"] }] } },
    { name: "object reference kind", metadata: { canvasReferences: [{ ...reference("node-0"), kind: { value: "image" } }] } },
    { name: "same node with conflicting kinds", metadata: { canvasReferences: [reference(" node-0 ", "image"), reference("node-0", "text")] } },
    { name: "same upload id with different data", attachments: [attachment("upload-0"), attachment(" upload-0 ", otherPng)] },
    { name: "same upload id with conflicting MIME", attachments: [attachment("upload-0"), attachment("upload-0", png, "image/jpeg")] },
    { name: "same canvas carrier with different data", attachments: [attachment("canvas:node-0"), attachment("canvas: node-0", otherPng)], metadata: { canvasReferences: [reference("node-0", "image")] } },
    { name: "canvas carrier without a reference", attachments: [attachment("canvas:node-0")] },
    { name: "canvas carrier paired with non-image", attachments: [attachment("canvas:node-0")], metadata: { canvasReferences: [reference("node-0", "video")] } },
    { name: "image reference without its carrier", metadata: { canvasReferences: [reference("node-0", "image")] } },
    { name: "an independent upload cannot replace a canvas carrier", attachments: [attachment("upload-0")], metadata: { canvasReferences: [reference("node-0", "image")] } },
    { name: "empty canvas source id", attachments: [attachment("canvas: ")] },
    { name: "non-image attachment cannot disappear in the session filter", attachments: [attachment("upload-0", "data:text/plain;base64,YQ==", "text/plain")] },
    { name: "missing data cannot disappear in the session filter", attachments: [{ id: "upload-0" }] },
    { name: "unparseable existing image dataURL", attachments: [attachment("upload-0", "data:image/png,YQ==")] },
];
for (const scenario of rejected) test(`reference contract rejects ${scenario.name}`, () => {
    assert.throws(() => normalizeMessageReferences(scenario.attachments, scenario.metadata));
});

test("normalization preserves first-source order, other fields and the caller's raw inputs", () => {
    const rawAttachments = [attachment(" upload-0 ", png, null), { ...attachment("upload-0"), name: "second display name" }];
    const rawMetadata = { canvasReferences: [reference(" node-0 "), { ...reference("node-0"), label: "second display label" }],
        attachments: [{ id: "display-only", name: "Display only", url: png }], skill: { name: "synthetic-skill", path: "synthetic/SKILL.md" } };
    const before = structuredClone({ rawAttachments, rawMetadata });
    const result = normalizeMessageReferences(rawAttachments, rawMetadata);
    assert.deepEqual(result.attachments, [{ ...attachment("upload-0"), name: "synthetic.png" }]);
    assert.deepEqual(result.messageMetadata, { ...rawMetadata, canvasReferences: [reference("node-0")] });
    assert.deepEqual({ rawAttachments, rawMetadata }, before);
    assert.notEqual(result.attachments[0], rawAttachments[0]);
});

test("identity boundaries reuse the existing metadata limit without truncating distinct sources", () => {
    // Existing metadata identities are 200 characters; canvas: adds only its seven-character carrier prefix.
    const id = "n".repeat(200);
    assert.equal(normalizeMessageReferences([attachment(id)], undefined).attachments[0].id, id);
    const result = normalizeMessageReferences([attachment(`canvas:${id}`)], { canvasReferences: [reference(id, "image")] });
    assert.equal(result.attachments[0].id, `canvas:${id}`);
    assert.equal(result.attachments[0].id?.length, 207);
    for (const source of [`${id}a`, `${id}b`]) {
        assert.throws(() => normalizeMessageReferences([attachment(source)], undefined));
        assert.throws(() => normalizeMessageReferences([], { canvasReferences: [reference(source)] }));
        assert.throws(() => normalizeMessageReferences([attachment(`canvas:${source}`)], { canvasReferences: [reference(source, "image")] }));
    }
});

test("MIME fallback follows the existing session and does not add a new base64 decoder or format policy", () => {
    const jpeg = "data:image/jpeg;base64,YQ==";
    assert.equal(normalizeMessageReferences([attachment("upload-0", jpeg, null)], undefined).attachments[0].type, "image/jpeg");
    assert.equal(normalizeMessageReferences([attachment("upload-0", png, "text/plain")], undefined).attachments[0].type, "image/png");
    assert.equal(normalizeMessageReferences([attachment("upload-0", "data:image/png;base64,synthetic-protocol-payload")], undefined).total, 1);
});
