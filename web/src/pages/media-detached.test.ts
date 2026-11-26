import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { CREATION_DRAFT_REFERENCE_LIMIT } from "@/lib/creation-reference-limits";
import { createVideoWorkbenchSession, type VideoReceipt } from "@/pages/video/platform-video-workbench";
import { parseVideoTaskView, type VideoGenerationClient, type VideoGenerationTaskView } from "@/services/saas/video-generation";
import { draftIdentity, videoReferenceIssue } from "@/pages/video/use-platform-video-workbench";
import type { PublicVideoQuote } from "../../../packages/shared/src/generation-video";

test("moving a first-frame model to another display family cannot bypass the pending draft identity", () => {
    const input = { prompt: "同一首帧镜头", references: [{ id: "reference", name: "frame.png", storageKey: "original-local-image", type: "image/png", dataUrl: "blob:local" }],
        selection: { source: "platform-video" as const, modelId: "same-source", mappingModelId: "old-family", specification: "720P", parameters: { mode: "first_frame" as const, resolution: "720p" as const, durationSeconds: 5, generateAudio: false } } };
    expect(draftIdentity({ ...input, selection: { ...input.selection, mappingModelId: "new-family" } })).toBe(draftIdentity(input));
    expect(draftIdentity({ ...input, selection: { ...input.selection, parameters: { ...input.selection.parameters!, durationSeconds: 10 } } })).not.toBe(draftIdentity(input));
    expect(draftIdentity({ ...input, references: [{ ...input.references[0], storageKey: "different-local-image" }] })).not.toBe(draftIdentity(input));
});

type Kind = "image" | "video";
type Scope = { accountId: string; epoch: number };
type Value = Record<string, any>;
const owner: Scope = { accountId: "media-detached-owner", epoch: 1 };
const sources = new Map<Kind, ts.SourceFile>();

