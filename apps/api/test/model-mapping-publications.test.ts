import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { emptyMappingDraft, mappingCombinationKey, mappingSourceKey, canonicalImageSpecTaskParameters, type MappingDraft } from "@infinite-canvas/shared";
import { readModelMappingDraft, saveModelMappingDraft } from "@infinite-canvas/database/model-mapping-drafts";
import { previewMappingPublication, publishMappingConfiguration, readPublishedMappingCatalog } from "@infinite-canvas/database/model-mapping-publications";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { getImageSpecTaskSnapshot } from "@infinite-canvas/database/model-price-publications";
import { modelCatalog, modelMappingPublication, modelPriceDraft, modelPricePublication, modelPricing, modelProvider, providerDiscoveredModel, user, session, walletLedger, generationTask } from "@infinite-canvas/database/schema";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { createGenerationVideoStageRepository } from "../../../packages/database/src/generation-video-stages";
import { executableMappingCatalog } from "../src/model-mapping-catalog";
import { resolveExecutableImageQuote } from "../src/generation-image-policy";
import { resolveExecutableVideoQuote } from "../src/generation-video-policy";
import { createTestDatabase } from "./database";

let database: Awaited<ReturnType<typeof createTestDatabase>>;
const actor = { actorId: "mapping-publish-admin", sessionId: "mapping-publish-session", sessionExpiresAt: new Date(Date.now() + 3_600_000), requestId: "mapping-publish-test" };
const secret = "synthetic-mapping-publish-secret";
const intent = (modelId: string, parameters = { size: "1024x1024", quality: "high" }) => ({ modelId, inputSnapshot: { prompt: "isolated quote, no provider request" }, parameterSnapshot: parameters });
const input = (p: Awaited<ReturnType<typeof previewMappingPublication>>) => ({ expectedDraftVersion: p.draftVersion, expectedPublicationVersion: p.publicationVersion, fingerprint: p.fingerprint });
const business = () => Promise.all([database.db.select().from(walletLedger), database.db.select().from(generationTask)]);
async function save(draft: MappingDraft) {
    const c = await readModelMappingDraft(database.db, actor);
    return saveModelMappingDraft(database.db, { expectedVersion: c.version, draft, providers: [...new Set(draft.bindings.map(b=>b.providerId))].map(providerId => c.providers.find(p=>p.providerId===providerId)!) }, actor);
}
beforeAll(async () => {
    database = await createTestDatabase();
    await database.db.insert(user).values({ id: actor.actorId, email: "publish@example.test", name: "Publish", emailVerified: true, role: "admin" });
    await database.db.insert(session).values({ id: actor.sessionId, userId: actor.actorId, token: crypto.randomUUID(), expiresAt: actor.sessionExpiresAt });
    for (const id of ["A", "B", "V"]) {
        await database.db.insert(modelProvider).values({ id, displayName: id, adapter: "openai-compatible", endpoint: `https://${id.toLowerCase()}.example.test/v1`, secretRef: "synthetic", enabled: true });
        await saveProviderCredential(database.db, secret, id, "synthetic-key");
        await database.db.insert(providerDiscoveredModel).values({ providerId: id, providerModel: id === "V" ? "grok-test" : id === "A" ? "image-2-5" : "image-2.5" });
    }
}, 30_000);
afterAll(async () => { await database?.close(); });

