import { useEffect, useRef, useState } from "react";
import { useAccountStore } from "@/stores/use-account-store";
import { GenerationError } from "@/services/saas/generation";
import { createGenerationHistoryClient, type GenerationHistoryItem, type GenerationHistoryScope } from "@/services/saas/generation-history";
import { readImageConversations, subscribeImageConversations } from "@/pages/image/image-conversations";

type SidebarHistoryState = { phase: "idle" | "loading" | "ready" | "error"; items: GenerationHistoryItem[]; blocked: boolean };
const empty = (): SidebarHistoryState => ({ phase: "idle", items: [], blocked: false });
const scopeKey = (scope: GenerationHistoryScope | null) => scope ? JSON.stringify([scope.accountId, scope.epoch]) : null;

/** A sidebar-owned reader: opening/refreshing is the only trigger, with no timers or storage. */
export function createSidebarHistoryReader(options: {
    scope: GenerationHistoryScope; getScope: () => GenerationHistoryScope | null; onState: (state: SidebarHistoryState) => void;
    client?: Pick<ReturnType<typeof createGenerationHistoryClient>, "read">;
}) {
    const owner = scopeKey(options.scope), client = options.client ?? createGenerationHistoryClient(options);
    let state = empty(), sequence = 0, stopped = false, pending: AbortController | null = null;
    const current = () => !stopped && scopeKey(options.getScope()) === owner;
    const publish = (next: SidebarHistoryState) => { state = next; options.onState(next); };
    const cancel = () => { sequence++; pending?.abort(); pending = null; };
    return {
        snapshot: () => current() ? state : empty(),
        syncScope() {
            if (current() || stopped) return;
            cancel(); stopped = true; publish(empty());
        },
        close() { cancel(); stopped = true; },
        async read() {
            if (!current() || state.blocked) return;
            cancel();
            const request = sequence, operation = new AbortController(); pending = operation;
            const active = () => current() && request === sequence && !operation.signal.aborted;
            publish({ ...state, phase: "loading" });
            try {
                const page = await client.read({ pageNumber: 1, pageSize: 50 }, operation.signal);
                if (active()) publish({ phase: "ready", items: page.items.slice(0, 8), blocked: false });
            } catch (cause) {
                if (!active()) return;
                const blocked = cause instanceof GenerationError && (cause.status === 401 || ["context_changed", "account_changed", "account_context_required", "unauthorized"].includes(cause.code));
                publish({ phase: "error", items: blocked ? [] : state.items, blocked });
            } finally { if (pending === operation) pending = null; }
        },
    };
}

export function useAppSidebarHistory(expanded: boolean) {
    const key = useAccountStore((account) => scopeKey(account.getDraftScope()));
    const [owned, setOwned] = useState<{ key: string | null; state: SidebarHistoryState }>({ key: null, state: empty() });
    const reader = useRef<ReturnType<typeof createSidebarHistoryReader> | null>(null);
    const [ownedConversations, setOwnedConversations] = useState<{ key: string | null; items: Awaited<ReturnType<typeof readImageConversations>> }>({ key: null, items: [] });
    useEffect(() => {
        const scope = useAccountStore.getState().getDraftScope();
        if (!expanded || !scope) { setOwned({ key: null, state: empty() }); return; }
        const instance = createSidebarHistoryReader({ scope, getScope: () => useAccountStore.getState().getDraftScope(), onState: (state) => setOwned({ key: scopeKey(scope), state }) });
        reader.current = instance;
        const unsubscribe = useAccountStore.subscribe(() => instance.syncScope());
        void instance.read();
        return () => { unsubscribe(); instance.close(); if (reader.current === instance) reader.current = null; };
    }, [expanded, key]);
    useEffect(() => {
        const scope = useAccountStore.getState().getDraftScope();
        if (!expanded || !scope) return;
        const captured = scopeKey(scope);
        let active = true, version = 0;
        const read = () => {
            const request = ++version;
            void readImageConversations(scope).then(items => {
                if (active && request === version && scopeKey(useAccountStore.getState().getDraftScope()) === captured)
                    setOwnedConversations({ key: captured, items });
            }).catch(() => undefined);
        };
        read();
        const unsubscribe = subscribeImageConversations(read);
        return () => { active = false; unsubscribe(); };
    }, [expanded, key]);
    return { ...(expanded && key !== null && owned.key === key ? owned.state : empty()), authenticated: key !== null,
        conversations: expanded && key !== null && ownedConversations.key === key ? ownedConversations.items : [],
        refresh: () => { void reader.current?.read(); } };
}
