import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as React from "react";
import { Button } from "antd";
import ts from "typescript";

import { GenerationError } from "@/services/saas/generation";
import type { AudioGenerationScope, AudioGenerationTaskView } from "@/services/saas/audio-generation";
import { createGenerationTracker, isGenerationTrackingUncertain, type GenerationTrackerEntry } from "@/stores/use-generation-tracker";
import { DEFAULT_AUDIO_PARAMETERS, selectAudioModelParameters } from "./audio-parameters";
import { firstPlatformDefault } from "@/components/creation/creation-platform-default";
import { audioTaskReadIssue, audioTaskResponseIsStale, audioTaskStatusSignature, createAudioTaskRegistration } from "./audio-task-tracking";

type Values = Record<string, any>;
const source = ts.createSourceFile("audio/index.tsx", readFileSync(new URL("./index.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const workbench = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "AudioWorkbench");

// Use the page's actual callbacks and button expression, without a browser, IndexedDB or provider.
function evaluate<T>(node: ts.Node, environment: Values): T {
    const javascript = ts.transpileModule(`return (${node.getText(source)});`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
    }).outputText;
    return new Function(...Object.keys(environment), javascript)(...Object.values(environment));
}

function initializer(name: string) {
    function visit(node: ts.Node): ts.Expression | undefined {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) return node.initializer;
        return ts.forEachChild(node, visit);
    }
    const node = workbench && visit(workbench);
    if (!node) throw new Error(`Missing audio callback: ${name}`);
    return node;
}

const callback = (name: string, environment: Values) => evaluate<(...args: any[]) => any>(initializer(name), environment);
function helper(name: string, environment: Values = {}) {
    const node = source.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
    if (!node) throw new Error(`Missing audio helper: ${name}`);
    return evaluate<(...args: any[]) => any>(node, environment);
}

function deferred<T>() {
    let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

const scope: AudioGenerationScope = { accountId: "audio-readiness-owner", epoch: 4 };
const taskId = "11111111-1111-4111-8111-111111111111";
const parameters = { ...DEFAULT_AUDIO_PARAMETERS, model: "synthetic-audio", prompt: "保留的朗读文字", voice: "default", format: "wav" as const };
const view = (complete = false): AudioGenerationTaskView => ({ task: {
    id: taskId, projectId: null, nodeId: null, modelId: parameters.model, priceVersion: 1, quotedUnits: 1,
    billingUnitSnapshot: "request", creditsPerUnitSnapshot: 1,
    audioSnapshot: { status: "recorded", input: { text: parameters.prompt }, parameters: { voice: parameters.voice, format: parameters.format } },
    executionStatus: complete ? "succeeded" : "queued", deliveryStatus: complete ? "saved" : "pending", billingStatus: complete ? "captured" : "reserved",
}, result: null });
const receipt = (patch: Values = {}) => ({ id: `audio:${taskId}`, createdAt: 1, parameters, taskId, view: view(), state: "accepted", paused: false, ...patch });
const entry = (patch: Partial<GenerationTrackerEntry> = {}): GenerationTrackerEntry => ({ ...scope, taskId,
    projectId: null, nodeId: null, modelId: parameters.model, originRoute: "/audio", kindHint: "audio",
    executionStatus: "queued", deliveryStatus: "pending", billingStatus: "reserved", polling: false, readStatus: "ready", ...patch });

function fixture() {
    const state = {
        scope: { ...scope } as AudioGenerationScope | null, live: { current: true }, persisted: [] as Values[], errors: [] as string[],
        calls: [] as { method: string; id: string }[], busy: [] as boolean[],
        read: async () => view(true), write: async () => {},
    };
    const tracker = createGenerationTracker({ getScope: () => state.scope, setTimer: () => 0, clearTimer: () => {} });
    const callbacks: Values = {}, logsRef = { current: [] as Values[] };
    const environment: Values = {
        scope, live: state.live, useAccountStore: { getState: () => ({ getDraftScope: () => state.scope }) },
        writes: { current: Promise.resolve() }, removed: { current: new Set<string>() }, readVersions: { current: new Map<string, number>() }, logsRef,
        controller: { current: new AbortController() }, polling: { current: null }, trackingReads: { current: new Map<string, string>() },
        submissionLock: { current: false }, confirmation: { quote: { quotedUnits: 1 }, parameters },
        setLogs: () => {}, setBusy: (busy: boolean) => { state.busy.push(busy); }, setError: (error: string) => { state.errors.push(error); },
        selectReceipt: () => {}, setConfirmation: () => {}, crypto: { randomUUID: () => taskId }, GenerationError,
        storage: { setItem: async (_id: string, value: Values) => { await state.write(); state.persisted.push(structuredClone(value)); } },
        client: Object.fromEntries(["get", "recover", "submit"].map(method => [method, (id: string) => { state.calls.push({ method, id }); return state.read(); }])),
        generationTracker: tracker, audioTaskStatusSignature, audioTaskResponseIsStale, finished: helper("finished"),
        withView: helper("withView", { DEFAULT_AUDIO_PARAMETERS, isGenerationTrackingUncertain }), intent: helper("intent"),
        invalidatePlatformWallet: () => {},
    };
    environment.registerTask = createAudioTaskRegistration({ scope, getScope: () => state.scope, isCurrent: () => callbacks.current(), tracker });
    for (const name of ["current", "check", "publish", "queueWrite", "save", "beginRead", "pollLogs", "submit", "recover"]) {
        callbacks[name] = callback(name, environment);
        environment[name] = (...args: any[]) => callbacks[name](...args);
    }
    return { state, tracker, callbacks, environment, logsRef };
}

test("same-tick audio quote clicks issue one quote without submitting and always release the quote lock", async () => {
    const wait = deferred<Values>(), quoteLock = { current: false }, confirmations: Values[] = [], busy: boolean[] = [], errors: string[] = [];
    let quotes = 0, submits = 0;
    const showQuote = callback("showQuote", {
        submissionLock: { current: false }, quoteLock, loaded: true, parameters, editRevision: { current: 0 }, controller: { current: new AbortController() },
        client: { quote: () => { quotes++; return wait.promise; }, submit: () => { submits++; } }, intent: helper("intent"),
        current: () => true, check: () => {}, setBusy: (value: boolean) => busy.push(value), setError: (value: string) => errors.push(value),
        setConfirmation: (value: Values) => confirmations.push(value),
    });
    const first = showQuote();
    expect(quoteLock.current).toBe(true);
    await showQuote();
    expect(quotes).toBe(1); expect(submits).toBe(0); expect(confirmations).toEqual([]);
    wait.resolve({ quotedUnits: 1 }); await first;
    expect(quoteLock.current).toBe(false); expect(busy).toEqual([true, false]); expect(confirmations).toHaveLength(1);
    const failed = deferred<Values>();
    const failQuote = callback("showQuote", {
        submissionLock: { current: false }, quoteLock, loaded: true, parameters, editRevision: { current: 0 }, controller: { current: new AbortController() },
        client: { quote: () => failed.promise }, intent: helper("intent"), current: () => true, check: () => {},
        setBusy: () => {}, setError: (value: string) => errors.push(value), setConfirmation: () => {},
    });
    const second = failQuote(); failed.reject(new Error("报价读取中断")); await second;
    expect(quoteLock.current).toBe(false); expect(errors).toContain("报价读取中断"); expect(submits).toBe(0);
});

test("only a saved verified audio response registers T4; stored or failed reads cannot regress a completed task", async () => {
    const f = fixture(), old = receipt();
    await f.callbacks.save(old);
    await f.callbacks.save({ ...old, paused: true, error: "读取中断" });
    await f.callbacks.save(old, undefined, false);
    expect(Object.values(f.tracker.getState().entries)).toEqual([]);
    f.state.write = async () => { throw new Error("本机存储失败"); };
    await expect(f.callbacks.save(old, undefined, true)).rejects.toThrow("本机存储失败");
    expect(Object.values(f.tracker.getState().entries)).toEqual([]);
    const persisted = deferred<void>(), started = deferred<void>();
    f.state.write = () => { started.resolve(); return persisted.promise; };
    const saving = f.callbacks.save(receipt({ view: view(true) }), undefined, true);
    await started.promise;
    expect(Object.values(f.tracker.getState().entries)).toEqual([]);
    persisted.resolve(); await saving;
    expect(Object.values(f.tracker.getState().entries)).toMatchObject([{ taskId, executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured" }]);
    f.state.write = async () => {};
    await f.callbacks.save(old); await f.callbacks.save({ ...old, paused: true, error: "旧回执读取失败" });
    await f.callbacks.save(old, undefined, true);
    expect(Object.values(f.tracker.getState().entries)).toMatchObject([{ executionStatus: "succeeded", polling: false }]);
    for (const operation of ["submit", "pollLogs", "recover"]) {
        const fresh = fixture();
        if (operation === "pollLogs") fresh.logsRef.current = [receipt({ view: undefined })];
        await fresh.callbacks[operation](...(operation === "recover" ? [receipt()] : []));
        expect(Object.values(fresh.tracker.getState().entries)).toMatchObject([{ taskId, executionStatus: "succeeded", billingStatus: "captured" }]);
    }
});

test("audio read warnings persist only for the matching account, epoch, task and audio kind", () => {
    for (const readStatus of ["missing", "unconfirmed"] as const) {
        const own = entry({ readStatus }), issue = audioTaskReadIssue(own, scope, taskId);
        expect(issue).toContain("原任务"); expect(issue).toContain("不会重新生成");
        expect(audioTaskReadIssue(own, scope, taskId)).toBe(issue);
        for (const foreign of [entry({ readStatus, accountId: "other-owner" }), entry({ readStatus, epoch: scope.epoch + 1 }), entry({ readStatus, taskId: "22222222-2222-4222-8222-222222222222" }), entry({ readStatus, kindHint: "image" })]) {
            expect(audioTaskReadIssue(foreign, scope, taskId)).toBeUndefined();
        }
    }
    for (const readStatus of ["ready", "account-stopped"] as const) expect(audioTaskReadIssue(entry({ readStatus }), scope, taskId)).toBeUndefined();
    expect(audioTaskReadIssue(undefined, scope, taskId)).toBeUndefined(); expect(audioTaskReadIssue(entry({ readStatus: "missing" }), scope)).toBeUndefined();
});

test("a selected T4 read warning enables the real original-task button and recovery only gets or recovers", async () => {
    let button: ts.JsxElement | undefined;
    function visit(node: ts.Node) {
        if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "Button" && node.children.some(child => ts.isJsxText(child) && child.text.trim() === "查询原任务")) button = node;
        ts.forEachChild(node, visit);
    }
    visit(source);
    if (!button) throw new Error("Missing audio original-task button");
    for (const readStatus of ["missing", "unconfirmed"] as const) {
        const f = fixture(), selected = receipt();
        const selectedReadIssue = evaluate<string | undefined>(initializer("selectedReadIssue"), { scope, selected, audioTaskReadIssue, tracked: { entries: { foreign: entry({ readStatus, accountId: "other-owner" }), own: entry({ readStatus }) } } });
        expect(selectedReadIssue).toBeTruthy();
        let checking: Promise<void> | undefined;
        const environment = { React, Button, selected, busy: false, selectedReadIssue, finished: helper("finished"), recover: (value: Values) => { checking = f.callbacks.recover(value); } };
        const query = evaluate<React.ReactElement<{ disabled: boolean; onClick: () => void }>>(button, environment);
        expect(query.props.disabled).toBe(false); query.props.onClick(); await checking;
        expect(evaluate<React.ReactElement<{ disabled: boolean }>>(button, { ...environment, selectedReadIssue: undefined }).props.disabled).toBe(true);
        await f.callbacks.recover(receipt({ taskId: undefined, view: undefined, state: "unconfirmed" }));
        expect(f.state.calls).toEqual([{ method: "get", id: taskId }, { method: "recover", id: selected.id }]);
        expect(Object.values(f.tracker.getState().entries)).toMatchObject([{ taskId, executionStatus: "succeeded" }]);
    }
});

test("a stale audio recovery cannot persist or register after its read version, account, epoch or page changes", async () => {
    for (const boundary of ["version", "account", "epoch", "page"] as const) {
        const f = fixture(), wait = deferred<AudioGenerationTaskView>(), original = receipt();
        f.state.read = () => wait.promise;
        const checking = f.callbacks.recover(original);
        if (boundary === "version") f.callbacks.beginRead(original.id);
        if (boundary === "account") f.state.scope = { ...scope, accountId: "other-owner" };
        if (boundary === "epoch") f.state.scope = { ...scope, epoch: scope.epoch + 1 };
        if (boundary === "page") f.state.live.current = false;
        wait.resolve(view(true)); await checking;
        expect(f.state.calls).toEqual([{ method: "get", id: taskId }]);
        expect(f.state.persisted).toEqual([]); expect(Object.values(f.tracker.getState().entries)).toEqual([]);
    }
});

test("a late audio GET cannot regress T4 completion and leaves a paused receipt for a fresh manual query", async () => {
    for (const operation of ["pollLogs", "recover"] as const) {
        const f = fixture(), wait = deferred<AudioGenerationTaskView>(), original = receipt({ view: undefined });
        const register = createAudioTaskRegistration({ scope, getScope: () => scope, isCurrent: () => true, tracker: f.tracker });
        register(taskId, view()); f.logsRef.current = [original]; f.state.read = () => wait.promise;
        const checking = operation === "pollLogs" ? f.callbacks.pollLogs() : f.callbacks.recover(original);
        expect(f.state.calls).toEqual([{ method: "get", id: taskId }]);
        register(taskId, view(true));
        wait.resolve(view()); await checking;
        expect(Object.values(f.tracker.getState().entries)).toMatchObject([{ taskId, executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured", polling: false }]);
        expect(f.state.persisted).toMatchObject([{ id: original.id, paused: true, error: "任务状态已更新，详情待核对，请主动查询原任务" }]);
        expect(f.environment.trackingReads.current.has(original.id)).toBe(false);
        await f.callbacks.pollLogs(); expect(f.state.calls).toHaveLength(1);
        // A manual check starting after completion must also reject an older nonterminal response.
        f.state.read = async () => view(); await f.callbacks.recover(f.logsRef.current[0]);
        expect(Object.values(f.tracker.getState().entries)[0].executionStatus).toBe("succeeded");
        expect(f.logsRef.current[0].paused).toBe(true);
        f.state.read = async () => view(true); await f.callbacks.recover(f.logsRef.current[0]);
        expect(f.logsRef.current[0]).toMatchObject({ paused: false, error: undefined, view: { task: { executionStatus: "succeeded" } } });
        expect(f.state.calls.every(call => call.method === "get")).toBe(true);
    }
});

test("a delayed audio receipt write cannot regress T4 from running to the earlier queued GET", async () => {
    const f = fixture(), original = receipt(), stored = deferred<void>(), started = deferred<void>();
    const register = createAudioTaskRegistration({ scope, getScope: () => scope, isCurrent: () => true, tracker: f.tracker });
    register(taskId, view()); f.logsRef.current = [original];
    const before = { ...Object.values(f.tracker.getState().entries)[0] }, version = f.callbacks.beginRead(original.id);
    f.environment.trackingReads.current.set(original.id, audioTaskStatusSignature(before));
    let writes = 0;
    f.state.write = async () => { if (++writes === 1) { started.resolve(); await stored.promise; } };
    const saving = f.callbacks.save(original, version, true, before);
    await started.promise;
    const running: AudioGenerationTaskView = { ...view(), task: { ...view().task, executionStatus: "running" } };
    register(taskId, running);
    stored.resolve(); await saving;
    expect(Object.values(f.tracker.getState().entries)).toMatchObject([{ taskId, executionStatus: "running", polling: true }]);
    expect(f.logsRef.current[0]).toMatchObject({ paused: true, error: "任务状态已更新，详情待核对，请主动查询原任务" });
    expect(f.state.persisted.at(-1)).toMatchObject({ paused: true, error: "任务状态已更新，详情待核对，请主动查询原任务" });
    expect(f.environment.trackingReads.current.has(original.id)).toBe(false);
    await f.callbacks.pollLogs(); expect(f.state.calls).toEqual([]);
    f.state.read = async () => running;
    await f.callbacks.recover(f.logsRef.current[0]);
    expect(f.state.calls).toEqual([{ method: "get", id: taskId }]);
    expect(f.logsRef.current[0]).toMatchObject({ paused: false, error: undefined, view: { task: { executionStatus: "running" } } });
    expect(Object.values(f.tracker.getState().entries)[0].executionStatus).toBe("running");
});

function defaultFixture() {
    const value = { ...DEFAULT_AUDIO_PARAMETERS }, editRevision = { current: 0 };
    const store: Values = { scope, ready: true, error: "", pending: null, drafts: {}, writes: 0, edit: (next: Values) => {
        store.writes++;
        store.drafts.audio = { ...next, revision: (store.drafts.audio?.revision ?? 0) + 1 };
        return Promise.resolve(true);
    } };
    const state: Values = { value, changes: 0, confirmations: [], errors: [], notices: [], queued: undefined };
    const defaultModel = { current: { routeKey: "fresh-audio", editRevision: 0, parameters: value, draft: undefined } as Values | null };
    const draftOwner = { current: undefined as Values | undefined };
    const environment: Values = {
        defaultModel, draftOwner, editRevision, scope, music: false, location: { key: "fresh-audio" }, parameters: value,
        models: [{ id: "first-published", audio: { voices: ["default"], formats: ["wav"] } }, { id: "second-published", audio: { voices: ["alloy"], formats: ["mp3"] } }],
        draftReady: true, loaded: true, modelsLoading: false, selectedId: undefined, busy: false, confirmation: null, creationLaunch: null,
        submissionLock: { current: false }, quoteLock: { current: false }, error: "", historyError: "", creation: { pending: null },
        current: () => true, useCreationMediaLaunch: { getState: () => store }, firstPlatformDefault, selectAudioModelParameters,
        setError: (message: string) => state.errors.push(message), setDraftSaveNotice: (message: string) => state.notices.push(message), setConfirmation: (next: Values) => state.confirmations.push(next),
        setParameters: (update: (current: Values) => Values) => { state.changes++; state.value = update(state.value); },
    };
    return { state, store, environment, defaultModel, draftOwner, editRevision, apply: () => callback("applyDefaultModel", environment)(), persist: () => callback("persistDraft", environment)() };
}

test("fresh audio selects the first accepted catalog model once after its own blank save without quoting", () => {
    const f = defaultFixture();
    f.persist(); expect(f.defaultModel.current?.draft).toBe(f.store.drafts.audio);
    f.apply(); expect(f.state.value).toEqual({ ...DEFAULT_AUDIO_PARAMETERS, model: "first-published", voice: "default", format: "wav" });
    expect(f.editRevision.current).toBe(1); expect(f.defaultModel.current).toBeNull(); expect(f.state.confirmations).toEqual([null]);
    f.apply(); expect(f.state.changes).toBe(1);
    // Only the existing blank persistence occurred; default selection itself invokes no store/service write.
    expect(f.store.drafts.audio.parameters.model).toBe("");
});

test("audio catalog defaults cannot overwrite restored, edited, foreign, pending or busy drafts", () => {
    const boundaries: Record<string, (f: ReturnType<typeof defaultFixture>) => void> = {
        music: f => { f.environment.music = true; }, restored: f => { f.defaultModel.current = null; },
        loading: f => { f.environment.modelsLoading = true; }, draftLoading: f => { f.environment.draftReady = false; },
        historyLoading: f => { f.environment.loaded = false; }, unavailable: f => { f.environment.models = []; },
        edited: f => { f.editRevision.current++; }, localValue: f => { f.environment.parameters = { ...DEFAULT_AUDIO_PARAMETERS }; },
        storedValue: f => { f.store.drafts.audio = { ...DEFAULT_AUDIO_PARAMETERS, revision: 2 }; },
        account: f => { f.store.scope = { ...scope, accountId: "other-owner" }; }, epoch: f => { f.store.scope = { ...scope, epoch: scope.epoch + 1 }; },
        route: f => { f.environment.location = { key: "other-route" }; }, unmounted: f => { f.environment.current = () => false; },
        pending: f => { f.store.pending = { nonce: "other-launch" }; }, launch: f => { f.environment.creationLaunch = { nonce: "consumed-launch" }; },
        selectedRecord: f => { f.environment.selectedId = "original-receipt"; }, selectedModel: f => { f.environment.parameters.model = "unavailable-restored-model"; },
        busy: f => { f.environment.busy = true; }, submitting: f => { f.environment.submissionLock.current = true; },
        quoting: f => { f.environment.quoteLock.current = true; }, confirming: f => { f.environment.confirmation = { quotedUnits: 1 }; },
        storeError: f => { f.store.error = "草稿保存失败"; }, error: f => { f.environment.error = "模型读取失败"; },
        historyError: f => { f.environment.historyError = "原日志无法读取"; },
    };
    for (const [name, change] of Object.entries(boundaries)) {
        const f = defaultFixture(); change(f); f.apply();
        expect(f.state.changes, name).toBe(0); expect(f.state.confirmations, name).toEqual([]);
    }
});

test("audio autosave never overwrites an external draft arriving between render and effect, even after default eligibility ended", () => {
    for (const eligible of [true, false]) {
        const f = defaultFixture(), originalInput = f.state.value, persist = callback("persistDraft", f.environment);
        f.state.errors.push("原报价错误");
        if (!eligible) f.defaultModel.current = null;
        const external = { kind: "audio", prompt: "外来填稿", references: [], parameters: { ...DEFAULT_AUDIO_PARAMETERS, prompt: "外来填稿" }, revision: 1 };
        f.store.drafts.audio = external; persist();
        expect(f.store.writes).toBe(0); expect(f.store.drafts.audio).toBe(external); expect(f.state.value).toBe(originalInput);
        expect(f.draftOwner.current).toBeUndefined(); expect(f.state.notices[0]).toContain("其他入口更新"); expect(f.state.notices[0]).toContain("未覆盖");
        expect(f.state.errors).toEqual(["原报价错误"]);
        expect(f.defaultModel.current).toBeNull(); f.apply(); expect(f.state.changes).toBe(0);
    }
});

test("the guarded shortcut callback adopts its accepted draft before local updates, allowing later ordinary autosave", () => {
    const f = defaultFixture(); f.persist();
    expect(f.draftOwner.current).toBe(f.store.drafts.audio);
    const accepted = { ...f.store.drafts.audio, prompt: "已安全接纳的快捷卡", parameters: { ...DEFAULT_AUDIO_PARAMETERS, prompt: "已安全接纳的快捷卡" }, revision: 2 };
    f.store.drafts.audio = accepted;
    callback("applyShortcutPrompt", f.environment)(accepted.prompt);
    expect(f.state.notices).toEqual([""]);
    expect(f.draftOwner.current).toBe(accepted); expect(f.state.value.prompt).toBe(accepted.prompt); expect(f.editRevision.current).toBe(1);
    f.environment.parameters = f.state.value; f.persist(); expect(f.store.writes).toBe(1);
    f.environment.parameters = { ...f.state.value, style: "用户继续编辑" }; f.persist();
    expect(f.store.writes).toBe(2); expect(f.store.drafts.audio.parameters.style).toBe("用户继续编辑");
    expect(f.store.drafts.audio.prompt).toBe(accepted.prompt); expect(f.draftOwner.current).toBe(f.store.drafts.audio); expect(f.state.errors).toEqual([]);
});

test("music retains its original autosave behavior without the creation ownership gate", () => {
    const f = defaultFixture(); f.environment.music = true; f.defaultModel.current = null;
    f.store.drafts.audio = { kind: "audio", prompt: "原音乐页草稿", references: [], parameters: { ...DEFAULT_AUDIO_PARAMETERS, prompt: "原音乐页草稿" }, revision: 1 };
    f.persist(); expect(f.store.writes).toBe(1); expect(f.state.errors).toEqual([]); expect(f.state.notices).toEqual([]);
});

test("the independent audio draft notice remains visible even without another result or error", () => {
    let expression: ts.Expression | undefined;
    function visit(node: ts.Node) {
        if (ts.isJsxAttribute(node) && node.name.getText(source) === "hasContent" && node.initializer && ts.isJsxExpression(node.initializer)) expression = node.initializer.expression;
        ts.forEachChild(node, visit);
    }
    visit(source); if (!expression) throw new Error("Missing audio workbench content condition");
    expect(evaluate<boolean>(expression, { selected: undefined, error: "", draftSaveNotice: "草稿未覆盖", historyError: "", creation: { error: "" }, modelsLoading: false, models: [{}] })).toBe(true);
});

test("returning to the previous route or cancelling a launch cannot revive an invalidated audio default", () => {
    for (const boundary of ["route", "pending"] as const) {
        const f = defaultFixture();
        if (boundary === "route") f.environment.location = { key: "another-route" };
        else f.store.pending = { nonce: "cancelled-launch" };
        f.apply(); expect(f.defaultModel.current).toBeNull();
        f.environment.location = { key: "fresh-audio" }; f.store.pending = null;
        f.apply(); expect(f.state.changes).toBe(0);
    }
});

test("a queued audio default setter preserves a newer local edit at the state commit", () => {
    const f = defaultFixture(); f.environment.setParameters = (update: (current: Values) => Values) => { f.state.queued = update; };
    f.apply(); const edited = { ...DEFAULT_AUDIO_PARAMETERS, model: "user-selected", prompt: "用户刚输入" };
    expect(f.state.queued(edited)).toBe(edited);
});
