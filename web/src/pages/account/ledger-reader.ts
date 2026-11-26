import type { DraftAccountScope } from "@/services/saas/drafts";
import { createWalletLedgerClient, WalletLedgerError, type WalletLedgerState } from "@/services/saas/wallet-ledger";

/** A page lifetime; scope loss is terminal and a newer manual read supersedes older replies. */
export function createWalletLedgerReader(options: {
    scope: DraftAccountScope; getScope: () => DraftAccountScope | null; onState: (state: WalletLedgerState) => void;
    client?: ReturnType<typeof createWalletLedgerClient>;
}) {
    const scope = Object.freeze({ ...options.scope }), client = options.client ?? createWalletLedgerClient(options);
    let active = true, version = 0, operation: AbortController | null = null;
    function syncScope() {
        const current = options.getScope();
        if (active && (current?.accountId !== scope.accountId || current.epoch !== scope.epoch)) {
            active = false; operation?.abort();
            options.onState({ phase: "error", items: [], error: "accountChanged" });
        }
        return active;
    }
    return {
        syncScope,
        async read() {
            if (!syncScope()) return;
            const request = ++version;
            operation?.abort(); operation = new AbortController();
            options.onState({ phase: "loading", items: [] });
            try {
                const items = await client.read(operation.signal);
                if (syncScope() && request === version) options.onState({ phase: "ready", items });
            } catch (error) {
                if (!syncScope() || request !== version) return;
                if (error instanceof WalletLedgerError && error.code === "aborted") return;
                const reason = error instanceof WalletLedgerError && error.code === "unauthorized" ? "signInRequired"
                    : error instanceof WalletLedgerError && error.code === "context_changed" ? "accountChanged" : "readFailed";
                if (reason !== "readFailed") active = false;
                options.onState({ phase: "error", items: [], error: reason });
            }
        },
        close() { active = false; operation?.abort(); },
    };
}
