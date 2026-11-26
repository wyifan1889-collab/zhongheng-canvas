import { expect, test } from "bun:test";
import type { DraftAccountScope } from "@/services/saas/drafts";
import { WalletLedgerError, type WalletLedgerItem, type WalletLedgerState } from "@/services/saas/wallet-ledger";
import { createWalletLedgerReader } from "./ledger-reader";

const scope: DraftAccountScope = { accountId: "ledger-owner", epoch: 3 };
const row: WalletLedgerItem = { id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", kind: "capture", deltaAvailableUnits: "0", deltaReservedUnits: "-1", availableUnitsAfter: "4", reservedUnitsAfter: "0", referenceType: "generation", referenceId: null, createdAt: "2026-10-28T00:00:00.000Z" };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test("ledger reader clears old values while loading or after failure and supports a manual retry", async () => {
    const states: WalletLedgerState[] = []; let calls = 0;
    const reader = createWalletLedgerReader({ scope, getScope: () => scope, onState: state => states.push(state), client: { async read() { if (++calls === 2) throw new Error("outage"); return [row]; } } });
    await reader.read(); expect(states.at(-1)).toEqual({ phase: "ready", items: [row] });
    await reader.read(); expect(states.at(-2)).toEqual({ phase: "loading", items: [] }); expect(states.at(-1)).toEqual({ phase: "error", items: [], error: "readFailed" });
    await reader.read(); expect(states.at(-1)).toEqual({ phase: "ready", items: [row] }); reader.close();
});

for (const failure of [false, true]) test(`ledger reader ignores superseded ${failure ? "failure" : "success"}`, async () => {
    const old = deferred<WalletLedgerItem[]>(), states: WalletLedgerState[] = []; let calls = 0, firstSignal: AbortSignal | undefined;
    const reader = createWalletLedgerReader({ scope, getScope: () => scope, onState: state => states.push(state), client: { async read(signal) { if (++calls === 1) { firstSignal = signal; return old.promise; } return []; } } });
    const first = reader.read(); await reader.read(); expect(firstSignal?.aborted).toBe(true);
    const count = states.length;
    if (failure) old.reject(new Error("late failure")); else old.resolve([row]);
    await first; expect(states).toHaveLength(count); expect(states.at(-1)).toEqual({ phase: "ready", items: [] }); reader.close();
});

for (const change of ["account", "epoch", "busy", "close"] as const) for (const failure of [false, true]) test(`ledger reader clears scope and rejects late ${failure ? "failure" : "success"}: ${change}`, async () => {
    let current: DraftAccountScope | null = scope;
    const old = deferred<WalletLedgerItem[]>(), states: WalletLedgerState[] = [];
    const reader = createWalletLedgerReader({ scope, getScope: () => current, onState: state => states.push(state), client: { read: () => old.promise } });
    const pending = reader.read();
    if (change === "close") reader.close(); else {
        current = change === "busy" ? null : { ...scope, ...(change === "account" ? { accountId: "other" } : { epoch: 4 }) };
        expect(reader.syncScope()).toBe(false); expect(states.at(-1)).toEqual({ phase: "error", items: [], error: "accountChanged" });
    }
    const count = states.length;
    if (failure) old.reject(new Error("late failure")); else old.resolve([row]);
    await pending; current = scope; await reader.read(); expect(states).toHaveLength(count);
});

test("ledger reader blocks repeated reads after unauthorized or invalidated context", async () => {
    for (const code of ["unauthorized", "context_changed"] as const) {
        const states: WalletLedgerState[] = []; let calls = 0;
        const reader = createWalletLedgerReader({ scope, getScope: () => scope, onState: state => states.push(state), client: { async read() { calls++; throw new WalletLedgerError(code); } } });
        await reader.read(); await reader.read(); expect(calls).toBe(1);
        expect(states.at(-1)).toEqual({ phase: "error", items: [], error: code === "unauthorized" ? "signInRequired" : "accountChanged" });
    }
});
