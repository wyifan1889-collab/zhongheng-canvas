import { expect, test } from "bun:test";
import { createMappingPublicationClient } from "./model-mapping-publication";
import { parseMappingPublicationPreview, parseMappingPublicationReceipt, parseMappingPublicationWrite } from "../../../../packages/shared/src/model-mapping-publications";
import type { AdminGenerationScope } from "./platform";
const scope: AdminGenerationScope = { accountId: "admin", epoch: 1, role: "admin" };
const fingerprint = "a".repeat(64), write = { expectedDraftVersion: 1, expectedPublicationVersion: 0, fingerprint };
const receipt = { version: 1, draftVersion: 1, fingerprint };
const preview = () => ({ draftVersion: 1, publicationVersion: 0, fingerprint, changes: [], issues: [], current: null });

test("publication uses exact reviewed version, account context and matching receipt", async () => {
    const calls: RequestInit[] = [];
    const client = createMappingPublicationClient({ scope, getScope: () => scope, fetcher: (async (_, init) => {
        calls.push(init!); return Response.json(init?.method === "GET" ? { preview: preview() } : { publication: receipt });
    }) as typeof fetch });
    expect(await client.load()).toEqual(preview()); expect(await client.publish(write)).toEqual(receipt);
    expect(JSON.parse(calls[1].body as string)).toEqual(write); expect(new Headers(calls[1].headers).get("x-canvas-account-id")).toBe("admin");
    expect(calls[1].redirect).toBe("error"); client.close(); expect(await client.load()).toBeNull();
});
test("lost response and conflict require a read, without automatic resubmission", async () => {
    let posts = 0;
    const client = createMappingPublicationClient({ scope, getScope: () => scope, fetcher: (async (_, init) => {
        if (init?.method === "POST") { posts++; throw new Error("lost after commit"); }
        return Response.json({ preview: { ...preview(), publicationVersion: 1, current: receipt } });
    }) as typeof fetch });
    await expect(client.publish(write)).rejects.toThrow("尚未确认"); await expect(client.publish(write)).rejects.toThrow("不能重复");
    expect(posts).toBe(1); expect((await client.load())?.current).toEqual(receipt); expect(posts).toBe(1);
    const conflict = createMappingPublicationClient({scope,getScope:()=>scope,fetcher:(async()=>new Response("",{status:409})) as typeof fetch});
    await expect(conflict.publish(write)).rejects.toThrow("已变化"); await expect(conflict.publish(write)).rejects.toThrow("不能重复");
    const unfinished=createMappingPublicationClient({scope,getScope:()=>scope,fetcher:(async()=>Response.json({error:{code:"catalog_in_use"}},{status:409})) as typeof fetch});
    await expect(unfinished.publish(write)).rejects.toThrow("未结束或待核对任务");
});
test("invalid receipt and account changes cannot report success", async () => {
    const client = createMappingPublicationClient({ scope, getScope: () => scope, fetcher: (async () => Response.json({publication:{...receipt,fingerprint:"b".repeat(64)}})) as typeof fetch });
    await expect(client.publish(write)).rejects.toThrow("回执不完整");
    let current: AdminGenerationScope | null = scope, finish!: (response: Response)=>void;
    const late = createMappingPublicationClient({scope,getScope:()=>current,fetcher:(()=>new Promise(resolve=>{finish=resolve;})) as typeof fetch});
    const pending=late.publish(write); current={...scope,epoch:2}; finish(Response.json({publication:receipt})); expect(await pending).toBeNull();
    expect(parseMappingPublicationPreview({...preview(),current:receipt})).toBeNull();
    expect(parseMappingPublicationPreview({...preview(),changes:[{modelId:"bad"}]})).toBeNull();
    expect(parseMappingPublicationReceipt({...receipt,version:2_147_483_647})?.version).toBe(2_147_483_647);
    expect(parseMappingPublicationWrite({...write,expectedPublicationVersion:2_147_483_647})).toBeNull();
});
