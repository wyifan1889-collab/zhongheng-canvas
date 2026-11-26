import { create } from "zustand";
import localforage from "localforage";
import type { AudioParameters } from "@/pages/audio/audio-parameters";
import type { VideoDraftParameters } from "@/pages/video/video-parameters";
import { parseVideoParameters } from "../../../packages/shared/src/generation-video";
import type { AiConfig } from "./use-config-store";
import type { ReferenceImage } from "@/types/image";
import { CREATION_DRAFT_REFERENCE_LIMIT, creationReferenceSendIssue } from "@/lib/creation-reference-limits";
import { accountScopedStoreName } from "@/services/saas/account-local-scope";
import { useAccountStore } from "./use-account-store";
import { ensureImagePreview, resolveImageUrl } from "@/services/image-storage";

export type CreationMediaKind = "image" | "video" | "audio";
export type CreationMediaScope = { accountId: string; epoch: number };
const personalKeys = ["model", "imageModel", "videoModel", "quality", "size", "count", "background", "vquality", "videoSeconds", "videoGenerateAudio", "videoWatermark", "videoMode"] as const;
export type PersonalMediaParameters = Partial<Pick<AiConfig, typeof personalKeys[number]>> & { mappingModelId?: string; mappingSpecification?: string };
export type CreationMediaDraft = { kind: CreationMediaKind; prompt: string; references: ReferenceImage[]; parameters: PersonalMediaParameters | AudioParameters | VideoDraftParameters; revision: number };
export type CreationMediaLaunch = { nonce: string; scope: CreationMediaScope; draft: CreationMediaDraft };
type DraftInput = Omit<CreationMediaDraft, "revision">;
type DraftStorage = { getItem(key: CreationMediaKind): Promise<unknown>; setItem(key: CreationMediaKind, value: CreationMediaDraft): Promise<unknown> };
type State = {
    scope: CreationMediaScope | null; loading: boolean; ready: boolean; error: string; drafts: Partial<Record<CreationMediaKind, CreationMediaDraft>>; pending: CreationMediaLaunch | null;
    load: () => Promise<void>; edit: (draft: DraftInput) => Promise<boolean>; stage: (kind: CreationMediaKind) => Promise<boolean>;
    editPersonalParameter: (kind: "image" | "video", key: keyof PersonalMediaParameters, value: string, config: PersonalMediaParameters) => Promise<boolean>;
    take: (kind: CreationMediaKind) => CreationMediaLaunch | null; isCurrent: (launch: CreationMediaLaunch) => boolean;
    cancel: () => void; inspire: (kind: CreationMediaKind, prompt: string) => Promise<boolean>;
};
const sameScope = (a: CreationMediaScope | null, b: CreationMediaScope | null) => !!a && !!b && a.accountId === b.accountId && a.epoch === b.epoch;
export const personalMediaParameters = (config: PersonalMediaParameters | AudioParameters | VideoDraftParameters): PersonalMediaParameters => {
    const values = config as Partial<Record<typeof personalKeys[number], unknown>>;
    return Object.fromEntries(personalKeys.filter(key => typeof values[key] === "string").map(key => [key, values[key]]));
};
export const imageMediaParameters = (config: CreationMediaDraft["parameters"]): PersonalMediaParameters => {
    const mapping = config as PersonalMediaParameters;
    return { ...personalMediaParameters(config),
        ...(typeof mapping.mappingModelId === "string" ? { mappingModelId: mapping.mappingModelId } : {}),
        ...(typeof mapping.mappingSpecification === "string" ? { mappingSpecification: mapping.mappingSpecification } : {}) };
};
export const emptyAudioParameters = (): AudioParameters => ({ prompt: "", model: "", voice: "", style: "", language: "", format: "mp3", loop: false, instrumental: false });
function clean(input: DraftInput): DraftInput {
    if (!input.prompt || typeof input.prompt !== "string") { if (input.prompt !== "") throw new Error("创作草稿内容无法读取。"); }
    if (!Array.isArray(input.references) || input.references.length > CREATION_DRAFT_REFERENCE_LIMIT || input.references.some(item => !item || [item.id, item.name, item.type, item.dataUrl].some(value => typeof value !== "string"))) throw new Error("草稿最多保留14个参考素材；已有草稿已保留。");
    const platformVideo = input.kind === "video" && "source" in input.parameters && input.parameters.source === "platform-video";
    const video = platformVideo ? input.parameters as VideoDraftParameters : null;
    if (video && (typeof video.modelId !== "string" || video.parameters !== null && !parseVideoParameters(video.parameters) ||
        video.mappingModelId !== undefined && typeof video.mappingModelId !== "string" || video.specification !== undefined && typeof video.specification !== "string")) throw new Error("平台视频草稿参数无法读取。");
    const parameters = input.kind === "audio" ? input.parameters as AudioParameters : video
        ? { source: "platform-video" as const, modelId: video.modelId, parameters: video.parameters && parseVideoParameters(video.parameters),
            ...(video.mappingModelId !== undefined ? { mappingModelId: video.mappingModelId } : {}), ...(video.specification !== undefined ? { specification: video.specification } : {}),
            ...(video.legacy ? { legacy: personalMediaParameters(video.legacy) } : {}) } : input.kind === "image" ? imageMediaParameters(input.parameters) : personalMediaParameters(input.parameters as PersonalMediaParameters);
    if (input.kind === "audio" && (["model", "voice", "style", "language"].some(key => typeof (parameters as AudioParameters)[key as keyof AudioParameters] !== "string") || !["mp3", "wav"].includes((parameters as AudioParameters).format) || (parameters as AudioParameters).loop !== false || (parameters as AudioParameters).instrumental !== false || (parameters as AudioParameters).seconds !== undefined)) throw new Error("音频草稿参数无法读取。");
    const audio = parameters as AudioParameters;
    return { kind: input.kind, prompt: input.prompt, references: input.references.map(item => ({ id: item.id, name: item.name, type: item.type, dataUrl: item.dataUrl, ...(item.storageKey ? { storageKey: item.storageKey } : {}) })), parameters: input.kind === "audio" ? { ...emptyAudioParameters(), model: audio.model, voice: audio.voice, format: audio.format, style: audio.style, language: audio.language, prompt: input.prompt } : parameters };
}