test("atomic publication creates source prices usable by the existing image and video quote resolvers", async () => {
    const draft = emptyMappingDraft();
    draft.models = [{ id: "image-2.5", displayName: "Image 2.5", capability: "image", group: "图片" }, { id: "video-demo", displayName: "Video", capability: "video", group: "视频" }];
    draft.modelSpecifications = { "image-2.5": ["1K", "2K", "4K"], "video-demo": ["480P", "720P"] };
    draft.bindings = [
        { providerId: "A", providerModel: "image-2-5", modelId: "image-2.5", specification: "1K", execution: { protocol: "openai-image-v1", parameters: { size: "1024x1024", quality: "high" } } },
        { providerId: "B", providerModel: "image-2.5", modelId: "image-2.5", specification: "4K", execution: { protocol: "openai-image-v1", parameters: { size: "4096x4096", quality: "high" } } },
        { providerId: "V", providerModel: "grok-test", modelId: "video-demo", specification: "720P", execution: { protocol: "yunfei-grok-video-v1", parameters: { mode: "text", resolution: "720p", durationSeconds: 5, generateAudio: false, aspectRatio: "16:9" } } },
    ];
    draft.bindings.forEach((b,i)=>draft.prices[mappingCombinationKey(b)] = String([4,12,20][i]));
    await save(draft);
    const before = await business(), plan = await previewMappingPublication(database.db, actor); expect(plan.issues).toEqual([]); expect(plan.changes).toHaveLength(3);
    const result = await publishMappingConfiguration(database.db, input(plan), actor); expect(result.version).toBe(1);
    expect(await publishMappingConfiguration(database.db, input(plan), actor)).toEqual(result);
    expect(await database.db.select().from(modelMappingPublication)).toHaveLength(1); expect(await database.db.select().from(modelPricePublication)).toHaveLength(3);
    const catalog = await readPublishedMappingCatalog(database.db), image = catalog.models[0]; expect(image.combinations).toHaveLength(2); expect(image.specifications).toContain("2K");
    expect(JSON.stringify(catalog)).not.toContain("example.test"); expect(JSON.stringify(catalog)).not.toContain("image-2-5");
    const imageRoute = image.combinations[0];
    const quote = await resolveExecutableImageQuote(database.db, intent(imageRoute.nodeModelId!), false, actor.actorId); expect(quote.quotedUnits).toBe(4); expect(quote.pricePublicationId).toBeTruthy();
    const videoRoute = catalog.models[1].combinations[0];
    const video = await resolveExecutableVideoQuote(database.db, { modelId: videoRoute.nodeModelId!, inputSnapshot: { prompt: "video quote" }, parameterSnapshot: videoRoute.execution.parameters }, actor.actorId, { maxMediaDurationMs: 15_000 } as never);
    expect(video.reservedCredits).toBe(20); expect(video.binding.providerModel).toBe("grok-test");
    expect(await business()).toEqual(before);
});

test("reviewed changes reject intervening provider or price edits without partial publication", async () => {
    const before = await database.db.select().from(modelMappingPublication), plan = await previewMappingPublication(database.db, actor);
    await database.db.update(modelProvider).set({ revision: 2 }).where(eq(modelProvider.id,"A"));
    await expect(publishMappingConfiguration(database.db, input(plan), actor)).rejects.toMatchObject({code:"mapping_publication_conflict"});
    expect(await database.db.select().from(modelMappingPublication)).toEqual(before);
});

test("repricing preserves immutable historical image selection and rejects a missing price", async () => {
    const catalog = await readPublishedMappingCatalog(database.db), route = catalog.models[0].combinations[0];
    const old = await resolveExecutableImageQuote(database.db, intent(route.nodeModelId!), false, actor.actorId);
    const current = await readModelMappingDraft(database.db, actor), key = mappingCombinationKey(current.draft.bindings[0]);
    current.draft.prices[key] = ""; await save(current.draft);
    const invalid = await previewMappingPublication(database.db, actor); expect(invalid.issues.length).toBeGreaterThan(0);
    await expect(publishMappingConfiguration(database.db,input(invalid),actor)).rejects.toMatchObject({code:"mapping_publication_invalid"});
    current.draft.prices[key] = "7"; await save(current.draft);
    await publishMappingConfiguration(database.db,input(await previewMappingPublication(database.db,actor)),actor);
    const next = await resolveExecutableImageQuote(database.db,intent(route.nodeModelId!),false,actor.actorId); expect(next.quotedUnits).toBe(7); expect(next.quoteFingerprint).not.toBe(old.quoteFingerprint);
    const historical = await getImageSpecTaskSnapshot(database.db, { modelId: route.nodeModelId!, priceVersion: old.priceVersion, pricePublicationId: old.pricePublicationId,
        billingUnitSnapshot:"request",creditsPerUnitSnapshot:old.creditsPerUnit,quotedUnits:old.quotedUnits,parameterSnapshot:canonicalImageSpecTaskParameters({size:"1024x1024",quality:"high"}) });
    expect(historical).toMatchObject({status:"recorded",creditsPerRequest:4});
});

