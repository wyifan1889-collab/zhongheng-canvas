import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PlatformImageReceipts, PlatformImageTask } from "./index";
import { PlatformImageSettings } from "./platform-image-controls";
import type { usePlatformImageWorkbench } from "./use-platform-image-workbench";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { firstPlatformDefault } from "@/components/creation/creation-platform-default";
import { chooseWorkbenchImageParameters, initialMappedImageParameters, mappedImageReferencePrice, type WorkbenchImageModel } from "./mapped-image-settings";

type Platform = ReturnType<typeof usePlatformImageWorkbench>;
const family: WorkbenchImageModel = { id: "gpt-image", displayName: "Image 2.5", capability: "image", group: "OpenAI", specifications: ["1K", "2K"], combinations: [
    { specification: "1K", available: true, nodeModelId: "first", priceVersion: 2, credits: 9, maxImages: 4, execution: { protocol: "openai-image-v1", parameters: { size: "1536x1024", quality: "high" } } },
    { specification: "1K", available: true, nodeModelId: "first", priceVersion: 2, credits: 9, maxImages: 4, execution: { protocol: "openai-image-v1", parameters: { size: "1024x1024", quality: "high" } } },
    { specification: "2K", available: true, nodeModelId: "first", priceVersion: 2, credits: 12, maxImages: 2, execution: { protocol: "openai-image-v1", parameters: { size: "2048x2048", quality: "high" } } },
] };
const platform = (patch: Partial<Platform> = {}): Platform => ({ rounds: [], mappingModels: [], loading: false, receipts: [], receiptsReady: true,
    error: "", busy: false, initializationError: "", retryInitialization: async () => {}, send: async () => false,
    refresh: () => {}, restore: async () => {}, loadImage: () => {}, ...patch });

test("the image controls select published resolution, ratio and count, and price the selected batch", () => {
    const parameters = chooseWorkbenchImageParameters(family, { specification: "1K", aspectRatio: "3:2" }, "4");
    expect(parameters.size).toBe("1536x1024");
    expect(mappedImageReferencePrice([family], parameters)).toBe(36);
    const smallerLimit = chooseWorkbenchImageParameters(family, { specification: "2K" }, "4");
    expect(smallerLimit.count).toBe("2");
    expect(mappedImageReferencePrice([family], smallerLimit)).toBe(24);
    expect(mappedImageReferencePrice([family], { ...smallerLimit, count: "3" })).toBeUndefined();
    const html = renderToStaticMarkup(<PlatformImageSettings platform={platform({ mappingModels: [family] })} parameters={parameters} onChange={() => {}} />);
    for (const label of ["清晰度", "比例", "张数", "3:2", "4 张"]) expect(html).toContain(label);
});

test("unknown rounds retain the original receipt and never show another generation button", () => {
    const html = renderToStaticMarkup(<PlatformImageTask platform={platform()} round={{ key: "original-unknown-key", conversationId: "local", prompt: "橘色街景", model: "Image 2.5", count: "2", startedAt: 2, imageBusy: false,
        state: { phase: "uncertain", busy: false, intentInvalidated: false,
        receipt: { accountId: "synthetic-owner", projectId: "__image_workbench__", idempotencyKey: "original-unknown-key", priceVersion: 3 }, view: null, quote: null, error: null } }} />);
    expect(html).toContain("橘色街景");
    expect(html).toContain("提交结果待核对");
    expect(html).toContain("original-unknown-key");
    expect(html).toContain("核对原任务");
    expect(html).not.toContain("确认生成");
    expect(html).not.toContain("冻结积分已退回");
});

test("image model loading and empty states remain visible", () => {
    const loading = renderToStaticMarkup(<PlatformImageSettings platform={platform({ loading: true })} parameters={{}} onChange={() => {}} />);
    expect(loading).toContain("正在读取平台模型");
    const empty = renderToStaticMarkup(<PlatformImageSettings platform={platform()} parameters={{}} onChange={() => {}} />);
    expect(empty).toContain("请先选择图片模型");
});

test("image receipts distinguish loading, empty and failed reads", () => {
    const loading = renderToStaticMarkup(<PlatformImageReceipts platform={platform({ receiptsReady: false })} />);
    expect(loading).toContain("正在读取本机回执"); expect(loading).not.toContain("暂无平台任务回执");
    const empty = renderToStaticMarkup(<PlatformImageReceipts platform={platform()} />);
    expect(empty).toContain("暂无平台任务回执");
    const failed = renderToStaticMarkup(<PlatformImageReceipts platform={platform({ receiptsReady: false, error: "图片回执读取失败，请保留本机数据。" })} />);
    expect(failed).toContain('role="alert"'); expect(failed).toContain("图片回执读取失败"); expect(failed).not.toContain("正在读取本机回执");
});

