import { z } from "zod/v4";
import { normalizeCreditAmount } from "../../../../packages/shared/src/credit-amounts";
import type { DraftAccountScope } from "./drafts";

const amount = z.string().refine(value => normalizeCreditAmount(value) === value);
const balance = amount.refine(value => !value.startsWith("-"));
const text = z.string().refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value));
const itemSchema = z.strictObject({
    id: z.uuid(), kind: z.enum(["grant", "recharge", "adjustment", "reserve", "capture", "release", "refund", "consume"]),
    deltaAvailableUnits: amount, deltaReservedUnits: amount, availableUnitsAfter: balance, reservedUnitsAfter: balance,
    referenceType: z.string().nullable(), referenceId: z.string().nullable(), createdAt: z.iso.datetime({ offset: true }),
});
const responseSchema = z.strictObject({ items: z.array(itemSchema).max(50), requestId: text.optional() });
export type WalletLedgerItem = z.infer<typeof itemSchema>;
export type WalletLedgerState = { phase: "loading" | "ready" | "error"; items: WalletLedgerItem[]; error?: "accountChanged" | "signInRequired" | "readFailed" };

export class WalletLedgerError extends Error {
    constructor(readonly code: "context_changed" | "unauthorized" | "aborted" | "read_failed") {
        super("积分流水读取未完成，请手动刷新核对。");
        this.name = "WalletLedgerError";
    }
}

/** Existing owner-only endpoint: its default is the latest 50 entries, without pagination. */
export function createWalletLedgerClient(options: { scope: DraftAccountScope; getScope: () => DraftAccountScope | null; fetcher?: typeof fetch }) {
    const scope = Object.freeze({ ...options.scope });
    let invalidated = false;
    function check(signal?: AbortSignal) {
        const current = options.getScope();
        if (invalidated || current?.accountId !== scope.accountId || current.epoch !== scope.epoch) {
            invalidated = true;
            throw new WalletLedgerError("context_changed");
        }
        if (signal?.aborted) throw new WalletLedgerError("aborted");
    }
    return {
        async read(signal?: AbortSignal): Promise<WalletLedgerItem[]> {
            check(signal);
            try {
                const response = await (options.fetcher ?? fetch)("/api/v1/wallet/ledger", {
                    method: "GET", credentials: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", signal,
                    headers: { accept: "application/json", "x-canvas-account-id": scope.accountId },
                });
                check(signal);
                if (response.status === 401) { invalidated = true; throw new WalletLedgerError("unauthorized"); }
                const data: unknown = await response.json();
                check(signal);
                if (!response.ok) {
                    const error = typeof data === "object" && data !== null && "error" in data ? data.error : null;
                    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
                    if (response.status === 400 && code === "account_context_required" || response.status === 409 && code === "account_changed") {
                        invalidated = true; throw new WalletLedgerError("context_changed");
                    }
                    throw new WalletLedgerError("read_failed");
                }
                const parsed = responseSchema.safeParse(data);
                if (!parsed.success || new Set(parsed.data.items.map(row => row.id.toLowerCase())).size !== parsed.data.items.length) throw new WalletLedgerError("read_failed");
                return parsed.data.items;
            } catch (error) {
                if (error instanceof WalletLedgerError && error.code === "unauthorized") throw error;
                check(signal);
                if (error instanceof WalletLedgerError) throw error;
                throw new WalletLedgerError("read_failed");
            }
        },
    };
}