test("missing preferred source never makes a second channel silently available", async () => {
    const current=await readModelMappingDraft(database.db,actor), first=current.draft.bindings[0];
    current.draft.bindings.push({...first,providerId:"B",providerModel:"image-2.5"}); current.draft.preferred[mappingCombinationKey(first)]=mappingSourceKey(first); await save(current.draft);
    await database.db.update(modelProvider).set({enabled:false,revision:3}).where(eq(modelProvider.id,"A"));
    const plan=await previewMappingPublication(database.db,actor);expect(plan.issues.length).toBeGreaterThan(0);
    const catalog=await readPublishedMappingCatalog(database.db); expect(catalog.models[0].combinations[0].available).toBe(false); expect(catalog.models[0].combinations[0].nodeModelId).toBeUndefined();
    await expect(publishMappingConfiguration(database.db,input(plan),actor)).rejects.toMatchObject({code:"mapping_publication_invalid"});
});

test("revoked admin cannot publish even a reviewed plan",async()=>{
    await database.db.update(modelProvider).set({enabled:true,revision:4}).where(eq(modelProvider.id,"A"));
    const plan=await previewMappingPublication(database.db,actor), before=await database.db.select().from(modelMappingPublication);
    await database.db.update(user).set({role:"user"}).where(eq(user.id,actor.actorId));
    await expect(publishMappingConfiguration(database.db,input(plan),actor)).rejects.toMatchObject({code:"account_changed"});
    expect(await database.db.select().from(modelMappingPublication)).toEqual(before);
    await database.db.update(user).set({role:"admin"}).where(eq(user.id,actor.actorId));
});

test("mutable price state is part of the reviewed fingerprint", async () => {
    const plan = await previewMappingPublication(database.db, actor);
    const [model] = await database.db.select().from(modelCatalog).where(eq(modelCatalog.providerId, "A"));
    await database.db.update(modelPricing).set({ enabled: false }).where(and(eq(modelPricing.modelId, model.id), eq(modelPricing.enabled, true)));
    await expect(publishMappingConfiguration(database.db, input(plan), actor)).rejects.toMatchObject({ code: "mapping_publication_conflict" });
});

test("existing cost binding must match and before-price comes from the published draft", async () => {
    const [model] = await database.db.select().from(modelCatalog).where(eq(modelCatalog.providerId, "A"));
    const rows = await database.db.select().from(modelPriceDraft).where(eq(modelPriceDraft.modelId, model.id));
    const latest = rows.sort((a,b)=>b.version-a.version)[0];
    const cost = { template: "image_request", currency: "CNY", bands: [{ parameters: {}, rates: { request: "0.1" } }] };
    const newer = { ...latest, id: crypto.randomUUID(), version: latest.version + 1, rules: { ...latest.rules, cost, sale: { template: "image_request", currency: "credit", bands: [{parameters:{size:"1024x1024",quality:"high"},rates:{request:"99"}}] } } };
    await database.db.insert(modelPriceDraft).values(newer as never);
    const plan=await previewMappingPublication(database.db,actor), change=plan.changes.find(c=>c.providerId==="A")!;
    expect(change.previous?.rules?.sale.bands[0].rates.request).toBe("7"); expect(change.rules?.cost).toEqual(cost);
    await database.db.update(modelProvider).set({endpoint:"https://changed.example.test/v1",revision:5}).where(eq(modelProvider.id,"A"));
    expect((await previewMappingPublication(database.db,actor)).issues.some(i=>i.message.includes("成本"))).toBe(true);
    await database.db.update(modelProvider).set({endpoint:"https://a.example.test/v1",revision:6}).where(eq(modelProvider.id,"A"));
});