type Values = Record<string, any>;
const source = ts.createSourceFile("image/index.tsx", readFileSync(new URL("./index.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name: string, environment: Values) {
    let initializer: ts.Expression | undefined;
    const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) initializer = node.initializer; ts.forEachChild(node, visit); };
    visit(source);
    if (!initializer) throw new Error(`Missing actual image ${name}`);
    const code = ts.transpileModule(`return (${initializer.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    return new Function(...Object.keys(environment), code)(...Object.values(environment));
}
function defaultFixture() {
    const store: Values = { drafts: {}, pending: null, error: "", edit(input: Values) { this.drafts.image = { ...input, revision: (this.drafts.image?.revision ?? 0) + 1 }; return Promise.resolve(true); } };
    const defaultSeed = { current: { fresh: true, draft: undefined, routeKey: "new-image" } as Values };
    const writes: Values[] = [], reviews: boolean[] = [], notices: string[] = [];
    const draftOwner = { current: undefined as Values | undefined };
    const environment: Values = { defaultSeed, useCreationMediaLaunch: { getState: () => store }, platformMode: true, location: { key: "new-image" }, prompt: "", references: [], platformParameters: {},
        platform: { mappingModels: [family], loading: false, receiptsReady: true, busy: false, error: "" },
        current: () => true, draftReady: true, running: false, generationLock: { current: false }, creationLaunch: null, creation: { pending: null }, config: {},
        draftOwner, setDraftSaveNotice: (value: string) => notices.push(value), firstPlatformDefault, initialMappedImageParameters,
        setPlatformParameters: (value: Values) => writes.push(value), setPlatformSettingsReviewed: (value: boolean) => reviews.push(value) };
    return { store, defaultSeed, draftOwner, environment, writes, reviews, notices, apply: () => callback("applyDefaultModel", environment)(), persist: () => callback("persistDraft", environment)() };
}

test("actual image initialization survives its own unchanged blank persistence and prepares a valid default", () => {
    const f = defaultFixture(); f.persist();
    expect(f.defaultSeed.current.draft).toBe(f.store.drafts.image);
    f.apply(); f.apply();
    expect(f.writes).toEqual([{ mappingModelId: "gpt-image", mappingSpecification: "1K", model: "first", imageModel: "first", size: "1024x1024", quality: "high", count: "1" }]);
    expect(f.reviews).toEqual([true]); expect(f.store.drafts.image.parameters).toEqual({});
});

test("actual image autosave cannot replace a newer external draft even after initialization eligibility is revoked", () => {
    for (const eligible of [true, false]) {
        const f = defaultFixture(); f.persist(); f.defaultSeed.current.fresh = eligible;
        const external = { kind: "image", prompt: "较新的外来填稿", references: [], parameters: { imageModel: "kept-model" }, revision: 8 };
        f.store.drafts.image = external; f.environment.prompt = "旧页面快照";
        f.persist(); expect(f.store.drafts.image).toBe(external); expect(f.notices).toHaveLength(1);
        // A separately authorized target callback may adopt the new draft identity.
        f.draftOwner.current = external; f.environment.prompt = external.prompt; f.environment.platformParameters = external.parameters;
        f.persist(); expect(f.store.drafts.image).toBe(external);
    }
});

test("actual image default cannot overwrite a restored draft, edits, late foreign writes, launches or locked tasks", () => {
    const boundaries: Record<string, (f: ReturnType<typeof defaultFixture>) => void> = {
        restored: f => { f.defaultSeed.current.fresh = false; }, text: f => { f.environment.prompt = "已经输入"; },
        references: f => { f.environment.references = [{}]; }, parameters: f => { f.environment.platformParameters = { count: "4" }; },
        foreign: f => { f.store.drafts.image = { revision: 2, parameters: {} }; }, route: f => { f.environment.location.key = "another"; },
        account: f => { f.environment.current = () => false; }, pending: f => { f.store.pending = {}; }, launch: f => { f.environment.creationLaunch = {}; },
        busy: f => { f.environment.platform.busy = true; }, loading: f => { f.environment.platform.loading = true; },
        initializationFailed: f => { f.environment.platform.initializationError = "平台模型读取失败"; },
        failed: f => { f.store.error = "草稿读取失败"; }, unavailable: f => { f.environment.platform.mappingModels = []; },
    };
    for (const mutate of Object.values(boundaries)) { const f = defaultFixture(); f.persist(); mutate(f); f.apply(); expect(f.writes).toEqual([]); expect(f.reviews).toEqual([]); }
});
