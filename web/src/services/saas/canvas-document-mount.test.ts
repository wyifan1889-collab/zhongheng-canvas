import { expect, test } from "bun:test";
import type { JsonObject } from "../../../../packages/shared/src/index";
import { CanvasDocumentMountError, validateCanvasDocumentMount } from "./canvas-document-mount";

const base = (): JsonObject => ({
    id: "source-project", title: "隔离草稿", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
    nodes: [
        { id: "text-1", type: "future-plugin-node", title: "文本", position: { x: 0, y: 1 }, width: 200, height: 100,
            metadata: { content: "正文", status: "success", storageKey: "image:lazy", videoTaskId: "video-job" } },
        { id: "text-2", type: "text", title: "第二个节点", position: { x: 300, y: 1 }, width: 200, height: 100 },
    ],
    connections: [{ id: "connection-1", fromNodeId: "text-1", toNodeId: "text-2" }],
    chatSessions: [{ id: "chat-1", title: "会话", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", messages: [
        { id: "message-1", role: "user", text: "你好", references: [{ id: "text-1", type: "text", title: "文本", storageKey: "image:lazy" }] },
    ] }],
    activeChatId: "chat-1", backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
});

function rejects(value: unknown, code: string, path?: string, version: unknown = 1) {
    try { validateCanvasDocumentMount(value, version); throw new Error("expected rejection"); }
    catch (error) {
        expect(error).toBeInstanceOf(CanvasDocumentMountError);
        expect((error as CanvasDocumentMountError).code).toBe(code);
        if (path !== undefined) expect((error as CanvasDocumentMountError).path).toBe(path);
        expect(String(error)).not.toContain("synthetic-secret");
    }
}

test("strict mount validation returns detached frozen project and inert references", () => {
    const source = base();
    const mounted = validateCanvasDocumentMount(source);
    expect(mounted.status).toBe("mountable");
    expect(mounted.project).not.toBe(source);
    expect(mounted.project.nodes[0]).not.toBe((source.nodes as unknown[])[0]);
    expect(mounted.unresolvedReferences.some((item) => item.kind === "video-task")).toBe(true);
    expect(mounted.unresolvedReferences.some((item) => item.kind === "storage-key")).toBe(true);
    expect(Object.isFrozen(mounted)).toBe(true);
    expect(Object.isFrozen(mounted.project)).toBe(true);
    expect(Object.isFrozen(mounted.project.nodes)).toBe(true);
    (source.nodes as JsonObject[])[0]!.title = "调用方修改";
    expect(mounted.project.nodes[0]!.title).toBe("文本");
});

test("unknown plugin node types remain allowed while structure stays strict", () => {
    const mounted = validateCanvasDocumentMount(base());
    expect(mounted.project.nodes[0]!.type).toBe("future-plugin-node");
});

test("duplicate IDs, dangling connections, invalid chats and unsupported versions are rejected", () => {
    const duplicate = base(); duplicate.nodes = [...(duplicate.nodes as JsonObject[]), { ...(duplicate.nodes as JsonObject[])[0]! }];
    rejects(duplicate, "invalid_node", "/nodes/2/id");
    const dangling = base(); dangling.connections = [{ id: "connection-1", fromNodeId: "missing", toNodeId: "text-2" }];
    rejects(dangling, "invalid_connection", "/connections/0/fromNodeId");
    const badChat = base(); badChat.activeChatId = "missing-chat";
    rejects(badChat, "invalid_chat", "/activeChatId");
    rejects(base(), "unsupported_version", "", 2);
});

test("invalid node geometry and undefined optional fields are never repaired", () => {
    const invalid = base(); invalid.nodes = [{ ...(invalid.nodes as JsonObject[])[0]!, width: -1 }];
    rejects(invalid, "invalid_node");
    const undefinedField = base();
    (undefinedField.nodes as JsonObject[])[0]!.metadata = { content: "正文", status: "success", errorDetails: undefined };
    rejects(undefinedField, "invalid_document");
});

test("malformed documents do not leak their body in error messages", () => {
    const invalid = base(); invalid.nodes = [{ id: "synthetic-secret", type: "text", title: "synthetic-secret", position: { x: 0, y: 0 }, width: 1, height: 1, metadata: { status: "broken" } }];
    try { validateCanvasDocumentMount(invalid); throw new Error("expected rejection"); }
    catch (error) {
        expect(error).toBeInstanceOf(CanvasDocumentMountError);
        expect(String(error)).not.toContain("synthetic-secret");
        expect((error as CanvasDocumentMountError).path).toBe("/nodes/0/metadata/status");
    }
});

test("mount validation preserves valid text guards as inert data and refuses malformed or lossy records", () => {
    const source = base(), guardId = "11111111-1111-4111-8111-111111111111", taskId = "22222222-2222-4222-8222-222222222222";
    const record = { guardId, edited: false, taskId };
    (source.nodes as JsonObject[])[1].metadata = { content: "", platformTextRequests: [record] };
    const result = validateCanvasDocumentMount(source);
    expect(result.project.nodes[1].metadata?.platformTextRequests).toEqual([record]);
    expect(Object.isFrozen(result.project.nodes[1].metadata?.platformTextRequests)).toBe(true);
    expect(record.edited).toBe(false);
    for (const invalid of [[{ guardId, edited: false, taskId: "invalid" }], [{ guardId, edited: false, private: "synthetic-secret" }],
        [{ guardId, edited: false }, { guardId, edited: true }], [{ guardId, edited: false, taskId: undefined }], undefined]) {
        const candidate = base();
        (candidate.nodes as JsonObject[])[1].metadata = { platformTextRequests: invalid } as unknown as JsonObject;
        expect(() => validateCanvasDocumentMount(candidate)).toThrow(expect.objectContaining({ code: "invalid_document" }));
    }
});
