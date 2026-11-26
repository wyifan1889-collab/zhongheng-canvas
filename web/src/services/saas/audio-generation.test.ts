import { expect, test } from "bun:test";
import { createAudioGenerationClient, type AudioGenerationIntent, type AudioGenerationModel, type AudioGenerationQuote, type AudioGenerationScope } from "./audio-generation";
import { GenerationError } from "./generation";

const taskId = "11111111-1111-4111-8111-111111111111", mediaId = taskId, otherId = "22222222-2222-4222-8222-222222222222";
const scope: AudioGenerationScope = { accountId: "synthetic-audio-account", epoch: 2 };
const intent: AudioGenerationIntent = { modelId: "synthetic-speech", input: { text: "完整保留的合成朗读文本。" }, parameters: { voice: "alloy", format: "mp3", style: "自然", language: "普通话" } };
const model: AudioGenerationModel = { id: intent.modelId, displayName: "合成语音模型", capability: "audio", group: { id: taskId, name: "合成音频", order: 1 },
    audio: { formats: ["mp3", "wav"], voices: ["alloy", "nova"], instructions: true }, audioPricing: { priceVersion: 3, billingUnit: "request", creditsPerUnit: 7, priceNote: "成功后按次收取7积分" } };
const quote: AudioGenerationQuote = { modelId: model.id, ...model.audioPricing, quotedUnits: 7, quoteFingerprint: "a".repeat(64) };
const view = () => ({ task: { id: taskId, projectId: null, nodeId: null, modelId: model.id, priceVersion: 3, quotedUnits: 7, billingUnitSnapshot: "request", creditsPerUnitSnapshot: 7,
    audioSnapshot: { status: "recorded", input: structuredClone(intent.input), parameters: structuredClone(intent.parameters) }, executionStatus: "succeeded", deliveryStatus: "saved", billingStatus: "captured",
    billing: { reservedCredits: "7", capturedCredits: "7", releasedCredits: "0" }, ownerId: "private-owner" },
    result: { taskId, status: "succeeded", resultSnapshot: { kind: "audio", media: { mediaId, kind: "audio", contentType: "audio/mpeg", sizeBytes: 256, etag: "synthetic-etag", url: "https://private.invalid" },
        usageEvidence: { status: "missing", source: "audio_speech_binary" }, technicalAudio: { source: "decoded_samples", samplesPerChannel: 24000, sampleRate: 24000, channels: 1, durationSeconds: 1 }, providerKey: "private-key" } } });
const fetcher = (run: (path: string, init?: RequestInit) => Promise<Response>): typeof fetch => Object.assign((input: RequestInfo | URL, init?: RequestInit) => run(String(input), init), { preconnect: fetch.preconnect });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(run?: (path: string, init?: RequestInit) => Promise<Response>, getScope: () => AudioGenerationScope | null = () => scope) {
    const calls: { path: string; init?: RequestInit }[] = [];
    const client = createAudioGenerationClient({ scope, getScope, fetcher: fetcher(async (path, init) => {
        calls.push({ path, init });
        return run ? run(path, init) : Response.json(path.endsWith("/models") ? { items: [{ ...model, providerKey: "private-key" }] } : path.endsWith("/quote") ? { quote: { ...quote, endpoint: "private-endpoint" } } : view());
    }) });
    return { client, calls };
}
async function prepared(f = fixture()) { await f.client.models(); return { ...f, confirmed: await f.client.quote(intent) }; }

