import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import dayjs from "dayjs";
import { Button } from "@/components/ui/button";
import { useAccountStore } from "@/stores/use-account-store";
import type { DraftAccountScope } from "@/services/saas/drafts";
import type { WalletLedgerItem, WalletLedgerState } from "@/services/saas/wallet-ledger";
import { createWalletLedgerReader } from "@/pages/account/ledger-reader";

const labels: Record<WalletLedgerItem["kind"], string> = { grant: "赠送积分", recharge: "充值到账", adjustment: "人工调整", reserve: "冻结积分", capture: "结算扣费", release: "释放冻结", refund: "积分退回", consume: "直接消费" };
const signed = (value: string) => value === "0" || value.startsWith("-") ? value : `+${value}`;

export function WalletLedger() {
    const account = useAccountStore(), scope = account.getDraftScope();
    return scope ? <AccountWalletLedger key={`${scope.accountId}:${scope.epoch}`} scope={scope} /> : null;
}

function AccountWalletLedger({ scope }: { scope: DraftAccountScope }) {
    const [state, setState] = useState<WalletLedgerState>({ phase: "loading", items: [] });
    const reader = useRef<ReturnType<typeof createWalletLedgerReader> | null>(null);
    useEffect(() => {
        const instance = createWalletLedgerReader({ scope, getScope: () => useAccountStore.getState().getDraftScope(), onState: setState });
        reader.current = instance;
        const unsubscribe = useAccountStore.subscribe(() => instance.syncScope());
        void instance.read();
        return () => { unsubscribe(); instance.close(); reader.current = null; };
    }, [scope.accountId, scope.epoch]);
    return <WalletLedgerContent state={state} onRefresh={() => { void reader.current?.read(); }} />;
}

export function WalletLedgerContent({ state, onRefresh }: { state: WalletLedgerState; onRefresh: () => void }) {
    const loading = state.phase === "loading", blocked = state.error === "accountChanged" || state.error === "signInRequired";
    return <section aria-labelledby="wallet-ledger-title" className="min-w-0 text-foreground">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <h2 id="wallet-ledger-title" className="m-0 text-sm font-medium">积分流水 <span className="ml-2 text-xs font-normal text-muted-foreground">最近 50 条</span></h2>
            <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading || blocked} aria-busy={loading}><RefreshCw aria-hidden="true" className="size-4" />刷新</Button>
        </header>
        <div className="space-y-4">
            {loading ? <p role="status" className="m-0 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />正在读取积分流水…</p>
                : state.phase === "error" ? <p role="alert" className="m-0 text-sm text-muted-foreground">{state.error === "accountChanged" ? "账号状态已变化，已停止读取原账户流水。" : state.error === "signInRequired" ? "登录已失效，请重新登录后查看积分流水。" : "积分流水暂不可用，请手动刷新重试。"}</p>
                    : !state.items.length ? <p className="m-0 py-5 text-center text-sm text-muted-foreground">当前账户暂无积分流水。</p>
                        : <div className="max-w-full overflow-x-auto"><table className="w-full min-w-[640px] border-collapse text-left text-sm">
                            <thead className="border-y border-border text-xs text-muted-foreground"><tr>{["时间", "类型", "可用变动", "变更后可用", "明细"].map(title => <th key={title} scope="col" className="px-3 py-3 font-medium first:pl-0 last:pr-0">{title}</th>)}</tr></thead>
                            <tbody className="divide-y divide-border">{state.items.map(row => <tr key={row.id} className="align-top">
                                <td className="py-4 pr-3 text-xs text-muted-foreground"><time dateTime={row.createdAt}>{dayjs(row.createdAt).format("YYYY-MM-DD HH:mm:ss")}</time></td>
                                <td className="px-3 py-4 whitespace-nowrap">{labels[row.kind]}</td>
                                <td className="break-all px-3 py-4 tabular-nums">{signed(row.deltaAvailableUnits)}</td>
                                <td className="break-all px-3 py-4 tabular-nums">{row.availableUnitsAfter}</td>
                                <td className="py-4 pl-3"><details><summary className="cursor-pointer text-xs text-muted-foreground">查看</summary>
                                    <div className="mt-3 max-w-64 space-y-2 break-all text-xs text-muted-foreground">
                                        <p className="m-0 tabular-nums">冻结变动：{signed(row.deltaReservedUnits)} 积分<br />变更后冻结：{row.reservedUnitsAfter} 积分</p>
                                        <p className="m-0">关联：{row.referenceType ?? "未记录"} / {row.referenceId ?? "未记录"}<br />流水编号：{row.id}</p>
                                    </div>
                                </details></td>
                            </tr>)}</tbody>
                        </table></div>}
            <details className="text-xs leading-relaxed text-muted-foreground"><summary className="cursor-pointer">积分说明</summary><p className="mb-0">冻结会转移可用积分；结算扣费才消耗冻结积分，释放冻结会归还可用积分。积分退回不代表现金退款。</p></details>
        </div>
    </section>;
}
