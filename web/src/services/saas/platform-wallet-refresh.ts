import type { DraftAccountScope } from "./drafts";
import type { PlatformWallet } from "./platform";

type WalletState = { status: "loading" | "ready" | "unavailable"; wallet: PlatformWallet | null };
const listeners = new Set<(scope: DraftAccountScope) => void>();
const sameScope = (left: DraftAccountScope | null, right: DraftAccountScope) => !!left && left.accountId === right.accountId && left.epoch === right.epoch;

/** A read-only wallet refresh hint; never changes the account session or estimates a debit. */
export function invalidatePlatformWallet(scope: DraftAccountScope) {
    const fixed = Object.freeze({ accountId: scope.accountId, epoch: scope.epoch });
    for (const listener of listeners) {
        try { listener(fixed); } catch { /* A wallet observer cannot change a confirmed task outcome. */ }
    }
}

/** One account-menu lifetime. New reads supersede old replies, including old failures. */
export function createPlatformWalletReader(options: {
    scope: DraftAccountScope;
    getScope: () => DraftAccountScope | null;
    read: () => Promise<PlatformWallet>;
    onState: (state: WalletState) => void;
}) {
    const scope = Object.freeze({ ...options.scope });
    let active = true, version = 0;
    const isCurrent = () => active && sameScope(options.getScope(), scope);
    const emit = (state: WalletState) => { try { options.onState(state); } catch { /* Rendering cannot reject a wallet read or task acceptance. */ } };
    async function refresh() {
        if (!isCurrent()) return;
        const request = ++version;
        try {
            emit({ status: "loading", wallet: null });
            if (!isCurrent() || request !== version) return;
            const wallet = await options.read();
            if (isCurrent() && request === version) emit({ status: "ready", wallet });
        } catch {
            if (isCurrent() && request === version) emit({ status: "unavailable", wallet: null });
        }
    }
    const listener = (changed: DraftAccountScope) => { if (sameScope(changed, scope)) void refresh(); };
    listeners.add(listener);
    return { refresh, close() { active = false; listeners.delete(listener); } };
}