test("a catalog-declared default voice and WAV-only model can quote, submit and recover its chat audio result", async () => {
    const nextIntent: AudioGenerationIntent = { modelId: model.id, input: { text: "  中文原文，不由客户端追加提示词。  " }, parameters: { voice: "default", format: "wav" } };
    const nextModel: AudioGenerationModel = { ...model, audio: { formats: ["wav"], voices: ["default"], instructions: false } };
    const original = view();
    const nextView = { ...original, task: { ...original.task, audioSnapshot: { status: "recorded", input: nextIntent.input, parameters: nextIntent.parameters } },
        result: { ...original.result, resultSnapshot: { ...original.result.resultSnapshot,
            media: { ...original.result.resultSnapshot.media, contentType: "audio/wav" }, usageEvidence: { status: "missing", source: "audio_chat_data_uri" } } } };
    const { client, calls } = fixture(async path => Response.json(path.endsWith("/models") ? { items: [nextModel] } : path.endsWith("/quote") ? { quote } : nextView));
    expect((await client.models())[0].audio).toEqual(nextModel.audio);
    const confirmed = await client.quote(nextIntent), accepted = await client.submit(nextIntent, confirmed, "chat-audio-receipt");
    expect(accepted.task.audioSnapshot).toEqual({ status: "recorded", input: nextIntent.input, parameters: nextIntent.parameters });
    expect(accepted.result?.resultSnapshot.usageEvidence).toEqual({ status: "missing", source: "audio_chat_data_uri" });
    expect(accepted.result?.resultSnapshot.media?.contentType).toBe("audio/wav");
    expect(JSON.parse(calls[2].init!.body as string)).toMatchObject(nextIntent);
    await client.get(taskId); await client.recover("chat-audio-receipt");
    for (const parameters of [{ voice: "default", format: "mp3" }, { voice: "alloy", format: "wav" }, { voice: "default", format: "wav", language: "English" }]) {
        await expect(client.quote({ ...nextIntent, parameters } as AudioGenerationIntent)).rejects.toMatchObject({ code: "invalid_input", outcome: "not-sent" });
    }
    expect(calls.filter(call => call.path.endsWith("/quote"))).toHaveLength(1);
    expect(calls.filter(call => call.path.endsWith("/audio/tasks"))).toHaveLength(1);
});

test("audio usage remains missing for both implemented response sources and rejects invented measurements", async () => {
    for (const source of ["audio_speech_binary", "audio_chat_data_uri"] as const) {
        const data = view(); data.result.resultSnapshot.usageEvidence = { status: "missing", source };
        expect((await fixture(async () => Response.json(data)).client.get(taskId)).result?.resultSnapshot.usageEvidence).toEqual({ status: "missing", source });
    }
    for (const evidence of [{ status: "complete", source: "audio_chat_data_uri" }, { status: "missing", source: "invented" }, { status: "missing", source: "audio_chat_data_uri", units: 1 }]) {
        const data = view(); Object.assign(data.result.resultSnapshot, { usageEvidence: evidence });
        await expect(fixture(async () => Response.json(data)).client.get(taskId)).rejects.toMatchObject({ code: "unconfirmed" });
    }
});

