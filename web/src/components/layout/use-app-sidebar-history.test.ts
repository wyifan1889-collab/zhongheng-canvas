import { expect, test } from "bun:test";
import { GenerationError } from "@/services/saas/generation";
import type { GenerationHistoryItem, GenerationHistoryQuery, GenerationHistoryResponse, GenerationHistoryScope } from "@/services/saas/generation-history";
import { createSidebarHistoryReader } from "./use-app-sidebar-history";

const scope: GenerationHistoryScope = { accountId: "sidebar-account-a", epoch: 1 };
const row = (index: number): GenerationHistoryItem => ({ taskId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, type: "image", displayModel: `model-${index}`,
    executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured", credits: "0.000001", createdAt: "2026-10-26T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z", result: null });
const page = (items = [row(1)]): GenerationHistoryResponse => ({ items, total: items.length, pageNumber: 1, pageSize: 50 });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function fixture() {
    let current: GenerationHistoryScope | null = { ...scope };
    const publications: ReturnType<ReturnType<typeof createSidebarHistoryReader>["snapshot"]>[] = [];
    const calls: Array<{ query?: GenerationHistoryQuery; signal?: AbortSignal }> = [];
    const hooks = { read: async (_query?: GenerationHistoryQuery, _signal?: AbortSignal): Promise<GenerationHistoryResponse> => page() };
    const reader = createSidebarHistoryReader({ scope, getScope: () => current, onState: (state) => publications.push(state),
        client: { read: (query, signal) => { calls.push({ query, signal }); return hooks.read(query, signal); } } });
    return { reader, calls, publications, hooks, change(next: GenerationHistoryScope | null) { current = next; } };
}

test("sidebar history reads only on demand, keeps the API page size 50 and displays the first eight in server order", async () => {
    const f = fixture(), rows = Array.from({ length: 50 }, (_, index) => row(index + 1));
    f.hooks.read = async () => page(rows);
    expect(f.calls).toHaveLength(0);
    await f.reader.read();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].query).toEqual({ pageNumber: 1, pageSize: 50 });
    expect(f.reader.snapshot().items).toEqual(rows.slice(0, 8));
    expect(f.reader.snapshot().phase).toBe("ready");
    f.reader.close();
});

test("a late same-account response cannot overwrite a later sidebar refresh", async () => {
    const f = fixture(), older = deferred<GenerationHistoryResponse>(), newer = deferred<GenerationHistoryResponse>();
    let count = 0;
    f.hooks.read = () => ++count === 1 ? older.promise : newer.promise;
    const first = f.reader.read(), second = f.reader.read();
    expect(f.calls[0].signal?.aborted).toBe(true);
    newer.resolve(page([row(2)])); await second;
    older.resolve(page([row(1)])); await first;
    expect(f.reader.snapshot().items).toEqual([row(2)]);
    expect(f.calls).toHaveLength(2);
    f.reader.close();
});

test("account replacement, logout and epoch changes synchronously hide sidebar history and reject late reads", async () => {
    for (const next of [null, { accountId: "sidebar-account-b", epoch: 1 }, { ...scope, epoch: 2 }]) {
        const f = fixture();
        await f.reader.read();
        const late = deferred<GenerationHistoryResponse>(); f.hooks.read = () => late.promise;
        const reading = f.reader.read();
        f.change(next); f.reader.syncScope();
        expect(f.calls.at(-1)?.signal?.aborted).toBe(true);
        expect(f.publications.at(-1)?.items).toEqual([]);
        const published = f.publications.length;
        late.resolve(page([row(99)])); await reading;
        expect(f.publications).toHaveLength(published);
        expect(f.reader.snapshot().items).toEqual([]);
        await f.reader.read();
        expect(f.calls).toHaveLength(2);
    }
});

test("ordinary errors retain previous records until a manual read succeeds, without automatic retry", async () => {
    const f = fixture();
    await f.reader.read();
    f.hooks.read = async () => { throw new Error("transport failed"); };
    await f.reader.read();
    expect(f.reader.snapshot()).toMatchObject({ phase: "error", items: [row(1)], blocked: false });
    expect(f.calls).toHaveLength(2);
    f.hooks.read = async () => page([row(3)]);
    await f.reader.read();
    expect(f.reader.snapshot()).toMatchObject({ phase: "ready", items: [row(3)] });
    expect(f.calls).toHaveLength(3);
    f.reader.close();
});

test("an authentication failure clears records and blocks further reads in the invalidated sidebar instance", async () => {
    const f = fixture();
    await f.reader.read();
    f.hooks.read = async () => { throw new GenerationError("unauthorized", "expired", "not-sent", 401); };
    await f.reader.read();
    expect(f.reader.snapshot()).toMatchObject({ phase: "error", items: [], blocked: true });
    await f.reader.read();
    expect(f.calls).toHaveLength(2);
    f.reader.close();
});

test("closing the sidebar reader cancels outstanding work and never publishes a late result", async () => {
    const f = fixture(), pending = deferred<GenerationHistoryResponse>();
    f.hooks.read = () => pending.promise;
    const reading = f.reader.read(), published = f.publications.length;
    f.reader.close();
    expect(f.calls[0].signal?.aborted).toBe(true);
    pending.resolve(page()); await reading;
    expect(f.publications).toHaveLength(published);
    expect(f.reader.snapshot().items).toEqual([]);
});