/** Drafts are account-local data. Only the one-shot execution intent stays in memory. */
export function createCreationMediaLaunchStore(options: { getScope: () => CreationMediaScope | null; storage: (scope: CreationMediaScope) => DraftStorage; nonce?: () => string; resolveReferences?: (references: ReferenceImage[]) => Promise<ReferenceImage[]> }) {
    let readVersion = 0, hydration: Promise<void> | null = null;
    const writes = new Map<string, Promise<unknown>>();
    return create<State>((set, get) => ({
        scope: null, loading: false, ready: false, error: "", drafts: {}, pending: null,
        load() {
            const scope = options.getScope(), previous = get();
            if (sameScope(scope, previous.scope)) return hydration ?? Promise.resolve();
            const version = ++readVersion;
            set({ scope: scope ? { ...scope } : null, loading: !!scope, ready: false, drafts: {}, pending: null, error: "" });
            if (!scope) { hydration = null; return Promise.resolve(); }
            const operation = (async () => {
                try {
                    await writes.get(scope.accountId);
                    const storage = options.storage(scope), drafts: State["drafts"] = {};
                    for (const kind of ["image", "video", "audio"] as const) {
                        const value = await storage.getItem(kind);
                        if (value == null) continue;
                        const candidate = value as CreationMediaDraft;
                        if (candidate.kind !== kind || !Number.isSafeInteger(candidate.revision) || candidate.revision < 0) throw new Error("创作草稿无法读取，请保留本机数据。");
                        const draft = clean(candidate);
                        drafts[kind] = { ...draft, references: await (options.resolveReferences?.(draft.references) ?? Promise.resolve(draft.references)), revision: candidate.revision };
                    }
                    if (version === readVersion && sameScope(scope, options.getScope())) set({ drafts, loading: false, ready: true });
                } catch (cause) { if (version === readVersion && sameScope(scope, options.getScope())) set({ loading: false, error: cause instanceof Error ? cause.message : "创作草稿读取失败，请保留本机数据。" }); }
                finally { if (version === readVersion) hydration = null; }
            })();
            hydration = operation; return operation;
        },
        async edit(input) {
            const scope = options.getScope();
            if (!sameScope(scope, get().scope) || !get().ready || !scope) return false;
            let draft: CreationMediaDraft;
            try { draft = { ...clean(input), revision: (get().drafts[input.kind]?.revision ?? 0) + 1 }; }
            catch (cause) { set({ error: cause instanceof Error ? cause.message : "草稿未更新。" }); return false; }
            set(state => ({ drafts: { ...state.drafts, [input.kind]: draft }, pending: state.pending?.draft.kind === input.kind ? null : state.pending, error: "" }));
            const persisted = { ...draft, references: draft.references.map(item => item.storageKey ? { ...item, dataUrl: "", url: undefined } : item) };
            const write = (writes.get(scope.accountId) ?? Promise.resolve()).catch(() => {}).then(() => options.storage(scope).setItem(input.kind, persisted));
            writes.set(scope.accountId, write);
            try { await write; return sameScope(scope, options.getScope()); }
            catch { if (sameScope(scope, options.getScope())) set({ error: "草稿保存失败，当前输入仍在页面中，请保留此页。" }); return false; }
        },
        editPersonalParameter(kind, key, value, config) {
            const draft = get().drafts[kind];
            if (!draft) return Promise.resolve(false);
            if (kind === "video" && "source" in draft.parameters && draft.parameters.source === "platform-video") return Promise.resolve(false);
            return get().edit({ ...draft, parameters: personalMediaParameters({ ...config, ...draft.parameters, [key]: value }) });
        },
        async stage(kind) {
            const scope = options.getScope(), draft = get().drafts[kind];
            if (!scope || !sameScope(scope, get().scope) || !get().ready || get().error || !draft || !draft.prompt.trim()) return false;
            if (creationReferenceSendIssue(draft.references.length, kind)) return false;
            try { await writes.get(scope.accountId); } catch { return false; }
            if (!sameScope(scope, options.getScope()) || get().drafts[kind]?.revision !== draft.revision || get().pending) return false;
            set({ pending: { nonce: options.nonce?.() ?? crypto.randomUUID(), scope: { ...scope }, draft } }); return true;
        },
        take(kind) {
            const pending = get().pending;
            if (!pending || pending.draft.kind !== kind) return null;
            set({ pending: null });
            return get().isCurrent(pending) ? pending : null;
        },
        isCurrent: launch => sameScope(launch.scope, options.getScope()) && sameScope(launch.scope, get().scope) && get().drafts[launch.draft.kind]?.revision === launch.draft.revision,
        cancel: () => set({ pending: null }),
        async inspire(kind, prompt) {
            const scope = options.getScope(), revision = get().drafts[kind]?.revision;
            await get().load();
            if (!scope || !sameScope(scope, options.getScope()) || !get().ready || get().error || revision !== undefined && get().drafts[kind]?.revision !== revision) return false;
            const draft = get().drafts[kind];
            return get().edit({ kind, prompt, references: draft?.references ?? [], parameters: draft?.parameters ?? (kind === "audio" ? emptyAudioParameters() : {}) });
        },
    }));
}

const stores = new Map<string, ReturnType<typeof localforage.createInstance>>();
export const useCreationMediaLaunch = createCreationMediaLaunchStore({ getScope: () => useAccountStore.getState().getDraftScope(), resolveReferences: references => Promise.all(references.map(async reference => {
    void ensureImagePreview(reference.storageKey);
    return { ...reference, dataUrl: await resolveImageUrl(reference.storageKey, reference.dataUrl) };
})), storage: scope => {
    const name = accountScopedStoreName("creation_media_drafts", scope);
    let storage = stores.get(name);
    if (!storage) { storage = localforage.createInstance({ name: "infinite-canvas", storeName: name }); stores.set(name, storage); }
    return storage;
} });
useAccountStore.subscribe(() => { void useCreationMediaLaunch.getState().load(); });
void useCreationMediaLaunch.getState().load();
export const applyCreationMediaInspiration = (kind: CreationMediaKind, prompt: string) => useCreationMediaLaunch.getState().inspire(kind, prompt);
