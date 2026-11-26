import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccountStore } from "@/stores/use-account-store";
import type { WalletLedgerItem, WalletLedgerState } from "@/services/saas/wallet-ledger";
import { WalletLedger, WalletLedgerContent } from "./wallet-ledger";

const row: WalletLedgerItem = { id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001", kind: "reserve",
    deltaAvailableUnits: "-0.12345678901234567890123456789", deltaReservedUnits: "0.12345678901234567890123456789",
    availableUnitsAfter: "9007199254740993.000001", reservedUnitsAfter: "0.12345678901234567890123456789",
    referenceType: "generation", referenceId: null, createdAt: "2026-10-28T01:00:00.000Z" };
const render = (state: WalletLedgerState) => renderToStaticMarkup(<WalletLedgerContent state={state} onRefresh={() => { throw new Error("render must not read"); }} />);

test("ledger displays exact changes and post-entry balances separately; freezing is not labeled consumption", () => {
    const html = render({ phase: "ready", items: [row] });
    for (const content of ["冻结积分", "可用变动", "冻结变动", "变更后可用", "变更后冻结", row.deltaAvailableUnits, `+${row.deltaReservedUnits}`, row.availableUnitsAfter, "最近 50 条", "积分退回不代表现金退款", "未记录"]) expect(html).toContain(content);
    expect(html).not.toContain("e+15");
    expect(html).not.toContain("已扣费");
    expect(html).not.toContain("<a ");
    expect(html.match(/<button\b/g)).toHaveLength(1); // Only the read refresh action.
});

test("ledger loading, empty, failure and expired login have distinct read-only messages", () => {
    const cases: Array<[WalletLedgerState, string]> = [
        [{ phase: "loading", items: [] }, "正在读取积分流水"],
        [{ phase: "ready", items: [] }, "当前账户暂无积分流水"],
        [{ phase: "error", items: [], error: "readFailed" }, "手动刷新重试"],
        [{ phase: "error", items: [], error: "signInRequired" }, "登录已失效"],
        [{ phase: "error", items: [], error: "accountChanged" }, "已停止读取原账户流水"],
    ];
    for (const [state, content] of cases) {
        const html = render(state);
        expect(html).toContain(content); expect(html).not.toContain(row.id);
        if (state.phase === "loading" || "error" in state && state.error !== "readFailed") expect(html).toMatch(/<button\b[^>]*disabled/);
    }
});

test("ledger escapes reference strings and never renders server references as links", () => {
    const html = render({ phase: "ready", items: [{ ...row, referenceId: '<img src="https://private.example" onerror="alert(1)">' }] });
    expect(html).toContain("&lt;img"); expect(html).not.toContain("<img"); expect(html).not.toContain("href=");
});

test("ledger disappears on unavailable, anonymous or busy account renders before effects", () => {
    const original = useAccountStore.getState();
    try {
        for (const patch of [{ status: "unavailable", user: original.user, busy: false }, { status: "ready", user: null, busy: false }, { status: "ready", user: { id: "other" }, busy: true }] as const) {
            useAccountStore.setState(patch as Partial<typeof original>);
            expect(renderToStaticMarkup(<WalletLedger />)).toBe("");
        }
    } finally { useAccountStore.setState(original); }
});
