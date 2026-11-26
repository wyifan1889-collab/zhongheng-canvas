import { afterAll, beforeAll, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { eq } from "drizzle-orm";
import { createDatabase } from "@infinite-canvas/database";
import { createRateStore } from "@infinite-canvas/database/rate-limit";
import { saveProviderCredential } from "@infinite-canvas/database/provider-credentials";
import { readModelMappingDraft, saveModelMappingDraft } from "@infinite-canvas/database/model-mapping-drafts";
import { previewMappingPublication, publishMappingConfiguration } from "@infinite-canvas/database/model-mapping-publications";
import { createGenerationTaskRepository } from "@infinite-canvas/database/generation-tasks";
import { modelCatalog, modelMappingPublication, modelPricing, modelProvider, providerDiscoveredModel, session, user, walletLedger, generationTask } from "@infinite-canvas/database/schema";
import { emptyMappingDraft, mappingCombinationKey, canonicalImageSpecTaskParameters } from "@infinite-canvas/shared";
import { createAccountApi } from "../src/accounts";
import { createApp } from "../src/app";
import { createTestDatabase, postgresTestUrl } from "./database";
import { resolveExecutableImageQuote } from "../src/generation-image-policy";
const { Client } = createRequire(new URL("../../../packages/test-postgres/package.json", import.meta.url))("pg");

const pgUrl = postgresTestUrl();
if (pgUrl && process.env.SAAS_POSTGRES_TEST_SUITE !== "mapping-publication") throw new Error("Use isolated --mapping-publication runner");
const origin = "http://localhost:4019", secret = crypto.randomUUID() + crypto.randomUUID(), path = "/api/v1/admin/model-mapping-publication";
let database: Awaited<ReturnType<typeof createTestDatabase>>, app: ReturnType<typeof createApp>;
let admin = {id:"",cookie:""}, regular = {id:"",cookie:""};
let actor: {actorId:string;sessionId:string;sessionExpiresAt:Date;requestId:string};
const mails: {url:string}[]=[];
const generation = { enabled:true, imageEnabled:true, videoEnabled:false, queue:{send:async()=>{throw new Error("No queue in publication tests");}} };
function request(target=path, who=admin, method="GET",body?:unknown,extra:Record<string,string>={}) {
    return app(new Request(origin+target,{method,headers:{origin,cookie:who.cookie,"x-canvas-account-id":who.id,...(body?{"content-type":"application/json"}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})}),"198.51.100.39");
}
const makeApp = (db=database.db) => createApp(createAccountApi({database:db,origin,auth:{secret,sendVerificationEmail:async mail=>{mails.push(mail);},sendResetPassword:async()=>{}},
    rates:createRateStore(database.pool,secret),generation:generation as never,verifyHuman:async()=>true,onFault:()=>{}}),"test-only-key");
async function signup(email:string) {
    const password="synthetic-publish-password";
    expect((await request("/api/auth/sign-up/email",{id:"",cookie:""},"POST",{email,password,name:"Test"})).status).toBe(200);
    await app(new Request(mails.at(-1)!.url),"198.51.100.39");
    const result=await request("/api/auth/sign-in/email",{id:"",cookie:""},"POST",{email,password});
    const [owner]=await database.db.select().from(user).where(eq(user.email,email));
    return {id:owner.id,cookie:result.headers.getSetCookie().map(v=>v.split(";")[0]).join("; ")};
}
const write=(p:Awaited<ReturnType<typeof previewMappingPublication>>)=>({expectedDraftVersion:p.draftVersion,expectedPublicationVersion:p.publicationVersion,fingerprint:p.fingerprint});
async function saveEmpty() { const c=await readModelMappingDraft(database.db,actor); await saveModelMappingDraft(database.db,{expectedVersion:c.version,draft:emptyMappingDraft(),providers:[]},actor); }
beforeAll(async()=>{
    database=await createTestDatabase(); app=makeApp(); admin=await signup("publication-admin@example.test"); regular=await signup("publication-user@example.test");
    await database.db.update(user).set({role:"admin"}).where(eq(user.id,admin.id));
    const [s]=await database.db.select().from(session).where(eq(session.userId,admin.id)); actor={actorId:admin.id,sessionId:s.id,sessionExpiresAt:s.expiresAt,requestId:"publication-test"};
    await database.db.insert(modelProvider).values({id:"publish-api",displayName:"Sample",adapter:"openai-compatible",endpoint:"https://publish.example.test/v1",secretRef:"synthetic",enabled:true});
    await saveProviderCredential(database.db,secret,"publish-api","synthetic-key");
    await database.db.insert(providerDiscoveredModel).values({providerId:"publish-api",providerModel:"image-2-5"});
    const d=emptyMappingDraft(); d.models=[{id:"image-2.5",displayName:"Image 2.5",capability:"image",group:"图片"}];d.specificationOptions.image.push("8K");d.modelSpecifications["image-2.5"]=["1K","2K","8K"];
    d.bindings=[{providerId:"publish-api",providerModel:"image-2-5",modelId:"image-2.5",specification:"1K",execution:{protocol:"openai-image-v1",parameters:{size:"1024x1024",quality:"high"}}},
        {providerId:"publish-api",providerModel:"image-2-5",modelId:"image-2.5",specification:"8K",execution:{protocol:"openai-image-v1",parameters:{size:"8192x8192",quality:"high"}}}];
    d.bindings.forEach(b=>d.prices[mappingCombinationKey(b)]="6");
    await saveModelMappingDraft(database.db,{expectedVersion:0,draft:d,providers:[{providerId:"publish-api",revision:1}]},actor);
},30_000);
afterAll(async()=>{await database?.close();});

test("publication API enforces authentication, admin, origin, account context and exact body",async()=>{
    expect((await request(path,{id:"",cookie:""})).status).toBe(401);expect((await request(path,regular)).status).toBe(403);
    expect((await request(path,admin,"GET",undefined,{"x-canvas-account-id":""})).status).toBe(400);
    expect((await request(path,admin,"GET",undefined,{"x-canvas-account-id":regular.id})).status).toBe(409);
    const plan=await previewMappingPublication(database.db,actor);
    expect((await request(path,admin,"POST",write(plan),{origin:"https://other.test"})).status).toBe(403);
    expect((await request(path,admin,"POST",{...write(plan),extra:1})).status).toBe(400);
    expect((await request(path+"?extra=1")).status).toBe(400);
    expect((await request(path,admin,"PUT",write(plan))).status).toBe(405);
    expect((await database.db.select().from(modelMappingPublication)).length).toBe(0);
});
test("HTTP publication and free quote preserve wallet/tasks and return runtime-safe family options",async()=>{
    const before=await Promise.all([database.db.select().from(walletLedger),database.db.select().from(generationTask)]);
    const plan=(await (await request()).json()).preview;
    const response=await request(path,admin,"POST",write(plan));expect(response.status).toBe(200);const published=(await response.json()).publication;
    expect((await (await request(path,admin,"POST",write(plan))).json()).publication).toEqual(published);
    const catalogResponse=await request("/api/v1/model-mapping-catalog",regular);expect(catalogResponse.status).toBe(200);
    const catalog=(await catalogResponse.json()).catalog, model=catalog.models[0]; expect(model.specifications).toEqual(["1K","2K","8K"]);
    expect(model.combinations.find((c:any)=>c.specification==="8K")).toMatchObject({available:false});
    const route=model.combinations.find((c:any)=>c.specification==="1K");expect(route.available).toBe(true);
    const quote=await request("/api/v1/generation/quote",regular,"POST",{modelId:route.nodeModelId,input:{prompt:"free quote"},parameters:route.execution.parameters});
    expect(quote.status).toBe(200);expect((await quote.json()).quote.quotedUnits).toBe(6);
    generation.enabled=false;
    const closed=(await (await request("/api/v1/model-mapping-catalog",regular)).json()).catalog;
    expect(closed.models[0].combinations.every((c:any)=>!c.available&&!c.nodeModelId)).toBe(true); generation.enabled=true;
    expect(await Promise.all([database.db.select().from(walletLedger),database.db.select().from(generationTask)])).toEqual(before);
    expect(JSON.stringify(catalog)).not.toContain("publish.example.test");expect(JSON.stringify(catalog)).not.toContain("image-2-5");
});

test("mapping publication history cannot be updated or removed",async()=>{
    const [record]=await database.db.select().from(modelMappingPublication);
    await expect(database.db.update(modelMappingPublication).set({draftVersion:0}).where(eq(modelMappingPublication.id,record.id)).execute()).rejects.toThrow();
    await expect(database.db.delete(modelMappingPublication).where(eq(modelMappingPublication.id,record.id)).execute()).rejects.toThrow();
    expect((await database.db.select().from(modelMappingPublication).where(eq(modelMappingPublication.id,record.id)))[0]).toEqual(record);
});

// Real PostgreSQL lock ordering; these cases are intentionally skipped by the PGlite run.
test.skipIf(!pgUrl)("concurrent identical publications serialize to one immutable receipt",async()=>{
    const plan=await previewMappingPublication(database.db,actor);
    const results=await Promise.all([publishMappingConfiguration(database.db,write(plan),actor),publishMappingConfiguration(database.db,write(plan),actor)]);
    expect(results[0]).toEqual(results[1]);expect((await database.db.select().from(modelMappingPublication)).length).toBe(2);
});
test.skipIf(!pgUrl)("publication waiting behind task admission sees unfinished task and rolls back retirement",async()=>{
    const connection=new URL(pgUrl!); connection.searchParams.set("application_name","mapping-publish-wait"); const waiting=createDatabase(connection.toString());
    const [node]=await database.db.select().from(modelCatalog); await saveEmpty(); const plan=await previewMappingPublication(database.db,actor);
    const ready=Promise.withResolvers<void>(), release=Promise.withResolvers<void>();
    const task=database.db.transaction(async tx=>{
        const intent={modelId:node.publicId,inputSnapshot:{prompt:"synthetic"},parameterSnapshot:{size:"1024x1024",quality:"high"}};
        const quote=await resolveExecutableImageQuote(tx,intent,true,admin.id);
        const result=await createGenerationTaskRepository(tx).create({...intent,parameterSnapshot:canonicalImageSpecTaskParameters(intent.parameterSnapshot),ownerId:admin.id,priceVersion:quote.priceVersion,quotedUnits:quote.quotedUnits,billingUnitSnapshot:quote.billingUnit,creditsPerUnitSnapshot:quote.creditsPerUnit,idempotencyKey:crypto.randomUUID(),requestId:"lock-test"});ready.resolve();await release.promise;return result;
    });
    let pending:Promise<unknown>|undefined;
    try {
        await Promise.race([ready.promise,task.then(()=>{throw new Error("Task admission did not hold its transaction");})]);
        pending=publishMappingConfiguration(waiting.db,write(plan),actor).catch(e=>e.code);
        await waitForLock();
        release.resolve();await task;expect(await pending).toBe("catalog_in_use");
        expect((await database.db.select().from(modelCatalog).where(eq(modelCatalog.id,node.id)))[0].enabled).toBe(true);
        await database.db.update(generationTask).set({executionStatus:"failed",billingStatus:"released",deliveryStatus:"failed",finishedAt:new Date()});
    } finally {release.resolve();await task;await pending;await waiting.close();}
});
test.skipIf(!pgUrl)("HTTP request rechecks revoked admin after lock wait and reports definite 409",async()=>{
    const connection=new URL(pgUrl!); connection.searchParams.set("application_name","mapping-publish-wait"); const waiting=createDatabase(connection.toString());
    const blocker=new Client({connectionString:pgUrl!});await blocker.connect();const original=app;app=makeApp(waiting.db);
    const plan=await previewMappingPublication(database.db,actor);let pending:Promise<Response>|undefined;
    try {
        await blocker.query("BEGIN");await blocker.query("SELECT id FROM canvas_saas.model_mapping_draft WHERE id='catalog' FOR UPDATE");
        pending=request(path,admin,"POST",write(plan));await waitForLock();
        await database.db.update(user).set({role:"user"}).where(eq(user.id,admin.id));await blocker.query("COMMIT");
        const response=await pending;expect(response.status).toBe(409);expect((await response.json()).error.code).toBe("account_changed");
    } finally {await blocker.query("ROLLBACK");await pending;app=original;await database.db.update(user).set({role:"admin"}).where(eq(user.id,admin.id));await blocker.end();await waiting.close();}
});
async function waitForLock() {
    const observer=new Client({connectionString:pgUrl!});await observer.connect();
    try {const deadline=Date.now()+5_000;while(Date.now()<deadline){
        const {rows}=await observer.query("SELECT pid FROM pg_stat_activity WHERE application_name='mapping-publish-wait' AND wait_event_type='Lock'");
        if(rows.length) return;await Bun.sleep(10);
    }throw new Error("Expected PostgreSQL lock wait not observed");}finally{await observer.end();}
}
