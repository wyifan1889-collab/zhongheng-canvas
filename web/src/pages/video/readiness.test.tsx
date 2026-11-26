import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Empty, Spin } from "@/components/creation/ui";
import ts from "typescript";
import { createVideoWorkbenchSession, type VideoReceipt } from "./platform-video-workbench";
import { parseVideoTaskView, type VideoGenerationClient } from "@/services/saas/video-generation";
import { isVideoTaskFailed, pollVideoGenerationTask } from "@/services/api/video";
import { defaultConfig } from "@/stores/use-config-store";
import type { PublicVideoQuote } from "../../../../packages/shared/src/generation-video";
import { CreationLandingContext, CreationWorkbench } from "@/components/creation/creation-workbench";

const sourceText = readFileSync(new URL("./index.tsx", import.meta.url), "utf8");
const source = ts.createSourceFile("video/index.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const scope = { accountId: "synthetic-video-owner", epoch: 1 }, id = "12345678-1234-4234-9234-123456789abc", key = `video:${id}`;
const parameters = { mode: "text" as const, resolution: "720p" as const, durationSeconds: 5, generateAudio: false, aspectRatio: "16:9" as const };
const intent = { modelId: "video-model", input: { prompt: "保留原视频描述" }, parameters };
const quote: PublicVideoQuote = { modelId: intent.modelId, priceVersion: 1, parameters, quotedVideoUnits: 1, maxVideoUnits: 1, reservedCredits: 3, usagePolicy: "delivered_video", quoteFingerprint: "a".repeat(64) };
const view = () => parseVideoTaskView({ task: { id, projectId: null, nodeId: null, modelId: intent.modelId, priceVersion: 1, quotedUnits: 3, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 3,
    executionStatus: "running", deliveryStatus: "pending", billingStatus: "reserved", video: { parameters, usagePolicy: "delivered_video", quotedVideoUnits: 1, reservedCredits: 3, phase: "polling" } }, result: null })!;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
    const rows = new Map<string, VideoReceipt>(); let creates = 0, reads = 0;
    const client = { quote: async () => quote, submit: async () => { creates++; return view(); }, get: async () => { reads++; return view(); }, recover: async () => { reads++; return view(); } } as unknown as { -readonly [K in keyof VideoGenerationClient]: VideoGenerationClient[K] };
    const create = () => createVideoWorkbenchSession({ scope, getScope: () => scope, client, isIntentCurrent: () => true, createKey: () => key,
        receipts: { put: async receipt => { rows.set(receipt.id, structuredClone(receipt)); }, list: async () => [...rows.values()] } });
    return { create, client, rows, counts: () => ({ creates, reads }) };
}
test("a temporarily busy account shows the real page spinner instead of a false login prompt", () => {
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "VideoPage")!;
    const code = `${declaration.getText(source).replace("export default ", "")}\nreturn VideoPage;`;
    const javascript = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React } }).outputText;
    const Page = new Function("React", "useAccountStore", "Empty", "Spin", javascript)(React, () => ({ busy: true, getDraftScope: () => null }), Empty, Spin);
    const html = renderToStaticMarkup(<Page />); expect(html).toContain("正在核对当前账号"); expect(html).not.toContain("请登录");
});

test("quote rejection and an empty directory remain visible instead of being replaced by the landing content", () => {
    let expression: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === "CreationWorkbench") {
            const attribute = node.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(source) === "hasContent") as ts.JsxAttribute;
            expression = (attribute.initializer as ts.JsxExpression).expression;
        }
        ts.forEachChild(node, visit);
    };
    visit(source); if (!expression) throw new Error("Missing real video visibility expression");
    const visible = new Function("platform", "receipt", "error", "creation", `return (${expression.getText(source)});`);
    for (const platform of [{ loading: false, models: [{}], state: { error: "报价已变化" } }, { loading: false, models: [], state: null }]) {
        const html = renderToStaticMarkup(<CreationLandingContext.Provider value={{ heading: <h1>视频创作</h1>, shortcuts: <p>灵感首页</p> }}><CreationWorkbench kind="video" composer={null} hasContent={visible(platform, null, "", {})}><p role="alert">需要重新选择或读取</p></CreationWorkbench></CreationLandingContext.Provider>);
        expect(html).toContain("视频创作");
        expect(html).toContain("需要重新选择或读取"); expect(html).not.toContain("灵感首页");
    }
});
test("cancelled formal quote creates no receipt, task or upstream request", async () => {
    const f = fixture(), session = f.create(); await session.prepare(intent); session.invalidateQuote(); await session.confirm();
    expect(f.counts()).toEqual({ creates: 0, reads: 0 }); expect(f.rows.size).toBe(0); expect(session.getState().quote).toBeNull();
});
test("query errors retain the original accepted receipt and never become a generation failure", async () => {
    const f = fixture(), session = f.create(); await session.prepare(intent); await session.confirm();
    f.client.get = async () => { throw new Error("合成网络故障"); }; await session.refresh();
    expect(session.getState().phase).toBe("uncertain"); expect(session.getState().view?.task.executionStatus).toBe("running");
    expect(f.rows.get(key)).toMatchObject({ state: "accepted", taskId: id }); expect(f.counts().creates).toBe(1);
});
test("parallel manual reads share the original task operation", async () => {
    const f = fixture(), session = f.create(); await session.prepare(intent); await session.confirm(); const gate = deferred<ReturnType<typeof view>>();
    let reads = 0; f.client.get = async taskId => { reads++; expect(taskId).toBe(id); return gate.promise; };
    const first = session.refresh(); await session.refresh(); expect(reads).toBe(1); gate.resolve(view()); await first; expect(f.counts().creates).toBe(1);
});
test("page detach after POST leaves the durable original key; a new page recovers with GET only", async () => {
    const f = fixture(), session = f.create(), gate = deferred<ReturnType<typeof view>>();
    f.client.submit = async () => gate.promise;
    await session.prepare(intent); const sending = session.confirm(); await Promise.resolve(); await Promise.resolve();
    expect(f.rows.get(key)?.state).toBe("submitting"); session.close(); const before = session.getState(); gate.resolve(view()); await sending;
    expect(session.getState()).toBe(before); expect(f.rows.get(key)?.taskId).toBeUndefined();
    const fresh = f.create(); await fresh.restore(f.rows.get(key)!); await fresh.confirm(); expect(f.counts()).toEqual({ creates: 0, reads: 1 });
    expect(fresh.getState().receipt?.taskId).toBe(id);
});
test("the SaaS page imports neither personal configuration nor direct vendor create/poll functions", () => {
    const imports = source.statements.filter(ts.isImportDeclaration).map(node => String((node.moduleSpecifier as ts.StringLiteral).text));
    expect(imports).not.toContain("@/services/api/video"); expect(imports).not.toContain("@/stores/use-config-store"); expect(imports).not.toContain("./provider-context");
    expect(sourceText).not.toContain("setInterval"); expect(sourceText).not.toContain("createVideoGenerationTask(");
});
test("the untouched personal/plugin API still reports a missing memory result as unknown rather than retryable failure", async () => {
    let issue: unknown;
    try { await pollVideoGenerationTask(defaultConfig, { id: "synthetic-plugin-task-without-local-result", provider: "plugin", model: "synthetic-plugin-video" }); } catch (cause) { issue = cause; }
    expect(issue).toBeInstanceOf(Error); expect(isVideoTaskFailed(issue)).toBe(false); expect((issue as Error).message).toContain("勿重复生成");
});
