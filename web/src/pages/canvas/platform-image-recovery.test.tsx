import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { CanvasPlatformImageTaskPlaceholder, canvasImageTaskPlacement, type CanvasPlatformImageTaskProjection } from "@/components/canvas/canvas-platform-image-task-placeholder";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { createCanvasImageGenerationController, createGenerationReceiptStore, type GenerationReceipt } from "@/services/saas/canvas-image-generation";
import { createGenerationClient } from "@/services/saas/generation";
import { applyImageTargetResult, registerImageTarget } from "@/lib/canvas/platform-image-target";

const source = ts.createSourceFile("project.tsx", readFileSync(new URL("./project.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
type Values = Record<string, any>;
function find(predicate: (node: ts.Node) => boolean, root: ts.Node = source): ts.Node {
    let result: ts.Node | undefined;
    const visit = (node: ts.Node) => { if (!result && predicate(node)) result = node; if (!result) ts.forEachChild(node, visit); };
    visit(root); if (!result) throw new Error("Missing actual canvas recovery callback"); return result;
}
function run(expression: ts.Node, context: Values) {
    const merge = find(node => ts.isFunctionDeclaration(node) && node.name?.text === "mergePlatformImageTask");
    const code = ts.transpileModule(`${merge.getText()}\nreturn (${expression.getText()});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
    return new Function(...Object.keys(context), code)(...Object.values(context));
}
function callback(name: string, context: Values) {
    const declaration = find(node => ts.isVariableDeclaration(node) && node.name.getText(source) === name) as ts.VariableDeclaration;
    return run((declaration.initializer as ts.CallExpression).arguments[0], context);
}
const scope = { accountId: "owner", epoch: 3 }, projectId = "project", taskId = "11111111-1111-4111-8111-111111111111";
const accountKey = JSON.stringify([scope.accountId, scope.epoch]);
const target = { schemaVersion: 1 as const, nodeId: "node", guardId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", sourceType: "image" as const };
const seed = { accountKey, projectId, nodeId: target.nodeId, target, taskId, modelId: "original-model", quotedUnits: 7,
    executionStatus: "succeeded" as const, deliveryStatus: "visible" as const, billingStatus: "captured" as const };
const node: CanvasNodeData = { id: target.nodeId, type: CanvasNodeType.Image, title: "原图", position: { x: 0, y: 0 }, width: 200, height: 200, metadata: { content: "blob:edited" } };
const taskViewport = { viewport: { x: 0, y: 0, k: 1 }, viewportSize: { width: 1200, height: 720 }, insets: { top: 0, bottom: 0 } };
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("the partially visible mobile node keeps its task and timer inside the real canvas, below its header", () => {
    const mobileNode = { ...node, width: 420, height: 420, position: { x: -247.5, y: -126 } };
    const placement = canvasImageTaskPlacement(mobileNode, { x: 0, y: 0, k: 1 }, { width: 311, height: 780 }, { top: 110, bottom: 150 }, 88)!;
    expect(placement).toMatchObject({ left: 8, top: 118, width: 295, transform: "scale(1)", transformOrigin: "top left" });
    expect(64 + placement.left).toBeGreaterThan(64);
    expect(64 + placement.left + placement.width).toBeLessThan(375);
    expect(placement.top + 88).toBeLessThan(630);
});

test("task placement follows pan, zoom, and sidebar resize without changing its screen size", () => {
    const visibleNode = { ...node, position: { x: 120, y: 180 }, width: 420, height: 420 };
    for (const k of [0.25, 1, 2]) for (const width of [311, 900]) {
        const viewport = { x: -40, y: -60, k };
        const placement = canvasImageTaskPlacement(visibleNode, viewport, { width, height: 700 }, { top: 64, bottom: 120 }, 88)!;
        expect(placement).not.toBeNull();
        const x = placement.left * k + viewport.x, y = placement.top * k + viewport.y;
        expect(x).toBeGreaterThanOrEqual(8); expect(x + placement.width).toBeLessThanOrEqual(width - 8);
        expect(y).toBeGreaterThanOrEqual(72); expect(y + 88).toBeLessThanOrEqual(572);
        expect(placement.transform).toBe(`scale(${1 / k})`);
    }
    expect(canvasImageTaskPlacement(visibleNode, { x: 0, y: 0, k: 1 }, { width: 1440, height: 1000 }, { top: 64, bottom: 76 }, 88))
        .toMatchObject({ left: 120, top: 84, width: 320 });
});

test("offscreen and chrome-covered nodes never pin unrelated tasks to a canvas edge", () => {
    for (const position of [{ x: -421, y: 100 }, { x: 901, y: 100 }, { x: 100, y: -421 }, { x: 100, y: 701 }]) {
        expect(canvasImageTaskPlacement({ ...node, width: 420, height: 420, position }, { x: 0, y: 0, k: 1 }, { width: 900, height: 700 }, { top: 0, bottom: 0 }, 88)).toBeNull();
    }
    expect(canvasImageTaskPlacement({ ...node, height: 40 }, taskViewport.viewport, taskViewport.viewportSize, { top: 64, bottom: 0 }, 88)).toBeNull();
    expect(canvasImageTaskPlacement(node, taskViewport.viewport, { width: 0, height: 0 }, taskViewport.insets, 88)).toBeNull();
});

test("a tall task is constrained to the space between measured canvas chrome", () => {
    const placement = canvasImageTaskPlacement(node, taskViewport.viewport, { width: 311, height: 240 }, { top: 64, bottom: 80 }, 200)!;
    expect(placement).toMatchObject({ top: 72, maxHeight: 80 });
    expect(placement.top + placement.maxHeight).toBe(152);
});

test("succeeded private delivery retains the original-task entry until the application is actually saved", () => {
    for (const deliveryStatus of ["saved", "visible"] as const) for (const application of [undefined, "pending", "applied"] as const) {
        const task: CanvasPlatformImageTaskProjection = { ...seed, deliveryStatus, application };
        const html = renderToStaticMarkup(<CanvasPlatformImageTaskPlaceholder node={node} {...taskViewport} task={task} onOpen={() => {}} />);
        if (application === "applied") expect(html).toBe("");
        else { expect(html).toContain("点击查看原任务"); expect(html).toContain(application === "pending" ? "画布落点保存待核对" : "尚未应用到画布"); }
    }
});

test("an unread original quote is unknown while an authoritative zero quote still renders zero", () => {
    const unread = renderToStaticMarkup(<CanvasPlatformImageTaskPlaceholder node={node} {...taskViewport} task={{ ...seed, quotedUnits: undefined }} onOpen={() => {}} />);
    expect(unread).toContain("原报价待核对"); expect(unread).not.toContain("0 积分");
    const zero = renderToStaticMarkup(<CanvasPlatformImageTaskPlaceholder node={node} {...taskViewport} task={{ ...seed, quotedUnits: 0 }} onOpen={() => {}} />);
    expect(zero).toContain("原报价 0 积分"); expect(zero).not.toContain("原报价待核对");
});

test("opening an edited node task uses the original read-only target without building input or registering a guard", () => {
    let recovery: unknown, opened: unknown;
    const environment = { useAccountStore: { getState: () => ({ getDraftScope: () => scope }) }, projectLoaded: true, projectId,
        imageIntentRef: { current: { valid: false } as unknown }, setPlatformImageEntry: () => {}, setPlatformImageRecovery: (value: unknown) => { recovery = value; },
        setPlatformImageProjectId: (value: unknown) => { opened = value; },
        buildPlatformImageInput: () => { throw new Error("read-only must not build new input"); }, registerImageTarget: () => { throw new Error("read-only must not reset guard"); } };
    callback("openPlatformImageTask", environment)(seed); expect(recovery).toBe(seed); expect(opened).toBe(projectId); expect(environment.imageIntentRef.current).toBeNull();
    recovery = undefined; callback("openPlatformImageTask", environment)({ ...seed, accountKey: JSON.stringify([scope.accountId, scope.epoch + 1]) }); expect(recovery).toBeUndefined();
});

test("same-node tracker updates cannot replace another task's guard, quote or state, and old account/epoch seeds disappear", () => {
    const tracker = { accountId: scope.accountId, epoch: scope.epoch, projectId, kindHint: "image", nodeId: target.nodeId, taskId: "22222222-2222-4222-8222-222222222222",
        modelId: "other-model", executionStatus: "failed", deliveryStatus: "failed", billingStatus: "released" };
    const environment = { platformImageTaskSeeds: { node: seed }, previewAccountKey: accountKey, projectId, trackedGeneration: { entries: { task: tracker } } };
    expect(callback("platformImageTasks", environment)().node).toEqual(seed);
    tracker.taskId = taskId;
    expect(callback("platformImageTasks", environment)().node).toMatchObject({ target, taskId, quotedUnits: 7, executionStatus: "failed" });
    for (const change of [JSON.stringify(["other-owner", scope.epoch]), JSON.stringify([scope.accountId, scope.epoch + 1])]) {
        expect(callback("platformImageTasks", { ...environment, previewAccountKey: change })()).toEqual({});
    }
    expect(callback("platformImageTasks", { ...environment, projectId: "other-project" })()).toEqual({});
});

test("late receipt and task reads cannot publish canvas seeds or tracker updates after account/epoch change or unmount", async () => {
    const effect = find(node => ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.arguments[0]?.getText(source).includes("imageReceiptStore.list(scope.accountId, projectId)")) as ts.CallExpression;
    for (const boundary of ["account", "epoch", "unmount"] as const) for (const stage of ["receipts", "task"] as const) {
        let current = { ...scope }, finish!: (value: any) => void;
        const pending = new Promise(resolve => { finish = resolve; });
        const receipt = { accountId: scope.accountId, projectId, taskId, nodeId: target.nodeId, imageTarget: target, priceVersion: 3 };
        let seeds: Values = {}; const registered: unknown[] = [];
        const context = { projectLoaded: true, projectId, useAccountStore: { getState: () => ({ getDraftScope: () => current }) },
            setPlatformImageTaskSeeds: (next: Values | ((old: Values) => Values)) => { seeds = typeof next === "function" ? next(seeds) : next; },
            imageReceiptStore: { list: () => stage === "receipts" ? pending : Promise.resolve([receipt]) },
            createGenerationClient: () => ({ get: () => pending }),
            generationTracker: { getState: () => ({ register: (value: unknown) => registered.push(value) }) } };
        const cleanup = run(effect.arguments[0], context)(); await settle();
        const before = structuredClone(seeds);
        if (boundary === "account") current = { ...scope, accountId: "other-owner" };
        else if (boundary === "epoch") current = { ...scope, epoch: scope.epoch + 1 };
        else cleanup();
        finish(stage === "receipts" ? [receipt] : { task: { ...seed, id: taskId, nodeId: target.nodeId, priceVersion: 3 } }); await settle();
        expect(seeds).toEqual(before); expect(registered).toEqual([]); cleanup();
    }
});

async function applicationFixture(saveFails = false, backgroundRead = false) {
    const modal = ts.createSourceFile("modal.tsx", readFileSync(new URL("../../components/canvas/canvas-platform-image-modal.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const onState = find(n => ts.isJsxAttribute(n) && n.name.getText() === "onTaskState") as ts.JsxAttribute;
    const insert = find(n => ts.isVariableDeclaration(n) && n.name.getText() === "insertPlatformImage") as ts.VariableDeclaration;
    const subscribe = find(n => ts.isCallExpression(n) && n.expression.getText() === "next.subscribe", modal) as ts.CallExpression;
    const data = new Map<string, unknown>(), store = createGenerationReceiptStore({ keys: async () => [...data.keys()], getItem: async key => data.get(key) ?? null,
        setItem: async (key, value) => { data.set(key, structuredClone(value)); return value; } });
    const receipt: GenerationReceipt = { accountId: scope.accountId, projectId, taskId, idempotencyKey: "application-recovery", priceVersion: 3, nodeId: target.nodeId, imageTarget: target };
    await store.put(receipt);
    const captured = { ...scope, projectId }; let current = { ...captured }, failRead = false, seeds: Values = {};
    const notifications: unknown[] = [], registrations: unknown[] = [];
    const view = { task: { id: taskId, projectId, nodeId: target.nodeId, priceVersion: 3, modelId: seed.modelId, quotedUnits: 7,
        executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured" }, result: null };
    const client = createGenerationClient({ scope: captured, getScope: () => current, fetcher: Object.assign(async () => {
        if (failRead) throw new Error("injected task read failure"); return Response.json(view);
    }, { preconnect: fetch.preconnect }) });
    const controller = createCanvasImageGenerationController({ client, getContext: () => current, receiptStore: store, imageTarget: target, readOnly: true });
    const useAccountStore = { getState: () => ({ getDraftScope: () => current }) };
    const setSeeds = (update: Values | ((previous: Values) => Values)) => { seeds = typeof update === "function" ? update(seeds) : update; };
    const publish = run((onState.initializer as ts.JsxExpression).expression!, { projectId, previewAccountKey: accountKey, useAccountStore, setPlatformImageTaskSeeds: setSeeds });
    controller.subscribe(run(subscribe.arguments[0], { active: true, next: controller, setState: (value: unknown) => notifications.push(value), currentProps: { current: { onTaskState: publish } },
        generationTracker: { getState: () => ({ register: (value: unknown) => registrations.push(value) }) }, scope: captured, originRoute: `/canvas/${projectId}` }));
    await controller.restoreReceipt(receipt);
    expect(controller.getState().phase).toBe("tracking");
    let finishBackground = async () => {};
    if (backgroundRead) {
        let release!: (value: unknown) => void;
        const pending = new Promise(resolve => { release = resolve; });
        const effect = find(n => ts.isCallExpression(n) && n.expression.getText() === "useEffect" && n.arguments[0]?.getText().includes("imageReceiptStore.list(scope.accountId, projectId)")) as ts.CallExpression;
        const cleanup = run(effect.arguments[0], { projectLoaded: true, projectId, useAccountStore, imageReceiptStore: store, setPlatformImageTaskSeeds: setSeeds,
            createGenerationClient: () => ({ get: () => pending }), generationTracker: { getState: () => ({ register: () => {} }) } })();
        await settle();
        finishBackground = async () => { release(view); await settle(); cleanup(); };
    }
    const nodesRef = { current: registerImageTarget([{ ...node, metadata: { prompt: "original" } }], target).nodes }, connectionsRef = { current: [] as any[] };
    const apply = run(insert.initializer!, { useAccountStore, projectId, isGenerationProjectCurrent: () => true, applyImageTargetResult, nodesRef, connectionsRef,
        imageTargetHistoryRef: { current: new Map() }, getCanvasCenter: () => ({ x: 0, y: 0 }), imageReceiptStore: store, setPlatformImageTaskSeeds: setSeeds,
        setNodes: (value: CanvasNodeData[]) => { nodesRef.current = value; }, setConnections: (value: any[]) => { connectionsRef.current = value; }, mountedCloudMediaObjectUrlsRef: { current: [] },
        setSelectedNodeIds: () => {}, setSelectedConnectionId: () => {}, updateProject: () => {}, flushCanvasStorage: async () => { if (saveFails) throw new Error("injected canvas save failure"); } });
    const outcome = await apply({ taskId, cloudMediaId: taskId, url: "blob:application-result", width: 1024, height: 512, bytes: 232, mimeType: "image/png" }, controller.getState().receipt, "original", controller.isCurrent);
    return { controller, store, receipt, outcome, publish, notifications, registrations, finishBackground, getSeeds: () => seeds,
        failRead: () => { failRead = true; }, changeScope: (patch: Partial<typeof current>) => { current = { ...current, ...patch }; } };
}

test("successful application stays applied through close and successful or failed refresh notifications", async () => {
    for (const action of ["close", "refresh", "failed-refresh"]) {
        const f = await applicationFixture(); expect(f.outcome.status).toBe("filled-original");
        expect((await f.store.list(scope.accountId, projectId))[0].application).toBe("applied");
        expect(f.getSeeds().node.application).toBe("applied");
        if (action === "close") f.controller.close(); else { if (action === "failed-refresh") f.failRead(); await f.controller.refresh(); }
        expect(f.getSeeds().node.application).toBe("applied");
        expect(renderToStaticMarkup(<CanvasPlatformImageTaskPlaceholder node={node} {...taskViewport} task={f.getSeeds().node} onOpen={() => {}} />)).toBe("");
    }
});

test("a claimed result whose canvas save failed stays pending through close or a failed refresh", async () => {
    for (const action of ["close", "failed-refresh"]) {
        const f = await applicationFixture(true); expect(f.outcome.status).toBe("application-uncertain");
        if (action === "close") f.controller.close(); else { f.failRead(); await f.controller.refresh(); }
        expect((await f.store.list(scope.accountId, projectId))[0].application).toBe("pending"); expect(f.getSeeds().node.application).toBe("pending");
        expect(await f.store.claimImageApplication(f.receipt)).toBe("pending");
        expect(renderToStaticMarkup(<CanvasPlatformImageTaskPlaceholder node={node} {...taskViewport} task={f.getSeeds().node} onOpen={() => {}} />)).toContain("画布落点保存待核对");
    }
});

test("closed or account/epoch-invalidated controllers cannot publish old receipt notifications", async () => {
    for (const boundary of ["closed", "account", "epoch"]) {
        const f = await applicationFixture(); const before = f.getSeeds(), notices = f.notifications.length, registrations = f.registrations.length;
        if (boundary === "closed") f.controller.close();
        else { f.changeScope(boundary === "account" ? { accountId: "other-owner" } : { epoch: scope.epoch + 1 }); await f.controller.refresh(); }
        expect(f.getSeeds()).toBe(before); expect(f.notifications).toHaveLength(notices); expect(f.registrations).toHaveLength(registrations);
    }
});

test("a different task on the same node never inherits another task's applied marker", async () => {
    const f = await applicationFixture();
    f.publish({ receipt: { ...f.receipt, taskId: "22222222-2222-4222-8222-222222222222", idempotencyKey: "another-task" }, view: null });
    expect(f.getSeeds().node.taskId).toBe("22222222-2222-4222-8222-222222222222"); expect(f.getSeeds().node.application).toBeUndefined();
    expect(renderToStaticMarkup(<CanvasPlatformImageTaskPlaceholder node={node} {...taskViewport} task={f.getSeeds().node} onOpen={() => {}} />)).toContain("尚未应用到画布");
});

test("a background recovery GET started before application cannot downgrade its later pending or applied state", async () => {
    for (const saveFails of [false, true]) {
        const f = await applicationFixture(saveFails, true), expected = saveFails ? "pending" : "applied";
        expect(f.getSeeds().node.application).toBe(expected);
        await f.finishBackground();
        expect(f.getSeeds().node.application).toBe(expected); expect((await f.store.list(scope.accountId, projectId))[0].application).toBe(expected);
    }
});

test("a late recovery GET cannot reclaim a node after a new real controller task takes ownership", async () => {
    const modal = ts.createSourceFile("modal.tsx", readFileSync(new URL("../../components/canvas/canvas-platform-image-modal.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const recovery = find(node => ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.arguments[0]?.getText(source).includes("imageReceiptStore.list(scope.accountId, projectId)")) as ts.CallExpression;
    const onState = find(node => ts.isJsxAttribute(node) && node.name.getText() === "onTaskState") as ts.JsxAttribute;
    const subscribe = find(node => ts.isCallExpression(node) && node.expression.getText() === "next.subscribe", modal) as ts.CallExpression;
    const taskA = taskId, taskB = "22222222-2222-4222-8222-222222222222";
    const targetA = target, targetB = { ...target, guardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    const receiptA: GenerationReceipt = { accountId: scope.accountId, projectId, taskId: taskA, idempotencyKey: "old-task-a", priceVersion: 1, nodeId: targetA.nodeId, imageTarget: targetA };
    const viewA = { task: { id: taskA, projectId, nodeId: targetA.nodeId, priceVersion: 1, modelId: "model-a", quotedUnits: 7, executionStatus: "running", deliveryStatus: "pending", billingStatus: "reserved" }, result: null };
    const viewB = { task: { ...viewA.task, id: taskB, modelId: "model-b", quotedUnits: 9 }, result: null };
    const values = new Map<string, unknown>();
    const store = createGenerationReceiptStore({ keys: async () => [...values.keys()], getItem: async key => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, structuredClone(value)); return value; } });
    await store.put(receiptA);
    let seeds: Values = {}, listStarted = false, getStarted = false, releaseList!: (value: GenerationReceipt[]) => void, releaseGet!: (value: unknown) => void;
    const pendingList = new Promise<GenerationReceipt[]>(resolve => { releaseList = resolve; });
    const pendingGet = new Promise(resolve => { releaseGet = resolve; });
    const useAccountStore = { getState: () => ({ getDraftScope: () => ({ ...scope, projectId }) }) };
    const generationTracker = { getState: () => ({ register: () => {} }) };
    const setSeeds = (update: Values | ((previous: Values) => Values)) => { seeds = typeof update === "function" ? update(seeds) : update; };
    const cleanup = run(recovery.arguments[0], { projectLoaded: true, projectId, useAccountStore, imageReceiptStore: { list: () => { listStarted = true; return pendingList; } }, setPlatformImageTaskSeeds: setSeeds,
        createGenerationClient: () => ({ get: () => { getStarted = true; return pendingGet; } }), generationTracker })();
    for (let i = 0; i < 20 && !listStarted; i++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(listStarted).toBe(true);

    const controllerB = createCanvasImageGenerationController({ getContext: () => ({ ...scope, projectId }), receiptStore: store, imageTarget: targetB,
        beforeImageReceipt: async () => {}, getIntentCurrent: () => true, createIdempotencyKey: () => "new-task-b",
        client: { quote: async () => ({ modelId: "model-b", priceVersion: 1, quotedUnits: 9 }), submit: async () => viewB } as any });
    const publish = run((onState.initializer as ts.JsxExpression).expression!, { projectId, previewAccountKey: accountKey, useAccountStore, setPlatformImageTaskSeeds: setSeeds });
    controllerB.subscribe(run(subscribe.arguments[0], { active: true, next: controllerB, setState: () => {}, currentProps: { current: { onTaskState: publish } }, generationTracker, scope, originRoute: `/canvas/${projectId}` }));
    await controllerB.prepare({ modelId: "model-b", prompt: "new request", parameters: {}, nodeId: targetB.nodeId });
    await controllerB.confirm();
    expect(controllerB.getState().phase).toBe("tracking");
    expect(seeds[target.nodeId]).toMatchObject({ taskId: taskB, target: targetB, quotedUnits: 9 });

    releaseList([receiptA]);
    for (let i = 0; i < 20 && !getStarted; i++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(getStarted).toBe(true);
    expect(seeds[target.nodeId]).toMatchObject({ taskId: taskB, target: targetB, quotedUnits: 9 });
    releaseGet(viewA);
    await settle();
    expect(seeds[target.nodeId]).toMatchObject({ taskId: taskB, target: targetB, quotedUnits: 9 });
    controllerB.close();
    expect(seeds[target.nodeId]).toMatchObject({ taskId: taskB, target: targetB });
    cleanup();
});

async function reloadReceipts(receipts: GenerationReceipt[], reverseKeys: boolean) {
    const values = new Map<string, unknown>();
    const store = createGenerationReceiptStore({ keys: async () => reverseKeys ? [...values.keys()].reverse() : [...values.keys()],
        getItem: async key => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, structuredClone(value)); return value; } });
    for (const { application, ...receipt } of receipts) {
        await store.put(receipt);
        if (application) await store.claimImageApplication(receipt);
        if (application === "applied") await store.completeImageApplication(receipt);
    }
    let seeds: Values = {};
    const reads: string[] = [], registered: string[] = [];
    const recovery = find(n => ts.isCallExpression(n) && n.expression.getText() === "useEffect" && n.arguments[0]?.getText().includes("imageReceiptStore.list(scope.accountId, projectId)")) as ts.CallExpression;
    const cleanup = run(recovery.arguments[0], { projectLoaded: true, projectId, useAccountStore: { getState: () => ({ getDraftScope: () => scope }) }, imageReceiptStore: store,
        setPlatformImageTaskSeeds: (next: Values | ((old: Values) => Values)) => { seeds = typeof next === "function" ? next(seeds) : next; },
        createGenerationClient: () => ({ get: async (id: string) => { reads.push(id); const receipt = receipts.find(item => item.taskId === id)!;
            return { task: { ...seed, id, nodeId: target.nodeId, priceVersion: receipt.priceVersion } }; } }),
        generationTracker: { getState: () => ({ register: (entry: { taskId: string }) => registered.push(entry.taskId) }) } })();
    const expectedReads = receipts.filter(receipt => receipt.application !== "applied").length;
    for (let i = 0; i < 20 && registered.length < expectedReads; i++) await new Promise(resolve => setTimeout(resolve, 0));
    cleanup();
    expect(reads).toHaveLength(expectedReads); expect(registered).toHaveLength(expectedReads);
    expect(await store.list(scope.accountId, projectId)).toHaveLength(receipts.length);
    return seeds[target.nodeId];
}

test("reload restores the latest unapplied receipt on a node independently of storage key order", async () => {
    const first: GenerationReceipt = { accountId: scope.accountId, projectId, taskId, nodeId: target.nodeId, imageTarget: target,
        idempotencyKey: "a-old", priceVersion: 1, submittedAt: "2026-11-01T00:00:00.000Z" };
    const latest: GenerationReceipt = { ...first, taskId: "22222222-2222-4222-8222-222222222222", idempotencyKey: "z-new",
        submittedAt: "2026-11-02T00:00:00.000Z", imageTarget: { ...target, guardId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } };
    const applied: GenerationReceipt = { ...latest, taskId: "33333333-3333-4333-8333-333333333333", idempotencyKey: "applied",
        submittedAt: "2026-11-03T00:00:00.000Z", application: "applied" };
    for (const reverse of [false, true]) expect(await reloadReceipts([first, latest, applied], reverse)).toMatchObject({ taskId: latest.taskId, target: latest.imageTarget, submittedAt: latest.submittedAt });
});

test("recovery uses a stable tie order without inventing timestamps and prefers a known submission time", async () => {
    const base: GenerationReceipt = { accountId: scope.accountId, projectId, taskId, nodeId: target.nodeId, imageTarget: target, idempotencyKey: "z-first", priceVersion: 1 };
    const other: GenerationReceipt = { ...base, taskId: "22222222-2222-4222-8222-222222222222", idempotencyKey: "a-second" };
    const submittedAt = "2026-11-02T00:00:00.000Z";
    for (const reverse of [false, true]) {
        const missing = await reloadReceipts([base, other], reverse);
        expect(missing.taskId).toBe(other.taskId); expect(missing.submittedAt).toBeUndefined();
        expect((await reloadReceipts([{ ...base, submittedAt }, { ...other, submittedAt }], reverse)).taskId).toBe(other.taskId);
        expect((await reloadReceipts([{ ...base, submittedAt }, other], reverse)).taskId).toBe(base.taskId);
    }
});