// Exercise the page's real async callbacks without a DOM, vendor calls or IndexedDB.
function pageCallback<T extends (...args: any[]) => any>(kind: Kind, name: string, environment: Value): T {
    let source = sources.get(kind);
    if (!source) {
        source = ts.createSourceFile(`${kind}/index.tsx`, readFileSync(new URL(`./${kind}/index.tsx`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        sources.set(kind, source);
    }
    const workbench = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === `${kind === "image" ? "Image" : "Video"}Workbench`);
    function visit(node: ts.Node): ts.Expression | undefined {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) return node.initializer;
        return ts.forEachChild(node, visit);
    }
    const initializer = workbench ? visit(workbench) : undefined;
    if (!initializer) throw new Error(`Missing ${kind} workbench callback: ${name}`);
    const javascript = ts.transpileModule(`const callback = ${initializer.getText(source)};`, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    return new Function(...Object.keys(environment), `${javascript}\nreturn callback;`)(...Object.values(environment)) as T;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function fixture(kind: Kind) {
    const creation = deferred<any>(), polling = deferred<any>(), started = deferred<void>(), pollStarted = deferred<void>();
    const scope: Scope = { ...owner };
    const state = {
        account: { ...scope } as Scope | null, live: true, ui: [] as string[], agent: [] as unknown[],
        creates: 0, polls: 0, uploads: 0, delays: 0, sequence: 0, results: [] as any[],
        writes: [] as Value[], rows: new Map<string, Value>(),
        providerFingerprint: "fp-a", providerCurrent: true,
    };
    const scopeCurrent = () => state.account?.accountId === scope.accountId && state.account?.epoch === scope.epoch;
    const current = () => state.live && scopeCurrent();
    const config = { model: "channel::media", imageModel: "channel::media", videoModel: "channel::media", count: "1", size: "1280x720", vquality: "720" };
    const stored = { url: "blob:stored-result", storageKey: "media:stored-result", width: 1280, height: 720, bytes: 9, mimeType: kind === "image" ? "image/png" : "video/mp4" };
    const callbacks: Value = {};
    const ui = (name: string) => (..._args: unknown[]) => { state.ui.push(name); };
    const environment: Value = {
        scope, current, scopeCurrent,
        check: () => { if (!scopeCurrent()) throw new Error("Account scope changed"); },
        running: false, platformMode: false, generationLock: { current: false }, activeLogIdsRef: { current: new Set<string>() },
        agentTaskIdRef: { current: undefined }, prompt: "A preserved creation", model: config.model,
        effectiveConfig: config, config, generationCount: 1,
        useConfigStore: { getState: () => ({ config }) },
        captureVideoProviderContext: () => {
            const fingerprint = state.providerFingerprint;
            return { fingerprint: Promise.resolve(fingerprint), isCurrent: () => state.providerCurrent && fingerprint === state.providerFingerprint };
        },
        message: { success: ui("message.success"), error: ui("message.error"), warning: ui("message.warning") },
        t: (key: string) => key, nanoid: () => `local-${++state.sequence}`,
        isAiConfigReady: () => true, openConfigDialog: ui("openConfigDialog"),
        updateAgentTask: (...args: unknown[]) => { state.agent.push(args); },
        setCreationError: ui("setCreationError"), setElapsedMs: ui("setElapsedMs"),
        setRunning: ui("setRunning"), setPreviewLog: ui("setPreviewLog"), setStartedAt: ui("setStartedAt"), setLogs: ui("setLogs"),
        setResults: (value: any) => { state.ui.push("setResults"); state.results = typeof value === "function" ? value(state.results) : value; },
        updateResultAt: (value: any[], index: number, patch: Value) => value.map((item, position) => position === index ? { ...item, ...patch } : item),
        buildRequestSnapshot: () => ({ text: "A preserved creation", config, references: [] }),
        buildLog: (input: Value) => ({ id: `log-${++state.sequence}`, createdAt: Date.now(), ...input }),
        buildVideoConfig: (value: Value) => value,
        requestGeneration: () => { state.creates++; started.resolve(); return creation.promise; },
        requestEdit: () => { state.creates++; started.resolve(); return creation.promise; },
        createVideoGenerationTask: () => { state.creates++; started.resolve(); return creation.promise; },
        pollVideoGenerationTask: () => { state.polls++; pollStarted.resolve(); return polling.promise; },
        uploadImage: async () => { state.uploads++; return stored; },
        storeGeneratedVideo: async () => { state.uploads++; return stored; },
        delay: async () => { state.delays++; },
        logStore: (pinned: Scope) => {
            expect(pinned).toEqual(scope);
            return { setItem: async (id: string, value: Value) => {
                const saved = structuredClone(value); state.writes.push(saved); state.rows.set(id, saved);
            } };
        },
        serializeLog: (value: Value) => value,
        readStoredLogs: async (pinned: Scope) => { expect(pinned).toEqual(scope); return [...state.rows.values()]; },
        saveLog: (...args: any[]) => callbacks.saveLog(...args),
        refreshLogs: (...args: any[]) => callbacks.refreshLogs(...args),
        runGenerationSlot: (...args: any[]) => callbacks.runGenerationSlot(...args),
        pollGenerationLog: (...args: any[]) => callbacks.pollGenerationLog(...args),
        resumePendingLogs: (...args: any[]) => callbacks.resumePendingLogs(...args),
    };
    for (const name of ["saveLog", "refreshLogs", ...(kind === "image" ? ["runGenerationSlot"] : ["pollGenerationLog", "resumePendingLogs"]), "generate"]) {
        callbacks[name] = pageCallback(kind, name, environment);
    }
    const pendingLog = (provider: "openai" | "plugin" = "openai") => ({ id: "existing-video-task", createdAt: Date.now(), status: "pending", config, model: config.model, providerFingerprint: "fp-a", task: { id: "vendor-task", model: config.model, provider } });
    return { state, creation, polling, started, pollStarted, callbacks, config, pendingLog };
}

test("an image response after navigation is persisted once without updating the detached page", async () => {
    const f = fixture("image");
    const generating = f.callbacks.generate();
    await f.callbacks.generate();
    await f.started.promise;
    expect(f.state.creates).toBe(1);
    f.state.live = false; const uiBefore = [...f.state.ui];
    f.creation.resolve([{ id: "image-result", dataUrl: "data:image/png;base64,review" }]);
    await generating;
    expect(f.state.uploads).toBe(1);
    expect(f.state.writes).toHaveLength(1);
    expect(f.state.writes[0]).toMatchObject({ status: "success", successCount: 1, images: [{ id: "image-result", storageKey: "media:stored-result" }] });
    expect(f.state.ui).toEqual(uiBefore);
});









test("logout, account changes and new epochs prevent late image writes", async () => {
    for (const kind of ["image"] as const) {
        for (const replacement of [null, { accountId: "another-owner", epoch: 1 }, { ...owner, epoch: 2 }]) {
            const f = fixture(kind), generating = f.callbacks.generate();
            await f.started.promise;
            f.state.account = replacement; const uiBefore = [...f.state.ui];
            f.creation.resolve(kind === "image" ? [{ id: "image-result", dataUrl: "data:image/png;base64,review" }] : { id: "old-owner-task", provider: "openai", model: f.config.model });
            await generating;
            expect(f.state.uploads).toBe(0);
            expect(f.state.writes).toHaveLength(0);
            expect(f.state.ui).toEqual(uiBefore);
        }
    }
});











function referenceFixture(count: number, kind: Kind = "video") {
    const original = Array.from({ length: count }, (_, index) => ({ id: `original-${index}`, name: `${index}.png`, type: "image/png", dataUrl: `blob:original-${index}`, storageKey: `image:original-${index}` }));
    const referencesRef = { current: original };
    const state = { references: original, uploads: 0, updates: 0, warnings: 0, sequence: 0 };
    const helpers: Value = {};
    const environment: Value = {
        current: () => true, scopeCurrent: () => true, check: () => {}, references: original, referencesRef,
        CREATION_DRAFT_REFERENCE_LIMIT,
        message: { warning: () => { state.warnings++; }, error: () => {}, success: () => {} },
        t: (key: string) => key, nanoid: () => `added-${++state.sequence}`,
        navigator: { clipboard: { read: async () => [{ types: ["image/png"], getType: async () => new Blob(["image"], { type: "image/png" }) }] } },
        uploadImage: async () => { state.uploads++; return { url: "blob:added", storageKey: "image:added", mimeType: "image/png" }; },
        setReferences: (update: any) => {
            state.updates++; state.references = typeof update === "function" ? update(state.references) : update;
            referencesRef.current = state.references;
        },
        setPrompt: () => {}, setAssetPickerOpen: () => {},
        canAddReferences: (...args: any[]) => helpers.canAddReferences(...args),
        appendReferences: (...args: any[]) => helpers.appendReferences(...args),
    };
    helpers.canAddReferences = pageCallback(kind, "canAddReferences", environment);
    helpers.appendReferences = pageCallback(kind, "appendReferences", environment);
    return { original, referencesRef, state, callback: (name: string) => pageCallback(kind, name, environment) };
}

test.each(["image"] as const)("%s reference ingress refuses a fifteenth image without uploading or truncating the fourteen-image draft", async kind => {
    for (const ingress of ["invalid-file", "valid-file", "clipboard", "asset"] as const) {
        const f = referenceFixture(14, kind);
        if (ingress === "clipboard") await f.callback("addReferencesFromClipboard")();
        else if (ingress === "asset") await f.callback("insertPickedAsset")({ kind: "image", title: "extra", dataUrl: "data:image/png;base64,extra" });
        else await f.callback("addReferences")([new File(["reference"], ingress === "valid-file" ? "extra.png" : "notes.txt", { type: ingress === "valid-file" ? "image/png" : "text/plain" })]);
        expect(f.state.references).toBe(f.original);
        expect(f.state.references).toHaveLength(14);
        expect(f.state.updates).toBe(0);
        expect(f.state.uploads).toBe(0);
    }
});

test.each(["image"] as const)("%s references reject a whole overflowing batch and accept the fourteenth slot", async kind => {
    for (const additions of [2, 1]) {
        const f = referenceFixture(13, kind);
        await f.callback("addReferences")(Array.from({ length: additions }, (_, index) => new File(["reference"], `${index}.png`, { type: "image/png" })));
        expect(f.state.references.slice(0, 13)).toEqual(f.original);
        expect(f.state.references).toHaveLength(additions === 1 ? 14 : 13);
        expect(f.state.uploads).toBe(additions === 1 ? 1 : 0);
        expect(f.state.updates).toBe(additions === 1 ? 1 : 0);
    }
});



test("image request snapshots reject thirteen or fourteen and preserve the valid twelve-image request", () => {
    for (const count of [12, 13, 14]) {
        const f = referenceFixture(count, "image"); let issue = "";
        const snapshot = pageCallback("image", "buildRequestSnapshot", { prompt: "草稿与发送上限分开", references: f.state.references,
            setCreationError: (value: string) => { issue = value; }, isAiConfigReady: () => true, effectiveConfig: {}, model: "synthetic-image" });
        expect(snapshot()?.references.length ?? null).toBe(count === 12 ? 12 : null);
        if (count > 12) expect(issue).toContain("最多12个");
        expect(f.state.references).toHaveLength(count);
    }
});

// V1 replaces personal vendor polling in this page with the real durable platform receipt session.
// Image callback tests above remain unchanged; the following cases retain the video's prior failure/ownership coverage.
const videoId = "77777777-1111-4111-8111-111111111111";
const videoParameters = { mode: "text" as const, resolution: "480p" as const, durationSeconds: 1, generateAudio: false, aspectRatio: "16:9" as const };
function platformVideoFixture() {
    const creation = deferred<VideoGenerationTaskView>(), reading = deferred<VideoGenerationTaskView>(), started = deferred<void>();
    let account: Scope | null = owner, intentCurrent = true, reads = 0, creates = 0;
    const rows = new Map<string, VideoReceipt>(), writes: VideoReceipt[] = [];
    const intent = { modelId: "v1-synthetic-video", input: { prompt: "保留原视频意图" }, parameters: videoParameters };
    const quote: PublicVideoQuote = { modelId: intent.modelId, priceVersion: 1, parameters: videoParameters, quotedVideoUnits: 1, maxVideoUnits: 1, reservedCredits: 3, usagePolicy: "delivered_video", quoteFingerprint: "a".repeat(64) };
    const view = () => parseVideoTaskView({ task: { id: videoId, projectId: null, nodeId: null, modelId: intent.modelId, priceVersion: 1, quotedUnits: 3,
        billingUnitSnapshot: "request", creditsPerUnitSnapshot: 3, executionStatus: "running", deliveryStatus: "pending", billingStatus: "reserved",
        video: { parameters: videoParameters, usagePolicy: "delivered_video", quotedVideoUnits: 1, reservedCredits: 3, phase: "polling" } }, result: null })!;
    const client = { quote: async () => quote, submit: async () => { creates++; started.resolve(); return creation.promise; },
        get: async () => { reads++; return reading.promise; }, recover: async () => { reads++; return reading.promise; } } as unknown as { -readonly [K in keyof VideoGenerationClient]: VideoGenerationClient[K] };
    const make = () => createVideoWorkbenchSession({ scope: owner, getScope: () => account, client, isIntentCurrent: () => intentCurrent,
        createKey: () => `video:${videoId}`, receipts: { put: async receipt => { const saved = structuredClone(receipt); writes.push(saved); rows.set(saved.id, saved); }, list: async () => [...rows.values()] } });
    const session = make();
    return { session, make, intent, quote, view, client, rows, writes, started, creation, reading,
        counts: () => ({ creates, reads }), change: (next: Scope | null) => { account = next; }, invalidate: () => { intentCurrent = false; } };
}
async function acceptPlatformVideo(f: ReturnType<typeof platformVideoFixture>) {
    await f.session.prepare(f.intent); const operation = f.session.confirm(); await f.started.promise; f.creation.resolve(f.view()); await operation;
}
test("a video accepted after navigation retains the durable original key and a new page recovers it without resubmission", async () => {
    const f = platformVideoFixture(); await f.session.prepare(f.intent); const operation = f.session.confirm(); await f.started.promise;
    f.session.close(); const detached = f.session.getState(); f.creation.resolve(f.view()); await operation;
    expect(f.session.getState()).toBe(detached); expect(f.rows.get(`video:${videoId}`)?.state).toBe("submitting"); expect(f.counts()).toEqual({ creates: 1, reads: 0 });
    const next = f.make(); f.reading.resolve(f.view()); await next.restore(f.rows.get(`video:${videoId}`)!); await next.confirm();
    expect(next.getState().receipt?.taskId).toBe(videoId); expect(f.counts()).toEqual({ creates: 1, reads: 1 });
});
test("a legacy plugin memory-map result cannot masquerade as a privately delivered platform video", () => {
    expect(parseVideoTaskView({ id: "plugin-memory", provider: "plugin", result: { blob: new Blob(["video"]) } })).toBeNull();
    const legacy = { task: { id: videoId, providerTaskId: "vendor-id" }, result: { url: "https://vendor.invalid/movie.mp4" } };
    expect(parseVideoTaskView(legacy)).toBeNull();
});
test("an in-flight video completion after navigation cannot update the detached page or trigger another read", async () => {
    const f = platformVideoFixture(); await acceptPlatformVideo(f); const reading = f.session.refresh();
    f.session.close(); const before = f.session.getState(), stored = structuredClone([...f.rows.values()]);
    const completed = f.view(); completed.task.executionStatus = "succeeded"; completed.task.video.phase = "completed";
    f.reading.resolve(completed); await reading;
    expect(f.session.getState()).toBe(before); expect([...f.rows.values()]).toEqual(stored); expect(f.counts()).toEqual({ creates: 1, reads: 1 });
});
test("an in-flight pending video response after navigation leaves its original durable receipt and has no browser poll loop", async () => {
    const f = platformVideoFixture(); await acceptPlatformVideo(f); const reading = f.session.refresh(); const stored = structuredClone([...f.rows.values()]);
    f.session.close(); f.reading.resolve(f.view()); await reading;
    expect([...f.rows.values()]).toEqual(stored); expect(f.counts()).toEqual({ creates: 1, reads: 1 });
});
test("logout, account replacement and new epochs prevent all late video result persistence", async () => {
    for (const replacement of [null, { accountId: "another-owner", epoch: 1 }, { ...owner, epoch: 2 }]) {
        const f = platformVideoFixture(); await f.session.prepare(f.intent); const sending = f.session.confirm(); await f.started.promise;
        f.change(replacement); const stored = structuredClone([...f.rows.values()]); f.creation.resolve(f.view()); await sending;
        expect([...f.rows.values()]).toEqual(stored); expect(f.session.getState().view).toBeNull(); expect(f.counts()).toEqual({ creates: 1, reads: 0 });
    }
});
test("a completed video read cannot cross an account or epoch change", async () => {
    for (const replacement of [null, { accountId: "another-owner", epoch: 1 }, { ...owner, epoch: 2 }]) {
        const f = platformVideoFixture(); await acceptPlatformVideo(f); const reading = f.session.refresh();
        f.change(replacement); const stored = structuredClone([...f.rows.values()]); f.reading.resolve(f.view()); await reading;
        expect([...f.rows.values()]).toEqual(stored); expect(f.counts()).toEqual({ creates: 1, reads: 1 });
    }
});
test("missing original video publication evidence is unconfirmed and never unlocks another create", async () => {
    const f = platformVideoFixture(); await acceptPlatformVideo(f);
    const missing = { ...f.view(), task: { ...f.view().task, video: undefined } }; expect(parseVideoTaskView(missing)).toBeNull();
    f.client.get = async () => { throw new Error("原来源无法确认"); }; await f.session.refresh(); await f.session.confirm();
    expect(f.session.getState().phase).toBe("uncertain"); expect(f.session.getState().view?.task.id).toBe(videoId); expect(f.counts().creates).toBe(1);
});
test("a changed model or specification cannot replace the accepted task's immutable receipt", async () => {
    const f = platformVideoFixture(); await acceptPlatformVideo(f);
    f.client.get = async () => { const wrong = f.view(); wrong.task.modelId = "different-model"; return wrong; }; await f.session.refresh();
    expect(f.session.getState().phase).toBe("uncertain"); expect(f.rows.get(`video:${videoId}`)?.view?.task.modelId).toBe(f.intent.modelId); expect(f.counts().creates).toBe(1);
});
test("input or catalogue changes after quote confirmation prevent a new video from being sent", async () => {
    const f = platformVideoFixture(); await f.session.prepare(f.intent); f.invalidate(); await f.session.confirm();
    expect(f.counts()).toEqual({ creates: 0, reads: 0 }); expect(f.rows.size).toBe(0);
});
test("editing a new video description while an original task read is in flight never rebinds or restarts that task", async () => {
    const f = platformVideoFixture(); await acceptPlatformVideo(f); const reading = f.session.refresh(); f.invalidate(); f.reading.resolve(f.view()); await reading;
    expect(f.session.getState().receipt?.intent).toEqual(f.intent); expect(f.session.getState().view?.task.id).toBe(videoId); expect(f.counts()).toEqual({ creates: 1, reads: 1 });
});
function platformReferenceFixture(count: number) {
    const original = Array.from({ length: count }, (_, n) => ({ id: String(n), name: `${n}.png`, type: "image/png", dataUrl: "", storageKey: `image:${n}` }));
    const refs = { current: original }, state = { references: original, uploads: 0, updates: 0 };
    const environment: Value = { refs, uploads: { current: false }, current: () => true, CREATION_DRAFT_REFERENCE_LIMIT,
        message: { warning: () => {}, error: () => {} }, File, nanoid: () => "next-reference", setUploading: () => {},
        setReferences: (items: typeof original) => { state.references = items; state.updates++; }, setPrompt: () => {}, setAssetsOpen: () => {},
        navigator: { clipboard: { read: async () => [{ types: ["image/png"], getType: async () => new Blob(["image"], { type: "image/png" }) }] } },
        uploadImage: async () => { state.uploads++; return { url: "blob:fixture", storageKey: "image:fixture", mimeType: "image/png" }; } };
    environment.append = pageCallback("video", "append", environment);
    environment.addFiles = pageCallback("video", "addFiles", environment);
    return { original, state, callback: (name: string) => pageCallback("video", name, environment) };
}
test("video reference ingress refuses a fifteenth image through file, clipboard and asset without truncating the draft", async () => {
    for (const ingress of ["invalid-file", "valid-file", "clipboard", "asset"]) {
        const f = platformReferenceFixture(14);
        if (ingress === "clipboard") await f.callback("clipboard")();
        else if (ingress === "asset") await f.callback("insertAsset")({ kind: "image", title: "extra", dataUrl: "data:image/png;base64,extra" });
        else await f.callback("addFiles")([new File(["reference"], "extra", { type: ingress === "valid-file" ? "image/png" : "text/plain" })]);
        expect(f.state.references).toBe(f.original); expect(f.state.references).toHaveLength(14); expect(f.state.uploads).toBe(0); expect(f.state.updates).toBe(0);
    }
});
test("video references reject the whole overflowing batch and accept exactly the fourteenth slot", async () => {
    for (const count of [2, 1]) {
        const f = platformReferenceFixture(13); await f.callback("addFiles")(Array.from({ length: count }, () => new File(["reference"], "next.png", { type: "image/png" })));
        expect(f.state.references.slice(0, 13)).toEqual(f.original); expect(f.state.references).toHaveLength(count === 1 ? 14 : 13); expect(f.state.uploads).toBe(count === 1 ? 1 : 0);
    }
});
test("video accepts an eighth draft image while seven-send and the narrower zero-or-one protocol intersection remain enforced", async () => {
    const f = platformReferenceFixture(7); await f.callback("addFiles")([new File(["reference"], "eight.png", { type: "image/png" })]);
    expect(f.state.references).toHaveLength(8); const selection = { source: "platform-video" as const, modelId: "fixture-video", parameters: videoParameters };
    expect(videoReferenceIssue(8, selection)).toContain("7"); expect(f.state.references).toHaveLength(8);
    expect(videoReferenceIssue(1, selection)).toContain("不支持参考");
    expect(videoReferenceIssue(1, { ...selection, parameters: { mode: "first_frame", resolution: "480p", durationSeconds: 1, generateAudio: false } })).toBe("");
});