test("retiring a source rejects unfinished tasks atomically and preserves completed task history", async () => {
    const [node] = await database.db.select().from(modelCatalog).where(eq(modelCatalog.providerId,"V"));
    const parameters = { mode: "text", resolution: "720p", durationSeconds: 5, generateAudio: false, aspectRatio: "16:9" };
    const quote = await resolveExecutableVideoQuote(database.db, { modelId: node.publicId, inputSnapshot: { prompt: "synthetic task, no provider" }, parameterSnapshot: parameters }, actor.actorId, { maxMediaDurationMs: 15_000 } as never);
    const { task } = await database.db.transaction(async tx => {
        const result = await createGenerationTaskRepository(tx).create({ ownerId:actor.actorId,modelId:node.publicId,inputSnapshot:{prompt:"synthetic task, no provider"},parameterSnapshot:parameters,
            priceVersion:quote.priceVersion,billingUnitSnapshot:"request",creditsPerUnitSnapshot:quote.reservedCredits,quotedUnits:quote.reservedCredits,videoQuoteSnapshot:quote.videoQuoteSnapshot,idempotencyKey:crypto.randomUUID(),requestId:"retirement-test" });
        await createGenerationVideoStageRepository(tx).initialize(result.task,quote.binding); return result;
    });
    const current=await readModelMappingDraft(database.db,actor);
    current.draft.modelSpecifications["video-demo"]=[]; await save(current.draft);
    const plan=await previewMappingPublication(database.db,actor), before=await database.db.select().from(modelMappingPublication);
    expect(plan.changes.find(c=>c.providerId==="V")?.action).toBe("disable");
    await expect(publishMappingConfiguration(database.db,input(plan),actor)).rejects.toMatchObject({code:"catalog_in_use"});
    expect(await database.db.select().from(modelMappingPublication)).toEqual(before);
    await database.db.update(generationTask).set({executionStatus:"failed",deliveryStatus:"failed",billingStatus:"released",finishedAt:new Date()}).where(eq(generationTask.id,task.id));
    const [finished]=await database.db.select().from(generationTask).where(eq(generationTask.id,task.id));
    await publishMappingConfiguration(database.db,input(await previewMappingPublication(database.db,actor)),actor);
    expect((await database.db.select().from(modelCatalog).where(eq(modelCatalog.id,node.id)))[0].enabled).toBe(false);
    expect((await database.db.select().from(generationTask).where(eq(generationTask.id,task.id)))[0]).toEqual(finished);
});

test("runtime gates and existing limits keep reserved specifications disabled", async () => {
    const catalog=await readPublishedMappingCatalog(database.db);
    const image=catalog.models[0];
    image.combinations.push({...image.combinations[0],specification:"8K",execution:{protocol:"openai-image-v1",parameters:{size:"8192x8192",quality:"high"}}});
    const gated=executableMappingCatalog(catalog,{enabled:true,imageEnabled:true,videoEnabled:false});
    expect(gated.models[0].combinations.at(-1)).toMatchObject({available:false});
    expect(gated.models[0].combinations.at(-1)?.nodeModelId).toBeUndefined();
    const closed=executableMappingCatalog(catalog,{enabled:false,imageEnabled:true,videoEnabled:true,maxVideoDurationMs:15_000});
    expect(closed.models.flatMap(m=>m.combinations).every(c=>!c.available&&!c.nodeModelId)).toBe(true);
    expect(closed.models[0].specifications).toContain("2K");
    const video={version:1,models:[{id:"v",displayName:"V",capability:"video",group:"",specifications:["720P"],combinations:[{specification:"720P",available:true,nodeModelId:"v",priceVersion:1,credits:3,execution:{protocol:"yunfei-grok-video-v1",parameters:{mode:"text",resolution:"720p",durationSeconds:10,generateAudio:false,aspectRatio:"16:9"}}}]}]} as Parameters<typeof executableMappingCatalog>[0];
    expect(executableMappingCatalog(video,{enabled:true,imageEnabled:true,videoEnabled:true,maxVideoDurationMs:5_000}).models[0].combinations[0].available).toBe(false);
});

test("deleted source inventories disappear from the public family catalog without a fallback", async () => {
    const c=await readModelMappingDraft(database.db,actor);c.draft.modelSpecifications["image-2.5"]=["1K","2K"];await save(c.draft);
    await publishMappingConfiguration(database.db,input(await previewMappingPublication(database.db,actor)),actor);
    await database.db.delete(providerDiscoveredModel).where(eq(providerDiscoveredModel.providerId,"A"));
    await database.db.update(modelCatalog).set({deletedAt:new Date(),enabled:false}).where(eq(modelCatalog.providerId,"A"));
    const retained=(await readPublishedMappingCatalog(database.db)).models.find(m=>m.id==="image-2.5");
    expect(retained?.specifications).toEqual(["1K","2K"]);expect(retained?.combinations[0]).toMatchObject({available:false});expect(retained?.combinations[0].nodeModelId).toBeUndefined();
    await database.db.delete(providerDiscoveredModel).where(eq(providerDiscoveredModel.providerId,"B"));
    expect((await readPublishedMappingCatalog(database.db)).models.some(m=>m.id==="image-2.5")).toBe(false);
});
