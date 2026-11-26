import { describe, expect, test } from "bun:test";
import type { CanvasProject } from "../../stores/canvas/use-canvas-store";
import { inspectCanvasDocument, prepareCanvasDocumentForCloudSave } from "./canvas-document";

function fixture(): CanvasProject {
    return {
        id: "synthetic-project", title: "完整原版画布", createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T01:00:00.000Z",
        nodes: ["text", "image", "video", "audio", "config", "group", "synthetic-plugin:note"].map((type, index) => ({
            id: `node-${index}`, type, title: type, position: { x: index * 100, y: 25 }, width: 300, height: 200,
            metadata: { content: type === "text" ? "原版文本内容" : "", groupId: index < 5 ? "node-5" : undefined },
        })),
        connections: [{ id: "connection-1", fromNodeId: "node-0", toNodeId: "node-1" }],
        chatSessions: [{ id: "chat-1", title: "助手", createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T01:00:00.000Z", messages: [
            { id: "message-1", role: "assistant", text: "保留上下文", detail: { nested: [false, 0, null, "扩展数据"] }, references: [] },
        ] }],
        activeChatId: "chat-1", backgroundMode: "lines", showImageInfo: true, viewport: { x: 10, y: 20, k: 0.8 },
    };
}

describe("original canvas document preflight: no storage, upload, session or cloud-save claim", () => {
    test("preserves the node platform model and complete specification in a cloud snapshot", () => {
        const project = fixture(), selection = { modelId: "image-2.5", specification: "1K", combination: '["1K","complete-parameters"]' };
        project.nodes[1].metadata!.platformImageSelection = selection;
        const saved = inspectCanvasDocument(project);
        expect((saved.snapshot.nodes as any[])[1].metadata.platformImageSelection).toEqual(selection);
        expect(saved.mediaReferences).toHaveLength(0);
    });
    test("keeps every original project field and JSON extensions without changing the input", () => {
        const source = fixture();
        Object.assign(source, { extension: { future: ["unchanged", { version: 4 }] } });
        Object.assign(source.nodes[6].metadata!, { pluginSettings: { palette: "amber", custom: [1, null, true] } });
        const before = structuredClone(source);
        const result = inspectCanvasDocument(source);
        expect(source).toEqual(before);
        expect(result.snapshot).toEqual(JSON.parse(JSON.stringify(source)));
        expect(JSON.parse(JSON.stringify(result.snapshot))).toEqual(result.snapshot);
        expect(result.snapshot).not.toBe(source);
        expect(result.snapshot.nodes).not.toBe(source.nodes);
        expect(result.status).toBe("inspection-only");
        expect(result).not.toHaveProperty("saved");
        expect(result).not.toHaveProperty("cloudSaveReady");
        expect(result.omittedOptionalPaths).toEqual(["/nodes/5/metadata/groupId", "/nodes/6/metadata/groupId"]);
        expect(result.mediaReferences).toEqual([]);
    });
    test("reports image/video/audio, string references, assistant and plugin media without resolving anything", () => {
        const source = fixture();
        source.nodes[1].metadata = { storageKey: "image:primary", content: "blob:https://synthetic.example/image", images: [
            { id: "image-2", status: "success", content: "data:image/png;base64,synthetic", storageKey: "image:second", naturalWidth: 10, naturalHeight: 20, bytes: 9, mimeType: "image/png" },
        ], references: ["image:reference-only", "video-reference:source", "audio-reference:source"] };
        source.nodes[2].metadata = { storageKey: "video:movie", content: "blob:https://synthetic.example/video" };
        source.nodes[3].metadata = { storageKey: "audio:voice", content: "file:///synthetic/voice.mp3" };
        source.chatSessions[0].messages[0].references = [{ id: "ref-1", type: "image", title: "附件", storageKey: "image:chat", dataUrl: "blob:https://synthetic.example/chat" }];
        Object.assign(source.nodes[6].metadata!, { plugin: { storageKey: "plugin-custom:asset", references: ["file:plugin-file"] } });
        const result = inspectCanvasDocument(source);
        expect(result.mediaReferences.filter((item) => item.kind === "storage-key").map((item) => item.storageKey)).toEqual([
            "image:primary", "image:second", "image:reference-only", "video-reference:source", "audio-reference:source", "video:movie", "audio:voice", "plugin-custom:asset", "file:plugin-file", "image:chat",
        ]);
        expect(result.mediaReferences).toContainEqual({ kind: "data-url", path: "/nodes/1/metadata/images/0/content" });
        expect(result.mediaReferences).toContainEqual({ kind: "file-url", path: "/nodes/3/metadata/content" });
        expect(result.mediaReferences).toContainEqual({ kind: "blob-url", path: "/chatSessions/0/messages/0/references/0/dataUrl" });
        expect(result.snapshot).toEqual(JSON.parse(JSON.stringify(source)));
        // A reference does not prove a local Blob exists, or that any server owns/uploaded it.
        expect(result.status).toBe("inspection-only");
        expect(result).not.toHaveProperty("mediaAvailable");
    });
    test("treats in-flight video tasks as unresolved media and never as ordinary JSON", () => {
        const source = fixture();
        source.nodes[2].metadata = { content: "", status: "loading", videoTaskId: "video-task-private" };
        const result = inspectCanvasDocument(source);
        expect(result.mediaReferences).toContainEqual({ kind: "video-task", path: "/nodes/2/metadata/videoTaskId", videoTaskId: "video-task-private" });
    });
    test("records cloud media IDs as unresolved account references until ownership is verified", () => {
        const source = fixture();
        source.nodes[1].metadata = { cloudMediaId: "11111111-1111-4111-8111-111111111111" };
        source.nodes[2].metadata = { cloudMediaId: "not-a-uuid" };
        source.chatSessions[0].messages[0].references = [{ id: "cloud-ref", type: "image", title: "云端图片", cloudMediaId: "22222222-2222-4222-8222-222222222222" }];
        const result = inspectCanvasDocument(source);
        expect(result.mediaReferences.filter((item) => item.kind === "cloud-media")).toEqual([
            { kind: "cloud-media", path: "/nodes/1/metadata/cloudMediaId", cloudMediaId: "11111111-1111-4111-8111-111111111111" },
            { kind: "cloud-media", path: "/nodes/2/metadata/cloudMediaId", cloudMediaId: "not-a-uuid" },
            { kind: "cloud-media", path: "/chatSessions/0/messages/0/references/0/cloudMediaId", cloudMediaId: "22222222-2222-4222-8222-222222222222" },
        ]);
    });
    test("cloud-save payload strips tab-local previews but retains cloud media IDs", () => {
        const source = fixture();
        source.nodes[1].metadata = { cloudMediaId: "11111111-1111-4111-8111-111111111111", content: "blob:private-preview", storageKey: "image:old" };
        source.chatSessions[0].messages[0].references = [{ id: "cloud-ref", type: "image", title: "云端图片", cloudMediaId: "11111111-1111-4111-8111-111111111111", dataUrl: "blob:chat-preview", storageKey: "image:chat" }];
        const inspection = inspectCanvasDocument(source), prepared = prepareCanvasDocumentForCloudSave(inspection);
        expect(prepared.mediaReferences).toEqual([
            { kind: "cloud-media", path: "/nodes/1/metadata/cloudMediaId", cloudMediaId: "11111111-1111-4111-8111-111111111111" },
            { kind: "cloud-media", path: "/chatSessions/0/messages/0/references/0/cloudMediaId", cloudMediaId: "11111111-1111-4111-8111-111111111111" },
        ]);
        expect((prepared.snapshot.nodes as any[])[1].metadata).toEqual({ cloudMediaId: "11111111-1111-4111-8111-111111111111", content: "" });
        expect((prepared.snapshot.chatSessions as any[])[0].messages[0].references[0]).toEqual({ id: "cloud-ref", type: "image", title: "云端图片", cloudMediaId: "11111111-1111-4111-8111-111111111111", dataUrl: "" });
        expect(source.nodes[1].metadata).toEqual({ cloudMediaId: "11111111-1111-4111-8111-111111111111", content: "blob:private-preview", storageKey: "image:old" });
    });
    test("detects remote media URLs without treating text prompts as media", () => {
        const source = fixture();
        source.nodes[0].metadata = { content: "https://example.invalid/text-prompt" };
        source.nodes[1].metadata = { content: "https://example.invalid/image", images: [{ content: "https://example.invalid/variant" }] };
        source.nodes[6].metadata = { url: "https://example.invalid/plugin-media" };
        source.chatSessions[0].messages[0].references = [{ id: "remote", type: "image", title: "远程附件", dataUrl: "https://example.invalid/chat" }];
        const result = inspectCanvasDocument(source);
        expect(result.mediaReferences.filter((item) => item.kind === "remote-url")).toEqual([
            { kind: "remote-url", path: "/nodes/1/metadata/content" },
            { kind: "remote-url", path: "/nodes/1/metadata/images/0/content" },
            { kind: "remote-url", path: "/nodes/6/metadata/url" },
            { kind: "remote-url", path: "/chatSessions/0/messages/0/references/0/dataUrl" },
        ]);
    });
    test("allows only declared optional undefined fields and reports each omission", () => {
        const source = fixture();
        source.nodes[0].metadata = undefined;
        source.nodes[1].metadata = { errorDetails: undefined, images: [{ id: "i", status: "idle", content: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "", storageKey: undefined }] };
        source.chatSessions[0].messages[0].detail = undefined;
        const result = inspectCanvasDocument(source);
        expect(result.omittedOptionalPaths).toContain("/nodes/0/metadata");
        expect(result.omittedOptionalPaths).toContain("/nodes/1/metadata/errorDetails");
        expect(result.omittedOptionalPaths).toContain("/nodes/1/metadata/images/0/storageKey");
        expect(result.omittedOptionalPaths).toContain("/chatSessions/0/messages/0/detail");
        expect(Object.hasOwn(source.nodes[1].metadata!, "errorDetails")).toBe(true);
        for (const invalid of [{ pluginField: undefined }, { pluginField: [undefined] }]) {
            Object.assign(source.nodes[6].metadata!, invalid);
            expect(() => inspectCanvasDocument(source)).toThrow(expect.objectContaining({ code: "non_json_value" }));
        }
    });
    test("rejects lossy/non-JSON extension values without changing them or invoking toJSON", () => {
        let calls = 0;
        class RewritingArray extends Array { toJSON() { calls++; return []; } }
        for (const value of [undefined, NaN, Infinity, -Infinity, 1n, () => {}, Symbol("x"), new Date(), new Map(), new Set(), new Blob(["synthetic"]), { toJSON() { calls++; return {}; } }, new RewritingArray("would-disappear")]) {
            const source = fixture();
            Object.assign(source.nodes[6].metadata!, { unsupported: value });
            expect(() => inspectCanvasDocument(source)).toThrow(expect.objectContaining({ code: "non_json_value" }));
            expect((source.nodes[6].metadata as Record<string, unknown>).unsupported).toBe(value);
        }
        expect(calls).toBe(0);
    });
    test("rejects cyclic data, sparse/extended arrays, symbols, non-enumerable properties and getters", () => {
        let getterCalls = 0;
        const cycle: Record<string, unknown> = {}; cycle.self = cycle;
        const extended = [1]; Object.assign(extended, { custom: true });
        const symbol = { [Symbol("metadata")]: 1 };
        const hidden = Object.defineProperty({}, "hidden", { value: 1 });
        const getter = Object.defineProperty({}, "value", { enumerable: true, get() { getterCalls++; return 1; } });
        for (const value of [cycle, new Array(1), extended, symbol, hidden, getter]) {
            const source = fixture();
            source.chatSessions[0].messages[0].detail = value;
            expect(() => inspectCanvasDocument(source)).toThrow(expect.objectContaining({ code: "non_json_value" }));
        }
        expect(getterCalls).toBe(0);
    });
    test("supports shared JSON references and dangerous-looking property names as inert data", () => {
        const shared = { value: "same" };
        const source = fixture();
        source.chatSessions[0].messages[0].detail = { left: shared, right: shared, extension: JSON.parse('{"__proto__":{"polluted":true}}') };
        const result = inspectCanvasDocument(source);
        expect(result.snapshot).toEqual(JSON.parse(JSON.stringify(source)));
        expect(Object.prototype).not.toHaveProperty("polluted");
    });
    test("reports escaped paths for unsupported extension values without echoing their content", () => {
        const source = fixture();
        Object.assign(source.nodes[6].metadata!, { "custom/name~field": undefined });
        expect(() => inspectCanvasDocument(source)).toThrow(expect.objectContaining({ code: "non_json_value", path: "/nodes/6/metadata/custom~1name~0field" }));
    });
    test("rejects unknown document versions and incomplete project envelopes, without repairing them", () => {
        for (const version of [0, 2, "1", null]) expect(() => inspectCanvasDocument(fixture(), version)).toThrow(expect.objectContaining({ code: "unsupported_version" }));
        for (const value of [{}, [], null, { ...fixture(), nodes: null }, { ...fixture(), viewport: {} }, { ...fixture(), showImageInfo: null }]) {
            expect(() => inspectCanvasDocument(value)).toThrow(expect.objectContaining({ code: "invalid_project" }));
        }
    });
    test("durable platform text guards round trip as exact JSON without becoming media references", () => {
        const source = fixture(), guardId = "11111111-1111-4111-8111-111111111111", taskId = "22222222-2222-4222-8222-222222222222";
        source.nodes[0].metadata = { content: "保留用户正文", platformTextRequests: [{ guardId, edited: true }, { guardId: taskId, edited: false, taskId }] };
        const result = inspectCanvasDocument(source);
        expect((result.snapshot.nodes as any[])[0].metadata).toEqual(source.nodes[0].metadata);
        expect(result.mediaReferences).toEqual([]);
        expect(source.nodes[0].metadata.platformTextRequests![0].edited).toBe(true);
        source.nodes[0].metadata.platformTextRequests = undefined;
        expect(inspectCanvasDocument(source).omittedOptionalPaths).toContain("/nodes/0/metadata/platformTextRequests");
    });
    test("reserved text guard arrays reject malformed values and nested undefined rather than silently dropping protection", () => {
        const guardId = "11111111-1111-4111-8111-111111111111";
        for (const invalid of [[{ guardId, edited: "false" }], [{ guardId, edited: false, extra: true }], [{ guardId, edited: false }, { guardId, edited: true }], null]) {
            const source = fixture();
            Object.assign(source.nodes[0].metadata!, { platformTextRequests: invalid });
            expect(() => inspectCanvasDocument(source)).toThrow(expect.objectContaining({ code: "invalid_project", path: "/nodes/0/metadata/platformTextRequests" }));
        }
        const source = fixture();
        Object.assign(source.nodes[0].metadata!, { platformTextRequests: [{ guardId, edited: false, taskId: undefined }] });
        expect(() => inspectCanvasDocument(source)).toThrow(expect.objectContaining({ code: "non_json_value", path: "/nodes/0/metadata/platformTextRequests/0/taskId" }));
    });
});
