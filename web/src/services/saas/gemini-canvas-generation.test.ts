import { expect, test } from "bun:test";
import { createGenerationClient, type GenerationIntent, type GenerationScope } from "./generation";
import { createMappedImageGenerationClient, chooseImageMapping, selectedImageMapping, imageMappingAspectRatio } from "./mapped-image-generation";
import { createCanvasImageGenerationController, createGenerationReceiptStore } from "./canvas-image-generation";
import { insertGeneratedImage } from "./canvas-generated-image";
import { createMediaClient } from "../api/media";
import { generationImageMediaId } from "../../../../apps/api/src/generation-image";
import { isCloudMediaId } from "./cloud-media-reference";
import { GEMINI_IMAGE_PROTOCOL as protocol, GEMINI_IMAGE_USAGE as usagePolicy } from "../../../../packages/shared/src/generation-gemini-image";

const scope: GenerationScope = { accountId: "gemini-canvas-owner", epoch: 1, projectId: "original-canvas" };
const taskId = "11111111-1111-4111-8111-111111111111", media2 = generationImageMediaId(taskId, 1);
const spec = { aspectRatio: "1:1", imageSize: "512" } as const;
const intent = (budgetCredits = 17): GenerationIntent => ({ modelId: "native-image", projectId: scope.projectId, nodeId: "original-node",
    input: { prompt: "synthetic image" }, parameters: { protocol, ...spec, budgetCredits } });
const media = (id: string) => ({ mediaId: id, kind: "image", contentType: "image/png", sizeBytes: 3, etag: id });
function task(budget = 17, count = 2) {
    return { task: { id: taskId, projectId: scope.projectId, nodeId: "original-node", modelId: "native-image", priceVersion: 3, quotedUnits: budget,
        executionStatus: "succeeded", deliveryStatus: "visible", billingStatus: "captured", billingUnitSnapshot: "image", creditsPerUnitSnapshot: 7,
        geminiImage: { protocol, usagePolicy, parameters: intent(budget).parameters, creditsPerImage: 7 },
        billing: { reservedCredits: String(budget), capturedCredits: String(count * 7), releasedCredits: String(budget - count * 7) } },
        result: { taskId, status: "succeeded", consumedUnits: count, resultSnapshot: { kind: "image", media: media(taskId),
            ...(count > 1 ? { imageMedia: [media(taskId), media(media2)] } : {}) } } };
}
function fixture() {
    let current: GenerationScope | null = { ...scope }, read = task(), version = 3, price = 7, reject = false;
    let intercept: ((path: string, data: any) => unknown | Promise<unknown>) | undefined;
    const calls: { path: string; body: any; method: string }[] = [], backing = new Map<string, unknown>();
    const receipts = createGenerationReceiptStore({ keys: async () => [...backing.keys()], getItem: async key => structuredClone(backing.get(key) ?? null),
        setItem: async (key, value) => { backing.set(key, structuredClone(value)); return value; } });
    const client = () => createMappedImageGenerationClient({ scope, getScope: () => current, fetcher: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input), body = init?.body ? JSON.parse(String(init.body)) : null;
        calls.push({ path, body, method: init?.method ?? "GET" });
        if (path.endsWith("/tasks") && reject) return Response.json({ error: { code: "insufficient_balance" } }, { status: 402 });
        let data = path.endsWith("/models") ? { items: [{ id: "native-image", displayName: "Gemini Flash", capability: "image", group: null,
            imagePricing: { priceVersion: version, billingUnit: "image_specs", creditsPerUnit: null, protocol, usagePolicy, imageSpecs: [{ parameters: spec, creditsPerImage: price }] } }] }
            : path.endsWith("/model-mapping-catalog") ? { catalog: { version: 1, models: [{ id: "gemini-flash", displayName: "Gemini Flash", capability: "image", group: "Google",
                specifications: ["512"], combinations: [{ specification: "512", execution: { protocol, parameters: spec }, available: true, nodeModelId: "native-image", priceVersion: version, credits: price }] }] } }
            : path.endsWith("/quote") ? { quote: { modelId: body.modelId, priceVersion: version, billingUnit: "image", usagePolicy, creditsPerUnit: price,
                quotedUnits: body.parameters.budgetCredits, parameters: body.parameters, quoteFingerprint: "a".repeat(64) } }
            : read;
        return Response.json(intercept ? await intercept(path, data) : data);
    }, { preconnect: fetch.preconnect }) });
    const controller = (c = client()) => ({ client: c, controller: createCanvasImageGenerationController({ client: c, getContext: () => current,
        receiptStore: receipts, createIdempotencyKey: () => "native-once" }) });
    return { client, controller, calls, receipts, backing, history: (value: ReturnType<typeof task>) => { read = value; },
        intercept: (value: typeof intercept) => { intercept = value; }, reprice: () => { version = 4; price = 21; },
        reject: () => { reject = true; }, switchAccount: () => { current = { ...scope, accountId: "another" }; } };
}
const prepare = async (f: ReturnType<typeof fixture>, budget = 17) => {
    const pair = f.controller(); await pair.client.mappedModels();
    await pair.controller.prepare({ modelId: "native-image", prompt: "synthetic image", nodeId: "original-node", parameters: intent(budget).parameters });
    return pair;
};

