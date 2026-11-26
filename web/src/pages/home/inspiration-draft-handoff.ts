import { emptyAudioParameters, type CreationMediaKind, type CreationMediaScope, type useCreationMediaLaunch } from "@/stores/use-creation-media-launch";

export type InspirationDraftIntent = { kind: CreationMediaKind; prompt: string };
type DraftStore = Pick<typeof useCreationMediaLaunch, "getState">;
type Dependencies = { store: DraftStore; getScope: () => CreationMediaScope | null };
export type PreparedInspiration = InspirationDraftIntent & { scope: CreationMediaScope; revision: number | null; existingPrompt: string; referenceCount: number };
const sameScope = (a: CreationMediaScope | null, b: CreationMediaScope | null) => !!a && !!b && a.accountId === b.accountId && a.epoch === b.epoch;

export function buildInspirationHref(kind: CreationMediaKind, prompt: string) {
    return `/create?${new URLSearchParams({ mode: kind, prompt }).toString()}`;
}

export function readInspirationDraftIntent(search: string): { intent: InspirationDraftIntent | null; invalid: boolean } {
    const query = new URLSearchParams(search);
    if (!query.has("prompt")) {
        const modes = query.getAll("mode");
        return { intent: null, invalid: modes.length > 1 || modes.length === 1 && !["image", "video", "audio", "agent"].includes(modes[0]) };
    }
    const kind = query.get("mode"), prompt = query.get("prompt");
    if (query.getAll("mode").length !== 1 || query.getAll("prompt").length !== 1 || !["image", "video", "audio"].includes(kind ?? "") || !prompt?.trim()) return { intent: null, invalid: true };
    return { intent: { kind: kind as CreationMediaKind, prompt }, invalid: false };
}

/** Read the account draft first; merely visiting a link never edits or stages it. */
export async function prepareInspirationDraft(intent: InspirationDraftIntent, { store, getScope }: Dependencies): Promise<PreparedInspiration | null> {
    const scope = getScope();
    if (!scope) return null;
    await store.getState().load();
    const state = store.getState();
    if (!sameScope(scope, getScope()) || !sameScope(scope, state.scope) || !state.ready || state.error) return null;
    const draft = state.drafts[intent.kind];
    return { ...intent, scope: { ...scope }, revision: draft?.revision ?? null, existingPrompt: draft?.prompt ?? "", referenceCount: draft?.references.length ?? 0 };
}

/** Only a fresh explicit confirmation may replace the prompt. Reuse the original
 * draft write and its scope/persistence guards; never call stage or a generator. */
export async function applyPreparedInspiration(prepared: PreparedInspiration, { store, getScope }: Dependencies): Promise<"applied" | "changed" | "save-failed"> {
    const state = store.getState(), draft = state.drafts[prepared.kind];
    if (!sameScope(prepared.scope, getScope()) || !sameScope(prepared.scope, state.scope) || !state.ready || state.error || (draft?.revision ?? null) !== prepared.revision) return "changed";
    store.getState().cancel();
    const parameters = draft?.parameters ?? (prepared.kind === "audio" ? emptyAudioParameters() : {});
    const saved = await store.getState().edit({ kind: prepared.kind, prompt: prepared.prompt, references: draft?.references ?? [], parameters });
    if (!sameScope(prepared.scope, getScope())) return "changed";
    return saved ? "applied" : "save-failed";
}
