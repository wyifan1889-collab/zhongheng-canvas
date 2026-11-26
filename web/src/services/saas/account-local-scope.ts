/**
 * Browser-local ownership boundary for account-scoped data.
 *
 * The account session is the only source of identity here.  Local stores must
 * subscribe to this value before reading or writing data; an unset scope is
 * deliberately treated as anonymous and never falls back to the legacy global
 * store.  Existing unscoped data therefore stays quarantined until an explicit
 * import flow claims it.
 */

export type AccountLocalScope = { accountId: string; epoch: number } | null;
type Listener = (scope: AccountLocalScope) => void;

let accountId: string | null = null;
let epoch = 0;
const listeners = new Set<Listener>();

export function getAccountLocalScope(): AccountLocalScope {
    return accountId ? { accountId, epoch } : null;
}

/** Pin one local operation, including anonymous → account → anonymous changes. */
export function captureAccountLocalScope() {
    const generation = epoch;
    return {
        scope: getAccountLocalScope(),
        isCurrent: () => generation === epoch,
        assertCurrent: () => {
            if (generation !== epoch) throw new Error("本机素材所属账号已变化，请重新打开后再试。");
        },
    };
}

export function setAccountLocalAccount(nextAccountId: string | null | undefined) {
    const normalized = typeof nextAccountId === "string" && nextAccountId.trim() ? nextAccountId.trim() : null;
    if (normalized === accountId) return;
    accountId = normalized;
    epoch += 1;
    const scope = getAccountLocalScope();
    listeners.forEach((listener) => listener(scope));
}

export function subscribeAccountLocalScope(listener: Listener) {
    listeners.add(listener);
    listener(getAccountLocalScope());
    return () => listeners.delete(listener);
}

/**
 * IndexedDB object-store names are shared by every account in an origin.  A
 * stable suffix keeps each account's files physically separate while retaining
 * the existing storageKey format in canvas documents.
 */
export function accountScopedStoreName(baseName: string, scope = getAccountLocalScope()) {
    if (!scope) return `${baseName}_anonymous`;
    return `${baseName}_account_${encodeURIComponent(scope.accountId)}`;
}

