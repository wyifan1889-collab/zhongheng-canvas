import { expect, test } from "bun:test";
import { createHistoryImageRecovery, readImageRecoveryIntent, type ImageRecoveryState } from "./history-image-recovery";
import { parseHistoryDetail, parseHistoryReturnQuery } from "@/services/saas/generation-history-detail";
import { GenerationError } from "@/services/saas/generation";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-111111111111", other = "aaaaaaaa-aaaa-4aaa-8aaa-222222222222";
const scope = { accountId: "image-recovery-owner", epoch: 1 };
const blob = new Blob(["synthetic-existing-private-image"], { type: "image/png" });
const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map(byte => byte.toString(16).padStart(2, "0")).join("");
const media = { mediaId: id, kind: "image" as const, contentType: "image/png", sizeBytes: blob.size, etag: hash };
const detail = () => parseHistoryDetail({task:{id,projectId:"__image_workbench__",nodeId:null,modelId:"old-model",priceVersion:1,quotedUnits:1,
    executionStatus:"succeeded",deliveryStatus:"visible",billingStatus:"captured"},result:{taskId:id,status:"succeeded",resultSnapshot:{kind:"image",media}}},id)!;
const resolved = () => ({items:[{id,kind:"image" as const,contentType:"image/png",sizeBytes:blob.size,createdAt:"2026-10-28T00:00:00Z",url:`/api/v1/media/${id}`}],missing:[]});
function deferred<T>() { let resolve!: (value:T)=>void; const promise = new Promise<T>(done=>{resolve=done;}); return {promise,resolve}; }
function harness(patch: Partial<Parameters<typeof createHistoryImageRecovery>[0]> = {}) {
    const states: ImageRecoveryState[] = [], revoked:string[] = [], calls:string[]=[];
    const options: Parameters<typeof createHistoryImageRecovery>[0] = {scope,getScope:()=>scope,taskId:id,onState:s=>states.push(s),
        client:{detail:async()=>{calls.push("task GET");return detail();}},
        mediaClient:()=>({resolve:async()=>{calls.push("resolve");return resolved();},download:async()=>{calls.push("download");return blob;}}),
        decode:async()=>({width:64,height:48}),createUrl:()=>"blob:private-recovery",revokeUrl:u=>revoked.push(u),...patch};
    return {reader:createHistoryImageRecovery(options),states,revoked,calls};
}
test("history route state preserves validated query and rejects forged task/type/filters",()=>{
    const query={pageNumber:3,pageSize:50,type:"image",status:"succeeded"} as const;
    expect(readImageRecoveryIntent({fromGenerationHistory:{taskId:id,type:"image",query}})).toEqual({taskId:id,query});
    expect(readImageRecoveryIntent({fromGenerationHistory:{taskId:"../other",type:"image"}})).toBeNull();
    expect(readImageRecoveryIntent({fromGenerationHistory:{taskId:id,type:"video"}})).toBeNull();
    expect(parseHistoryReturnQuery({...query,pageNumber:Number.MAX_SAFE_INTEGER})).toBeUndefined();
    expect(parseHistoryReturnQuery({...query,type:"invented"})).toBeUndefined();
});
test("existing task reads without a receipt, submit interface or storage and releases its temporary result",async()=>{
    const h=harness();await h.reader.read();expect(h.calls).toEqual(["task GET","resolve","download"]);
    expect(h.states.at(-1)).toMatchObject({phase:"ready",url:"blob:private-recovery",detail:{task:{id,quotedUnits:1,billingStatus:"captured"}}});
    h.reader.dispose();expect(h.revoked).toEqual(["blob:private-recovery"]);
});
test("incomplete task states remain readable without downloading or inventing a result",async()=>{
    for(const status of ["running","unknown","failed"] as const){const d=detail();d.task.executionStatus=status;
        const h=harness({client:{detail:async()=>d}});await h.reader.read();expect(h.states.at(-1)).toMatchObject({phase:"ready",detail:d});expect(h.calls).toEqual([]);h.reader.dispose();}
});
test("identity, metadata, snapshot and downloaded bytes must all match the existing private image",async()=>{
    for(const change of ["task","result","media","kind","etag","resolve","bytes","spec"]){
        const d=detail();if(change==="task")d.task.id=other;if(change==="result")d.result!.taskId=other;if(change==="media")d.result!.resultSnapshot.media!.mediaId=other;
        if(change==="kind")d.result!.resultSnapshot.kind="audio";if(change==="etag")d.result!.resultSnapshot.media!.etag="0".repeat(64);
        if(change==="spec")d.task.imageSpecSnapshot={status:"invalid"};
        const h=harness({client:{detail:async()=>d},mediaClient:()=>({resolve:async()=>change==="resolve"?{...resolved(),missing:[id]}:resolved(),download:async()=>change==="bytes"?new Blob(["x".repeat(blob.size)],{type:"image/png"}):blob})});
        await h.reader.read();expect(h.states.at(-1)?.phase).toBe("error");expect(h.states.at(-1)?.url).toBeUndefined();h.reader.dispose();
        if(change==="spec")expect(h.revoked).toEqual(["blob:private-recovery"]);
    }
});
test("late task, media and decode results cannot survive close, account epoch changes or a newer read",async()=>{
    for(const stage of ["task","resolve","download","decode"] as const) for(const action of ["epoch","dispose"] as const){
        const wait=deferred<any>();let current:typeof scope|null=scope;let started!:()=>void;const ready=new Promise<void>(done=>started=done);
        const delayed=(value:any)=>{started();return wait.promise.then(()=>value);};
        const h=harness({getScope:()=>current,client:{detail:async()=>stage==="task"?delayed(detail()):detail()},mediaClient:()=>({resolve:async()=>stage==="resolve"?delayed(resolved()):resolved(),download:async()=>stage==="download"?delayed(blob):blob}),decode:async()=>stage==="decode"?delayed({width:64,height:48}):{width:64,height:48}});
        const pending=h.reader.read();await ready;
        if(action==="epoch"){current={...scope,epoch:2};h.reader.syncScope();}else h.reader.dispose();
        wait.resolve(null);await pending;
        expect(h.states.at(-1)?.url).toBeUndefined();expect(h.states.some(s=>s.phase==="ready")).toBe(false);h.reader.dispose();
        if(stage==="decode")expect(h.revoked).toEqual(["blob:private-recovery"]);
    }
    const wait=deferred<ReturnType<typeof detail>>();let calls=0;const h=harness({client:{detail:async()=>++calls===1?wait.promise:detail()}});
    const old=h.reader.read();await h.reader.read();wait.resolve(detail());await old;expect(h.states.filter(s=>s.phase==="ready")).toHaveLength(1);h.reader.dispose();
});
test("a late failed read cannot replace a newer successful task read",async()=>{
    let reject!:(error:Error)=>void,calls=0;const oldResult=new Promise<ReturnType<typeof detail>>((_resolve,fail)=>reject=fail);
    const h=harness({client:{detail:async()=>++calls===1?oldResult:detail()}});
    const old=h.reader.read();await h.reader.read();reject(new Error("late failure"));await old;
    expect(h.states.at(-1)).toMatchObject({phase:"ready",url:"blob:private-recovery"});h.reader.dispose();
});
test("foreign-owner 404 and unauthorized reads never download; authentication failure blocks retries",async()=>{
    for(const status of [404,401]){let reads=0;const h=harness({client:{detail:async()=>{reads++;throw new GenerationError(status===401?"unauthorized":"unconfirmed","not readable","not-sent",status);}}});
        await h.reader.read();expect(h.states.at(-1)?.phase).toBe("error");expect(h.calls).toEqual([]);
        expect(h.states.at(-1)?.authenticationRequired).toBe(status===401);
        if(status===401){expect(h.states.at(-1)?.error).toContain("重新确认登录");await h.reader.read();expect(reads).toBe(1);}h.reader.dispose();}
});
