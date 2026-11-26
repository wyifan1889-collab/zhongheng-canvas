import { expect, test } from "bun:test";
import { checkCanvasSave } from "./canvas-save-check";

const fixture = () => ({
    id: "synthetic", title: "不应展示的项目正文", createdAt: "test", updatedAt: "test",
    nodes: [{ id: "text", metadata: { content: "私有内容", groupId: undefined } },
        { id: "image", metadata: { storageKey: "image:private", content: "blob:https://synthetic.example/private" } }],
    connections: [{ fromNodeId: "text", toNodeId: "image" }], chatSessions: [], activeChatId: null,
    backgroundMode: "lines", showImageInfo: false, viewport: { x: 12, y: 23, k: 1 },
});

test("retains counts only and leaves the live project untouched", () => {
    const project = fixture();
    const before = structuredClone(project);
    expect(checkCanvasSave(project)).toEqual({ status: "checked", nodes: 2, connections: 1, chats: 0, localMediaReferences: 2, omittedOptionalFields: 1 });
    expect(project).toEqual(before);
});

test("does not retain snapshot, file identifiers, private paths or raw exceptions", () => {
    const project = fixture();
    Object.assign(project, { privateExtension: undefined });
    expect(checkCanvasSave(project)).toEqual({ status: "unavailable" });
    expect(checkCanvasSave(new Proxy({}, { ownKeys() { throw new Error("private credential"); } }))).toEqual({ status: "unavailable" });
    expect(checkCanvasSave(null)).toEqual({ status: "unavailable" });
});

test("rechecking reflects latest edits but never mutates an earlier count result", () => {
    const project = fixture();
    const previous = checkCanvasSave(project);
    project.nodes.pop();
    const latest = checkCanvasSave(project);
    expect(previous).toMatchObject({ nodes: 2, localMediaReferences: 2 });
    expect(latest).toMatchObject({ nodes: 1, localMediaReferences: 0 });
    expect(latest).not.toHaveProperty("saved");
    expect(latest).not.toHaveProperty("cloudSaveReady");
});

test("accessors are rejected without invoking their code", () => {
    let invoked = false;
    const project = fixture();
    Object.defineProperty(project, "plugin", { enumerable: true, get() { invoked = true; return "secret"; } });
    expect(checkCanvasSave(project)).toEqual({ status: "unavailable" });
    expect(invoked).toBe(false);
});