test("native published mapping keeps ratios, 512 and per-image price; does not invent a fixed count", async () => {
    const f = fixture(), c = f.client(), models = await c.mappedModels();
    const chosen = selectedImageMapping(models, chooseImageMapping(models[0]));
    expect(chosen).toMatchObject({ available: true, credits: 7, execution: { protocol, parameters: spec } });
    expect(chosen?.maxImages).toBeUndefined(); expect(imageMappingAspectRatio(chosen!)).toBe("1:1");
    expect(await c.quote(intent())).toMatchObject({ billingUnit: "image", quotedUnits: 17, creditsPerUnit: 7, usagePolicy });
    await expect(c.quote({ ...intent(), parameters: { ...intent().parameters, n: 10 } as never })).rejects.toMatchObject({ code: "invalid_input" });
    expect(f.calls.filter(call => call.path.endsWith("/quote"))).toHaveLength(1);
});

test("catalog price disagreement disables the mapping without a quote or task", async () => {
    const f = fixture(); f.intercept((path, data) => { if (path.endsWith("/models")) data.items[0].imagePricing.imageSpecs[0].creditsPerImage = 9; return data; });
    const c = f.client(); expect((await c.mappedModels())[0].combinations[0].available).toBe(false);
    await expect(c.quote(intent())).rejects.toMatchObject({ code: "catalog_changed" });
    expect(f.calls.every(call => call.method === "GET")).toBe(true);
});

test("budget changes discard an in-flight quote and freeze the new intent through one submission", async () => {
    const f = fixture(), { client, controller: c } = f.controller(); await client.mappedModels();
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
    f.intercept(async (path, data) => { if (path.endsWith("/quote") && data.quote.quotedUnits === 17) { entered(); await waiting; } return data; });
    const first = c.prepare({ modelId: "native-image", prompt: "old", parameters: intent().parameters, nodeId: "original-node" }); await started;
    c.invalidateQuote(); await c.prepare({ modelId: "native-image", prompt: "new", parameters: intent(20).parameters, nodeId: "original-node" });
    release(); await first;
    expect(c.getState()).toMatchObject({ phase: "ready", quote: { quotedUnits: 20, parameters: { budgetCredits: 20 } } });
    expect(Object.isFrozen(c.getState().quote?.parameters)).toBe(true);
    f.history(task(20)); await c.confirm(); await c.confirm();
    expect(c.getState().phase).toBe("tracking");
    const posts = f.calls.filter(call => call.path.endsWith("/tasks")); expect(posts).toHaveLength(1);
    expect(posts[0].body.parameters).toEqual({ protocol, ...spec, budgetCredits: 20 }); expect(posts[0].body.input.prompt).toBe("new");
});

test("insufficient balance retains a rejected receipt and permits an explicit new budget", async () => {
    const f = fixture(), { controller: c } = await prepare(f); f.reject(); await c.confirm();
    expect(c.getState()).toMatchObject({ phase: "rejected", receipt: { rejection: "insufficient_balance" } });
    const saved = (await f.receipts.list(scope.accountId, scope.projectId))[0];
    const restored = f.controller().controller; await restored.restoreReceipt(saved);
    expect(restored.getState().phase).toBe("rejected"); expect(c.startNew()).toBe(true);
    await c.prepare({ modelId: "native-image", prompt: "synthetic image", parameters: intent(7).parameters });
    expect(c.getState()).toMatchObject({ phase: "ready", quote: { quotedUnits: 7 } });
    expect(f.calls.filter(call => call.path.endsWith("/tasks"))).toHaveLength(1);
});

test("refresh after repricing reads original budget, debit and release without current catalogs or resubmission", async () => {
    const f = fixture(), { controller: c } = await prepare(f); await c.confirm();
    const reference = c.getState().receipt!; c.close(); f.reprice(); const start = f.calls.length;
    const restored = f.controller().controller; await restored.restoreReceipt(reference);
    expect(restored.getState()).toMatchObject({ phase: "tracking", view: { task: { priceVersion: 3, geminiImage: { creditsPerImage: 7 },
        billing: { reservedCredits: "17", capturedCredits: "14", releasedCredits: "3" } } } });
    expect(f.calls.slice(start).map(call => [call.method, call.path])).toEqual([["GET", `/api/v1/generation/tasks/${taskId}`]]);
});

test("over-budget or bad batch remains pending review and cannot be added", async () => {
    const f = fixture(), pending = task(); pending.task.executionStatus = "unknown"; pending.task.deliveryStatus = "unknown";
    pending.task.billingStatus = "pending_review"; pending.task.billing.capturedCredits = "0"; pending.task.billing.releasedCredits = "0";
    f.history({ ...pending, result: null } as never);
    const view = await f.client().get(taskId);
    expect(view.task.billing).toEqual({ reservedCredits: "17", capturedCredits: "0", releasedCredits: "0" });
    await expect(insertGeneratedImage({ view, media: {} as never, signal: new AbortController().signal, isCurrent: () => true,
        commit: () => { throw new Error("must not apply"); } })).rejects.toThrow();
});

