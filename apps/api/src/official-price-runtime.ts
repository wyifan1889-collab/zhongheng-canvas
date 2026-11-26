import type { Database } from "@infinite-canvas/database";
import { claimOfficialPriceRefresh, completeOfficialPriceRefresh } from "@infinite-canvas/database/official-price-references";
import { OFFICIAL_PRICE_SOURCES, type OfficialPriceEntry, type OfficialPriceSourceId } from "@infinite-canvas/shared";
import { fetchOfficialPriceEntries } from "./official-price-sources";

export const OFFICIAL_PRICE_REFRESH_MS = 6 * 60 * 60 * 1000;
/** Independent reference refresh: no generation, prices, credentials or wallet writes. */
export function startOfficialPriceRuntime(database: Database, options: {
    fetchEntries?: (source: OfficialPriceSourceId, signal: AbortSignal) => Promise<OfficialPriceEntry[]>;
    onFault?: () => void;
} = {}) {
    const controller = new AbortController();
    let running: Promise<void> | null = null;
    function tick(): Promise<void> {
        if (running || controller.signal.aborted) return running ?? Promise.resolve();
        running = (async () => {
            for (const source of Object.keys(OFFICIAL_PRICE_SOURCES) as OfficialPriceSourceId[]) {
                if (controller.signal.aborted) break;
                try {
                    const token = await claimOfficialPriceRefresh(database, source, new Date(), OFFICIAL_PRICE_REFRESH_MS);
                    if (!token) continue;
                    let entries: OfficialPriceEntry[] | null = null;
                    try { entries = await (options.fetchEntries ?? ((id, signal) => fetchOfficialPriceEntries(id, { signal })))(source, controller.signal); }
                    catch { options.onFault?.(); }
                    if (!controller.signal.aborted) await completeOfficialPriceRefresh(database, source, token, entries, new Date());
                } catch { options.onFault?.(); }
            }
        })().finally(() => { running = null; });
        return running;
    }
    const timer = setInterval(() => { void tick(); }, 60_000);
    timer.unref();
    void tick();
    return { tick, async stop() { clearInterval(timer); controller.abort(); await running; } };
}
