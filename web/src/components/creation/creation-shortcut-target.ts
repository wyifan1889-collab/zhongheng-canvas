import type { CreationMediaKind, CreationMediaScope } from "@/stores/use-creation-media-launch";

type DraftState = {
    scope: CreationMediaScope | null; ready: boolean; error: string; pending: unknown;
    drafts: Partial<Record<CreationMediaKind, { prompt: string; revision: number }>>;
};
type TargetState = { scope: CreationMediaScope; locationKey: string; ready: boolean; watch: readonly unknown[] };
type Target = { read: () => TargetState; apply: (prompt: string) => void };
type Capture = { status: "absent" | "blocked" } | { status: "captured"; apply: (prompt: string) => boolean };
const sameScope = (left: CreationMediaScope, right: CreationMediaScope | null) => !!right && left.accountId === right.accountId && left.epoch === right.epoch;

/** A shortcut may update its mounted editor once, after its own persisted write. */
export function createCreationShortcutRegistry(options: { getScope: () => CreationMediaScope | null; getDraftState: () => DraftState }) {
    const targets = new Map<CreationMediaKind, Target>();
    const draftsReady = (scope: CreationMediaScope, state: DraftState) => state.ready && !state.error && !state.pending && sameScope(scope, state.scope) && sameScope(scope, options.getScope());
    return {
        register(kind: CreationMediaKind, target: Target) {
            targets.set(kind, target);
            return () => { if (targets.get(kind) === target) targets.delete(kind); };
        },
        capture(kind: CreationMediaKind): Capture {
            const target = targets.get(kind);
            if (!target) return { status: "absent" };
            const before = target.read(), state = options.getDraftState(), draft = state.drafts[kind];
            if (!before.ready || !draftsReady(before.scope, state) || !draft) return { status: "blocked" };
            const scope = { ...before.scope }, watch = [...before.watch], locationKey = before.locationKey, revision = draft.revision;
            let consumed = false;
            return { status: "captured", apply(prompt) {
                if (consumed) return false;
                consumed = true;
                if (targets.get(kind) !== target) return false;
                const next = target.read(), state = options.getDraftState(), draft = state.drafts[kind];
                if (!next.ready || !sameScope(scope, next.scope) || next.locationKey !== locationKey || watch.length !== next.watch.length
                    || watch.some((value, index) => !Object.is(value, next.watch[index])) || !draftsReady(scope, state)
                    || !draft || draft.revision !== revision + 1 || draft.prompt !== prompt) return false;
                target.apply(prompt);
                return true;
            } };
        },
    };
}