test("native histories reject forged budget, price, ledger, missing images and mixed protocols", async () => {
    for (const change of [
        (v: any) => { v.task.geminiImage.parameters.budgetCredits = 18; },
        (v: any) => { v.task.geminiImage.creditsPerImage = 8; },
        (v: any) => { v.task.billing.releasedCredits = "10"; },
        (v: any) => { delete v.result.resultSnapshot.imageMedia; },
        (v: any) => { v.result.consumedUnits = 1; },
        (v: any) => { v.result.resultSnapshot.imageMedia[1] = v.result.resultSnapshot.imageMedia[0]; },
        (v: any) => { v.task.imageSpecSnapshot = { status: "invalid" }; },
        (v: any) => { delete v.task.geminiImage; },
    ]) {
        const f = fixture(), value = task(); change(value); f.history(value);
        await expect(f.client().get(taskId)).rejects.toMatchObject({ code: "unconfirmed" });
    }
});

test("one or multiple delivered images use their actual order and decoded native dimensions", async () => {
    for (const count of [1, 2]) {
        const f = fixture(); f.history(task(17, count)); const view = await f.client().get(taskId);
        let applied: any, created = 0;
        expect(await insertGeneratedImage({ view, signal: new AbortController().signal, isCurrent: () => true,
            media: { resolve: async ids => ({ items: ids.map(id => ({ id, kind: "image", contentType: "image/png", sizeBytes: 3 })), missing: [] }) as never,
                download: async () => new Blob(["png"], { type: "image/png" }) }, createUrl: () => `blob:${++created}`,
            decode: async () => ({ width: 512, height: 512 }), revokeUrl: () => { throw new Error("committed"); }, commit: image => { applied = image; return true; } })).toBe(true);
        expect((applied.images ?? [applied]).map((item: any) => item.cloudMediaId)).toEqual(count === 1 ? [taskId] : [taskId, media2]);
    }
});

test("a bad second image or account switch leaves the entire canvas batch unapplied", async () => {
    const f = fixture(), view = await f.client().get(taskId), revoked: string[] = []; let decoded = 0, applied = false;
    await expect(insertGeneratedImage({ view, signal: new AbortController().signal, isCurrent: () => true,
        media: { resolve: async ids => ({ items: ids.map(id => ({ id, kind: "image", contentType: "image/png", sizeBytes: 3 })), missing: [] }) as never,
            download: async () => new Blob(["png"], { type: "image/png" }) }, createUrl: () => `blob:${decoded}`,
        decode: async () => ({ width: ++decoded === 1 ? 512 : 64, height: 512 }), revokeUrl: url => revoked.push(url), commit: () => { applied = true; return true; } })).rejects.toThrow("原生规格");
    expect(applied).toBe(false); expect(revoked).toHaveLength(2);
    const { controller: c } = await prepare(f); f.switchAccount(); await c.confirm();
    expect(f.calls.filter(call => call.path.endsWith("/tasks"))).toHaveLength(0);
});

test("native batch uses the real media client for deterministic additional-image IDs", async () => {
    const f = fixture(), view = await f.client().get(taskId), calls: string[] = [];
    const items = [taskId, media2].map(id => ({ id, kind: "image", contentType: "image/png", sizeBytes: 3,
        createdAt: "2026-10-25T00:00:00Z", url: `/api/v1/media/${id}` }));
    const client = createMediaClient(() => scope.accountId, async (input, init) => {
        const path = String(input); calls.push(path);
        expect(new Headers(init?.headers).get("x-canvas-account-id")).toBe(scope.accountId);
        if (path === "/api/v1/media/resolve") {
            expect(JSON.parse(String(init?.body))).toEqual({ ids: [taskId, media2] });
            return Response.json({ items, missing: [] });
        }
        expect(items.some(item => item.url === path)).toBe(true);
        return new Response("png", { headers: { "content-type": "image/png" } });
    });
    let applied: string[] = [];
    expect(await insertGeneratedImage({ view, media: client, signal: new AbortController().signal, isCurrent: () => true,
        createUrl: () => "blob:synthetic", decode: async () => ({ width: 512, height: 512 }),
        commit: image => { applied = image.images!.map(item => item.cloudMediaId); return true; } })).toBe(true);
    expect(applied).toEqual([taskId, media2]); expect(applied.every(isCloudMediaId)).toBe(true);
    expect(calls).toEqual(["/api/v1/media/resolve", ...items.map(item => item.url)]);
});

test("a mismatched returned quote or accepted task never becomes ready or trusted", async () => {
    const f = fixture(); f.intercept((path, data) => { if (path.endsWith("/quote")) data.quote.parameters.budgetCredits = 18; return data; });
    expect((await prepare(f)).controller.getState().phase).toBe("failed");
    const second = fixture(), { controller } = await prepare(second); second.history(task(20)); await controller.confirm();
    expect(controller.getState()).toMatchObject({ phase: "uncertain", view: null });
});
