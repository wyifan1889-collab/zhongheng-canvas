import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { isCreationMediaTarget } from "@/lib/creation-routes";
import { createCreationMediaLaunchStore, emptyAudioParameters, personalMediaParameters, type CreationMediaKind } from "@/stores/use-creation-media-launch";
import { emptyVideoParameters } from "@/pages/video/video-parameters";

type Environment = Record<string, any>;
const scope = { accountId: "pending-mode-owner", epoch: 1 };
const sources = new Map<CreationMediaKind, ts.SourceFile>();

// Evaluate the original page effects with the real account draft/one-shot store.
// No DOM, provider, billing, session injection or product fixture is involved.
function effect(kind: CreationMediaKind, marker: string, environment: Environment) {
    let source = sources.get(kind);
    if (!source) {
        source = ts.createSourceFile(`${kind}/index.tsx`, readFileSync(new URL(`./${kind}/index.tsx`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        sources.set(kind, source);
    }
    let callback: ts.Expression | undefined;
    const callbacks = new Map<string, ts.Expression>();
    const visit = (node: ts.Node) => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) callbacks.set(node.name.text, node.initializer);
        if (ts.isCallExpression(node) && node.expression.getText(source) === "useEffect" && node.arguments[0]) {
            const argument = node.arguments[0], candidate = ts.isIdentifier(argument) ? callbacks.get(argument.text) : argument;
            if (candidate?.getText(source).includes(marker)) callback = candidate;
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!callback) throw new Error(`Missing ${kind} page effect ${marker}`);
    const javascript = ts.transpileModule(`return (${callback.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    return new Function(...Object.keys(environment), javascript)(...Object.values(environment)) as () => void;
}

async function fixture(kind: CreationMediaKind) {
    let sequence = 0, takes = 0, writes = 0, starts = 0;
    const store = createCreationMediaLaunchStore({ getScope: () => scope, nonce: () => `mode-${++sequence}`,
        storage: () => ({ getItem: async () => null, setItem: async () => {} }) });
    await store.getState().load();
    const config = { model: "synthetic-media", imageModel: "synthetic-media", videoModel: "synthetic-media" };
    const input = (prompt: string) => ({ kind, prompt, references: [], parameters: kind === "audio" ? { ...emptyAudioParameters(), model: "synthetic-audio", voice: "default", format: "wav" as const, prompt } : config });
    const consumedLaunch = { current: "" }, handledLaunch = { current: "" };
    const environment: Environment = {
        scope, draftReady: true, current: () => true, running: false, busy: false, generationLock: { current: false }, activeLogIdsRef: { current: new Set() },
        consumedLaunch, handledLaunch, location: { pathname: "/create", search: `?mode=${kind}` }, isCreationMediaTarget,
        platformMode: false, personalMediaParameters, effectiveConfig: config, config, model: "synthetic-media", prompt: "old local input", references: [],
        setPrompt: (prompt: string) => { environment.prompt = prompt; }, setReferences: (references: unknown[]) => { environment.references = references; },
        updateConfig: (key: string, value: string) => { config[key as keyof typeof config] = value; },
        setCreationLaunch: (launch: unknown) => { environment.creationLaunch = launch; },
        setCreationError: () => {}, setError: () => {}, isAiConfigReady: () => true,
        setSelection: (selection: unknown) => { environment.selection = selection; }, setLegacyNotice: () => {}, emptyVideoParameters,
        generate: () => { starts++; }, showQuote: () => { starts++; },
        parameters: { ...emptyAudioParameters() }, editRevision: { current: 0 }, setConfirmation: () => {},
        draftOwner: { current: undefined }, defaultSeed: { current: null }, defaultModel: { current: null }, setDraftSaveNotice: () => {}, music: false,
        setParameters: (parameters: unknown) => { environment.parameters = parameters; },
        modelsLoading: false, loaded: true, historyError: "", models: [],
        selectedModel: { audio: { voices: ["default"], formats: ["wav"], instructions: false } },
        useCreationMediaLaunch: { getState: () => ({ ...store.getState(), take: (value: CreationMediaKind) => { takes++; return store.getState().take(value); },
            edit: (value: any) => { writes++; return store.getState().edit(value); } }) },
    };
    const refresh = () => { environment.creation = store.getState(); };
    return { store, environment, refresh, counts: () => ({ takes, writes, starts }),
        stage: async (prompt: string) => { await store.getState().edit(input(prompt)); expect(await store.getState().stage(kind)).toBe(true); refresh(); },
        consume: () => effect(kind, "consumedLaunch.current === creation.pending.nonce", environment)(),
        start: () => effect(kind, "handledLaunch.current === creationLaunch.nonce", environment)(),
        persist: () => effect(kind, `previous = useCreationMediaLaunch.getState().drafts.${kind}`, environment)(),
    };
}

test.each(["image", "video", "audio"] as const)("same mounted %s mode takes each new pending nonce once and never replays it for query changes", async kind => {
    const f = await fixture(kind);
    for (const prompt of ["first explicit intent", "second explicit intent"]) {
        await f.stage(prompt);
        // The page still has old local input in this render; it must not write it
        // over the newly staged store draft before consuming the new nonce.
        f.persist(); expect(f.counts().writes).toBe(0);
        f.consume(); f.consume();
        f.refresh();
        expect(f.store.getState().pending).toBeNull();
        expect(kind === "audio" ? f.environment.parameters.prompt : f.environment.prompt).toBe(prompt);
        if (kind !== "video") { f.start(); f.start(); }
        f.environment.location.search += "&receipt=retained";
        f.consume(); if (kind !== "video") f.start();
    }
    expect(f.counts()).toEqual({ takes: 2, writes: 0, starts: kind === "video" ? 0 : 2 });
    if (kind === "video") expect(f.environment.selection.source).toBe("platform-video");
});

test.each(["image", "video", "audio"] as const)("%s pending consumption refuses foreign modes, the music alias and stale page ownership", async kind => {
    const f = await fixture(kind); await f.stage("still owned by the original intent");
    for (const location of [{ pathname: "/music", search: "" }, { pathname: "/create", search: "?mode=agent" }, { pathname: "/create", search: `?mode=${kind}&mode=${kind}` }]) {
        f.environment.location = location; f.consume();
        expect(f.counts().takes).toBe(0); expect(f.store.getState().pending).not.toBeNull();
    }
    f.environment.location = { pathname: "/create", search: `?mode=${kind}` }; f.environment.current = () => false; f.consume();
    expect(f.counts()).toEqual({ takes: 0, writes: 0, starts: 0 });
    expect(f.store.getState().pending?.draft.prompt).toBe("still owned by the original intent");
});
