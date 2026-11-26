import { expect, test } from "bun:test";
import { createModelMappingDraftClient } from "./model-mapping-draft";
import { emptyMappingDraft } from "../../../../packages/shared/src/model-mapping-drafts";
import type { AdminGenerationScope } from "./platform";
const scope: AdminGenerationScope = { accountId: "admin", epoch: 1, role: "admin" };
const catalog = () => ({ version: 0, draft: emptyMappingDraft(), providers: [], sources: [] });
const input = () => ({ expectedVersion: 0, draft: emptyMappingDraft(), providers: [] });
test("client preserves scope, exact write version, and response draft without retry", async () => {
    const calls: RequestInit[] = [];
    const client = createModelMappingDraftClient({ scope, getScope: () => scope, fetcher: (async (_, init) => { calls.push(init!); return Response.json(init?.method === "PUT" ? { saved: { version: 1, draft: emptyMappingDraft() } } : { catalog: catalog() }); }) as typeof fetch });
    expect(await client.load()).toEqual(catalog()); expect((await client.save(input()))?.version).toBe(1);
    expect(calls.map(item => item.method)).toEqual(["GET", "PUT"]); expect(new Headers(calls[1].headers).get("x-canvas-account-id")).toBe("admin");
    expect(calls[1].redirect).toBe("error"); client.close(); expect(await client.load()).toBeNull();
});
test("unknown write blocks resubmission until successful explicit read", async () => {
    let writes = 0;
    const client = createModelMappingDraftClient({ scope, getScope: () => scope, fetcher: (async (_, init) => { if (init?.method === "PUT") { writes++; throw new Error("lost response"); } return Response.json({ catalog: catalog() }); }) as typeof fetch });
    await expect(client.save(input())).rejects.toThrow("保存结果尚未确认");
    await expect(client.save(input())).rejects.toThrow("不能重复提交"); expect(writes).toBe(1);
    await client.load(); await expect(client.save(input())).rejects.toThrow(); expect(writes).toBe(2);
});
test("mismatched receipt is not accepted and stale account cannot consume late result", async () => {
    const client = createModelMappingDraftClient({ scope, getScope: () => scope, fetcher: (async () => Response.json({ saved: { version: 3, draft: emptyMappingDraft() } })) as typeof fetch });
    await expect(client.save(input())).rejects.toThrow("回执不完整");
    let current: AdminGenerationScope | null = scope, resolve!: (response: Response) => void;
    const pending = createModelMappingDraftClient({ scope, getScope: () => current, fetcher: (() => new Promise(done => { resolve = done; })) as typeof fetch });
    const reading = pending.load(); current = { ...scope, epoch: 2 }; resolve(Response.json({ catalog: catalog() }));
    expect(await reading).toBeNull(); expect(await pending.load()).toBeNull();
});