test("audio client uses platform Speech routes, account headers, explicit confirmation and safe public projections", async () => {
    const { client, calls } = fixture();
    expect(await client.models()).toEqual([model]);
    const confirmed = await client.quote(intent); expect(confirmed).toEqual(quote);
    const signal = new AbortController().signal, submitted = await client.submit(intent, confirmed, "audio-receipt", signal);
    expect(submitted.task.audioSnapshot).toEqual({ status: "recorded", input: intent.input, parameters: intent.parameters });
    expect(submitted.result?.resultSnapshot.media).toEqual({ mediaId, kind: "audio", contentType: "audio/mpeg", sizeBytes: 256, etag: "synthetic-etag" });
    expect(JSON.stringify(submitted)).not.toContain("private");
    await client.get(taskId); await client.recover("audio-receipt");
    expect(calls.map(call => call.path)).toEqual(["/api/v1/generation/audio/models", "/api/v1/generation/audio/quote", "/api/v1/generation/audio/tasks", `/api/v1/generation/tasks/${taskId}`, "/api/v1/generation/tasks/by-key/audio-receipt"]);
    expect(calls.map(call => call.init?.method)).toEqual(["GET", "POST", "POST", "GET", "GET"]);
    for (const { init } of calls) {
        expect(init).toMatchObject({ credentials: "same-origin", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer" });
        expect(new Headers(init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
    }
    expect(calls[2].init?.signal).toBe(signal);
    expect(new Headers(calls[2].init?.headers).get("Idempotency-Key")).toBe("audio-receipt");
    expect(JSON.parse(calls[2].init!.body as string)).toEqual({ ...intent, confirmedPriceVersion: quote.priceVersion, confirmedQuoteFingerprint: quote.quoteFingerprint });
});

test("every confirmed intent field and the issued quote identity must still match before POST", async () => {
    const changes: AudioGenerationIntent[] = [
        { ...intent, input: { text: `${intent.input.text}修改` } }, { ...intent, modelId: "another-model" },
        ...[{ voice: "nova" }, { format: "wav" as const }, { style: "修改" }, { language: "修改" }].map(change => ({ ...intent, parameters: { ...intent.parameters, ...change } })),
    ];
    const { client, calls, confirmed } = await prepared();
    for (const changed of changes) await expect(client.submit(changed, confirmed, "changed-audio")).rejects.toMatchObject({ code: "confirmation_changed", outcome: "not-sent" });
    for (const forged of [{ ...confirmed }, { ...confirmed, quoteFingerprint: "b".repeat(64) }, { ...confirmed, priceVersion: 4 }, { ...confirmed, quotedUnits: 8 }])
        await expect(client.submit(intent, forged, "changed-audio")).rejects.toMatchObject({ code: "confirmation_changed", outcome: "not-sent" });
    expect(calls).toHaveLength(2);
    await client.submit(intent, confirmed, "original-audio");
    expect(calls.filter(call => call.path.endsWith("/audio/tasks"))).toHaveLength(1);
});

test("unsupported music and unadvertised voices never request a quote; returned catalog mutations cannot change internal capabilities", async () => {
    const { client, calls } = fixture();
    const models = await client.models(); models[0].audio.voices.push("invented"); models[0].audioPricing.creditsPerUnit = 999;
    for (const parameters of [{ ...intent.parameters, seconds: 5 }, { ...intent.parameters, loop: false }, { ...intent.parameters, instrumental: false }, { ...intent.parameters, voice: "invented" }, { ...intent.parameters, format: "aac" }])
        await expect(client.quote({ ...intent, parameters } as AudioGenerationIntent)).rejects.toMatchObject({ code: "invalid_input", outcome: "not-sent" });
    expect(calls).toHaveLength(1);
    expect(await client.quote(intent)).toEqual(quote);
    const legacy = fixture(async path => Response.json(path.endsWith("/models") ? { items: [{ ...model, audio: { ...model.audio, instructions: false } }] } : { quote }));
    await legacy.client.models();
    await expect(legacy.client.quote(intent)).rejects.toMatchObject({ code: "invalid_input" });
    expect(legacy.calls).toHaveLength(1);
});

test("catalog, quote price and fingerprint corruption never become a confirmation", async () => {
    for (const corrupted of [
        { ...quote, quoteFingerprint: "bad" }, { ...quote, priceVersion: 4 }, { ...quote, creditsPerUnit: 8, quotedUnits: 8 },
        { ...quote, quotedUnits: 14 }, { ...quote, modelId: "different-model" }, { ...quote, priceNote: null },
    ]) {
        const { client } = fixture(async path => Response.json(path.endsWith("/models") ? { items: [model] } : { quote: corrupted }));
        await client.models(); await expect(client.quote(intent)).rejects.toBeInstanceOf(GenerationError);
    }
    for (const items of [[model, model], [{ ...model, capability: "image" }], [{ ...model, audio: { ...model.audio, formats: ["aac"] } }], [{ ...model, audioPricing: { ...model.audioPricing, creditsPerUnit: 0 } }]])
        await expect(fixture(async () => Response.json({ items })).client.models()).rejects.toMatchObject({ code: "unconfirmed", outcome: "not-sent" });
});

test("a directory refresh invalidates an earlier or in-flight displayed quote", async () => {
    const { client, calls, confirmed } = await prepared();
    await client.models(); await expect(client.submit(intent, confirmed, "stale-price")).rejects.toMatchObject({ code: "confirmation_changed" });
    expect(calls.filter(call => call.path.endsWith("/audio/tasks"))).toHaveLength(0);
    const delayed = deferred<Response>();
    const next = fixture(async path => path.endsWith("/quote") ? delayed.promise : Response.json({ items: [model] }));
    await next.client.models(); const pending = next.client.quote(intent); await next.client.models(); delayed.resolve(Response.json({ quote }));
    await expect(pending).rejects.toMatchObject({ code: "catalog_changed" });
});

for (const change of ["account", "epoch"] as const) test(`late ${change} changes during fetch and JSON cannot populate a previous account`, async () => {
    for (const stage of ["fetch", "json"] as const) {
        let current: AudioGenerationScope = { ...scope };
        const reply = deferred<Response>(), body = deferred<unknown>(), started = deferred<void>();
        const f = fixture(async path => {
            if (path.endsWith("/models")) return Response.json({ items: [model] });
            if (path.endsWith("/quote")) return Response.json({ quote });
            if (stage === "fetch") { started.resolve(); return reply.promise; }
            const response = Response.json({}); response.json = () => { started.resolve(); return body.promise; }; return response;
        }, () => current);
        const { client, confirmed, calls } = await prepared(f);
        const outcome = client.submit(intent, confirmed, `late-${stage}`).catch((error: unknown) => error);
        await started.promise; current = { ...scope, ...(change === "account" ? { accountId: "other-account" } : { epoch: scope.epoch + 1 }) };
        if (stage === "fetch") reply.resolve(Response.json(view())); else body.resolve(view());
        expect(await outcome).toMatchObject({ code: "context_changed", outcome: "unknown" });
        current = scope; await expect(client.get(taskId)).rejects.toMatchObject({ code: "context_changed", outcome: "not-sent" });
        expect(calls).toHaveLength(3);
    }
});

test("forged media, mismatched task IDs, format and audio measurements never become playable output", async () => {
    const corruptions: ((data: ReturnType<typeof view>) => void)[] = [
        data => { data.result.taskId = otherId; }, data => { data.task.id = otherId; },
        data => { data.result.resultSnapshot.kind = "image"; }, data => { data.result.resultSnapshot.media.kind = "image"; },
        data => { data.result.resultSnapshot.media.contentType = "audio/wav"; }, data => { data.result.resultSnapshot.media.mediaId = "bad"; },
        data => { data.result.resultSnapshot.media.mediaId = otherId; },
        data => { data.result.resultSnapshot.media.sizeBytes = -1; }, data => { data.result.resultSnapshot.media.etag = "\r\ninvalid"; },
        data => { data.result.resultSnapshot.technicalAudio.durationSeconds = 2; }, data => { data.task.quotedUnits = 9; },
        data => { data.task.billing.capturedCredits = "8"; }, data => { data.task.billing.reservedCredits = "8"; },
        data => { (data.task as unknown as Record<string, unknown>).audioSnapshot = { status: "invalid" }; },
    ];
    for (const corrupt of corruptions) {
        const data = view(); corrupt(data);
        const { client } = fixture(async () => Response.json(data));
        await expect(client.get(taskId)).rejects.toMatchObject({ code: "unconfirmed", outcome: "not-sent" });
    }
});

test("the accepted task must retain every original Speech field and quoted price", async () => {
    for (const corrupt of [(data: ReturnType<typeof view>) => { data.task.audioSnapshot.input.text = "another text"; },
        (data: ReturnType<typeof view>) => { data.task.audioSnapshot.parameters.voice = "nova"; },
        (data: ReturnType<typeof view>) => { data.task.priceVersion = 4; }]) {
        const data = view(); corrupt(data);
        const { client, confirmed, calls } = await prepared(fixture(async path => Response.json(path.endsWith("/models") ? { items: [model] } : path.endsWith("/quote") ? { quote } : data)));
        await expect(client.submit(intent, confirmed, "mismatch")).rejects.toMatchObject({ code: "unconfirmed", outcome: "unknown" });
        expect(calls.filter(call => call.path.endsWith("/audio/tasks"))).toHaveLength(1);
    }
});

test("lost submits stay uncertain, cannot POST again under the same or a new key, and recover only by owner GET", async () => {
    const { client, confirmed, calls } = await prepared(fixture(async path => {
        if (path.endsWith("/models")) return Response.json({ items: [model] });
        if (path.endsWith("/quote")) return Response.json({ quote });
        if (path.endsWith("/audio/tasks")) throw new Error("private upstream connection");
        return Response.json(view());
    }));
    const error = await client.submit(intent, confirmed, "uncertain-audio").catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "unconfirmed", outcome: "unknown" }); expect(String(error)).not.toContain("private");
    await expect(client.submit(intent, confirmed, "uncertain-audio")).rejects.toMatchObject({ code: "already_submitted", outcome: "unknown" });
    await expect(client.submit(intent, confirmed, "another-key")).rejects.toMatchObject({ code: "already_submitted", outcome: "unknown" });
    expect((await client.recover("uncertain-audio")).task.id).toBe(taskId);
    expect(calls.filter(call => call.path.endsWith("/audio/tasks"))).toHaveLength(1);
    expect(calls.at(-1)?.init?.method).toBe("GET"); expect(calls.at(-1)?.path).toBe("/api/v1/generation/tasks/by-key/uncertain-audio");
});

test("explicit server rejections, uncertain submissions and three task states retain their distinct meaning", async () => {
    for (const [code, status, outcome] of [["price_changed", 409, "rejected"], ["idempotency_conflict", 409, "unknown"], ["generation_unavailable", 503, "rejected"], ["private_error", 502, "unknown"]] as const) {
        const { client, confirmed } = await prepared(fixture(async path => Response.json(path.endsWith("/models") ? { items: [model] } : path.endsWith("/quote") ? { quote } : { error: { code, message: "private details" } }, { status: path.endsWith("/audio/tasks") ? status : 200 })));
        const error = await client.submit(intent, confirmed, "rejected-audio").catch((error: unknown) => error);
        expect(error).toMatchObject({ outcome }); expect(String(error)).not.toContain("private");
    }
    for (const status of ["failed", "unknown"] as const) {
        const data = view(); data.task.executionStatus = status; data.task.deliveryStatus = status; data.task.billingStatus = status === "unknown" ? "pending_review" : "released";
        Object.assign(data.task.billing, { capturedCredits: "0", releasedCredits: status === "failed" ? "7" : "0" });
        data.result.status = status; (data.result as unknown as Record<string, unknown>).resultSnapshot = {};
        const accepted = await fixture(async () => Response.json(data)).client.get(taskId);
        expect(accepted.task.executionStatus).toBe(status); expect(accepted.task.deliveryStatus).toBe(status); expect(accepted.result?.status).toBe(status);
    }
});

test("abort before submission sends nothing; an abort during submission preserves an uncertain receipt", async () => {
    const initial = await prepared(), before = new AbortController(); before.abort();
    await expect(initial.client.submit(intent, initial.confirmed, "before-abort", before.signal)).rejects.toMatchObject({ code: "aborted", outcome: "not-sent" });
    expect(initial.calls).toHaveLength(2);
    const during = new AbortController(), reply = deferred<Response>(), started = deferred<void>();
    const next = await prepared(fixture(async path => {
        if (path.endsWith("/models")) return Response.json({ items: [model] });
        if (path.endsWith("/quote")) return Response.json({ quote });
        started.resolve(); return reply.promise;
    }));
    const pending = next.client.submit(intent, next.confirmed, "during-abort", during.signal); await started.promise; during.abort(); reply.resolve(Response.json(view()));
    await expect(pending).rejects.toMatchObject({ code: "aborted", outcome: "unknown" });
    await expect(next.client.submit(intent, next.confirmed, "during-abort")).rejects.toMatchObject({ code: "already_submitted" });
    expect(next.calls).toHaveLength(3);
});

test("optional billing remains absent or null; invalid historical audio evidence remains uncertain", async () => {
    for (const billing of [undefined, null]) {
        const data = view();
        if (billing === undefined) delete (data.task as unknown as Record<string, unknown>).billing;
        else (data.task as unknown as Record<string, unknown>).billing = null;
        const accepted = await fixture(async () => Response.json(data)).client.get(taskId);
        expect(accepted.task.billing).toBe(billing);
        expect(Object.hasOwn(accepted.task, "billing")).toBe(billing === null);
    }
    const data = view(); data.task.executionStatus = "unknown"; data.task.deliveryStatus = "unknown"; data.task.billingStatus = "pending_review";
    (data.task as unknown as Record<string, unknown>).audioSnapshot = { status: "invalid" };
    (data.result as unknown as Record<string, unknown>).resultSnapshot = {}; data.result.status = "unknown";
    expect((await fixture(async () => Response.json(data)).client.get(taskId)).task.audioSnapshot).toEqual({ status: "invalid" });
    data.result.status = "succeeded"; (data.result as unknown as Record<string, unknown>).resultSnapshot = { kind: "audio" };
    await expect(fixture(async () => Response.json(data)).client.get(taskId)).rejects.toMatchObject({ code: "unconfirmed", outcome: "not-sent" });
});
