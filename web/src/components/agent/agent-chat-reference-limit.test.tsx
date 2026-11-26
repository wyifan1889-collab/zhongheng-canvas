import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "antd";
import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { useAgentStore, type AgentAttachment } from "@/stores/use-agent-store";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { AgentChatComposer } from "./agent-chat-composer";

const attachment = (index: number): AgentAttachment => ({ id: `upload-${index}`, name: `image-${index}.png`, type: "image/png", size: 1, width: 1, height: 1, url: "data:image/png;base64,AA==", dataUrl: "data:image/png;base64,AA==" });
const reference = (index: number): CanvasResourceReference => ({ id: `node-${index}`, nodeId: `node-${index}`, kind: "text", title: `text-${index}`, label: `文本${index}`, active: true, text: "body" });

function composer(attachments: AgentAttachment[], canvasReferences: CanvasResourceReference[], variant: "canvas" | "workbench" = "canvas") {
    // Zustand's SSR snapshot is the initial object; each test owns and restores
    // these draft fields instead of replacing the production hook.
    const initial = useAgentStore.getInitialState(), previous = { attachments: initial.attachments, canvasReferences: initial.canvasReferences };
    Object.assign(initial, { attachments, canvasReferences });
    try {
        return renderToStaticMarkup(<App><AgentChatComposer variant={variant} prompt="保留可编辑正文" attachments={attachments} placeholder="输入消息" theme={canvasThemes.dark} onPromptChange={() => {}} onSubmit={() => {}} onAddFiles={() => {}} onRemoveAttachment={() => {}} /></App>);
    } finally { Object.assign(initial, previous); }
}
function button(html: string, key: string) {
    const label = i18n.t(key).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return html.match(new RegExp(`<button\\b(?=[^>]*aria-label="${label}")[^>]*>`))?.[0] || "";
}

test("T3 twelve mixed draft sources disable new uploads while send and removal remain available", () => {
    const html = composer(Array.from({ length: 4 }, (_, i) => attachment(i)), Array.from({ length: 8 }, (_, i) => reference(i)));
    expect(html).toContain("已添加 12/12 个参考素材");
    expect(button(html, "agent.composer.uploadImage")).toMatch(/\sdisabled(?:="[^"]*")?(?=\s|>)/);
    expect(button(html, "agent.composer.send")).not.toBe("");
    expect(button(html, "agent.composer.send")).not.toMatch(/\sdisabled(?:="[^"]*")?(?=\s|>)/);
    expect(button(html, "agent.composer.removeImage")).not.toMatch(/\sdisabled(?:="[^"]*")?(?=\s|>)/);
    expect(html).toContain('contentEditable="true"');
});

test("T3 an existing over-limit draft remains visible and editable but cannot be sent", () => {
    const html = composer(Array.from({ length: 13 }, (_, i) => attachment(i)), []);
    expect(html).toContain("已添加 13/12 个参考素材");
    expect(button(html, "agent.composer.send")).toMatch(/\sdisabled(?:="[^"]*")?(?=\s|>)/);
    expect(button(html, "agent.composer.uploadImage")).toMatch(/\sdisabled(?:="[^"]*")?(?=\s|>)/);
    expect(html).toContain('contentEditable="true"');
});

test("T3 conflicting identities show a correction message and keep removal available", () => {
    const first = attachment(0), html = composer([first, { ...first, dataUrl: "data:image/png;base64,AQ==" }], []);
    expect(html).toContain("参考素材有冲突，请移除后重试。");
    expect(button(html, "agent.composer.send")).toMatch(/\sdisabled(?:="[^"]*")?(?=\s|>)/);
    expect(button(html, "agent.composer.removeImage")).not.toBe("");
    expect(button(html, "agent.composer.removeImage")).not.toMatch(/\sdisabled(?:="[^"]*")?(?=\s|>)/);
});

test("homepage draft capacity is fourteen and an explicit correction keeps thirteen images removable", () => {
    const html = composer(Array.from({ length: 13 }, (_, i) => attachment(i)), [], "workbench");
    expect(html).toContain("参考图 13/14 张");
    expect(html).toContain("单次发送给 AI 最多 12");
    expect(html).toContain("预计 — 积分");
    const upload = html.match(/<button\b(?=[^>]*aria-label="添加参考素材")[^>]*>/)?.[0] || "";
    expect(upload).not.toBe("");
    expect(upload).not.toMatch(/\sdisabled(?:="[^"]*")?(?=\s|>)/);
    expect(button(html, "agent.composer.send")).toMatch(/\sdisabled(?:="[^"]*")?(?=\s|>)/);
    expect(button(html, "agent.composer.removeImage")).not.toMatch(/\sdisabled(?:="[^"]*")?(?=\s|>)/);
    const full = composer(Array.from({ length: 14 }, (_, i) => attachment(i)), [], "workbench");
    expect(full).toContain("参考图 14/14 张");
    expect(full.match(/<button\b(?=[^>]*aria-label="添加参考素材")[^>]*>/)?.[0]).toMatch(/\sdisabled(?:="[^"]*")?(?=\s|>)/);
});
