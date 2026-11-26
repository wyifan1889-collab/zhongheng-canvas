import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import type { Socket } from "node:net";
import { afterAll, beforeAll, mock, spyOn, test } from "bun:test";
import actualExpress from "express";

import type { AgentAttachment, AgentCanvasReference, AgentMessageMetadata } from "../agent/types.js";

// Run this file in its own Bun process: its module mocks isolate the real HTTP
// router from user configuration, CLI startup, skills and external engines.
type Counted = { mock: { calls: unknown[][] }; mockClear(): unknown };
type RunOptions = { onStart?(): void; onThread?(id: string): void; onTurn?(id: string): void; onFinish?(outcome: { status: "completed"; threadId: string; turnId: string }): void };
const effects: Record<string, Counted> = {};
const runs: Array<{ prompt: string; attachments: AgentAttachment[] }> = [];
const sockets = new Set<Socket>();
const threadId = "synthetic-reference-thread", clientId = "synthetic-reference-client";
let directory = "", metadataDirectory = "", base = "", token = "";
let server: Server | undefined;
let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
const eventAbort = new AbortController();
let store: InstanceType<typeof import("../agent/message-metadata.js").MessageMetadataStore>;
let turnNumber = 0;

beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "canvas-http-references-"));
    metadataDirectory = path.join(directory, "metadata");
    token = randomUUID();
    const workspace = { workspacePath: path.join(directory, "workspace"), activeThreadId: threadId };
    const config = { url: "http://127.0.0.1:0", token, workspace };
    mock.module("../config.js", () => ({
        DEFAULT_PORT: 17371, CONFIG_DIR: path.join(directory, "config"),
        loadConfig: () => config, saveConfig: () => {},
        ensureSiteWorkspace: () => workspace,
        updateSiteWorkspace: (_config: unknown, patch: object) => Object.assign(workspace, patch),
    }));
    mock.module("../utils/logger.js", () => ({ logger: { enabled: false, filePath: "", info() {}, debug() {}, warn() {}, error() {} } }));
    const unexpected = (name: string) => effects[name] = mock(() => { throw new Error(`Unexpected external boundary: ${name}`); });
    mock.module("../agent/claude.js", () => ({ runClaudeTurn: unexpected("claude") }));
    mock.module("../version-check.js", () => ({ checkVersions: unexpected("versionCheck") }));
    class BoundaryError extends Error { constructor(message: string, readonly statusCode = 400) { super(message); } }
    mock.module("../skills/store.js", () => ({ SkillStore: class {}, SkillStoreError: BoundaryError }));
    const resolveSkill = mock(async (_emit: unknown, _cwd: string, selector: { name: string; path: string }) => selector);
    effects.resolveSkill = resolveSkill;
    const run = mock(async (prompt: string, _emit: unknown, attachments: AgentAttachment[], options: RunOptions) => {
        runs.push({ prompt, attachments });
        options.onStart?.();
        options.onThread?.(threadId);
        const turnId = `synthetic-turn-${++turnNumber}`;
        options.onTurn?.(turnId);
        options.onFinish?.({ status: "completed", threadId, turnId });
    });
    effects.run = run;
    mock.module("../agent/codex.js", () => ({
        CodexSkillLookupError: BoundaryError, resolveCodexSkill: resolveSkill, runCodexTurn: run,
        isRecoverableThreadError: () => false, summarizeCodexThread: (value: unknown) => value,
        ...Object.fromEntries([
            "archiveCodexThread", "configureCodexSkill", "generateCodexSkillDraft", "interruptCodexTurn",
            "listCodexModels", "listCodexSkills", "listCodexThreads", "readCodexThread",
            "resolveCodexApproval", "resumeCodexThread", "startCodexThread",
        ].map((name) => [name, unexpected(name)])),
    }));

    const { MessageMetadataStore } = await import("../agent/message-metadata.js");
    store = new MessageMetadataStore(metadataDirectory);
    for (const name of ["recordPending", "bindThread", "bindTurn", "remove", "removeThread", "mergeThread", "readAsset"] as const) {
        effects[`metadata.${name}`] = spyOn(store, name);
    }
    mock.module("../agent/message-metadata.js", () => ({ MessageMetadataStore, messageMetadataStore: store }));
    const { CanvasSession } = await import("../canvas/session.js");
    for (const name of ["bindClient", "markConversationRunning", "setCodexState", "setTurnAttachments", "emitThread", "emitAll"] as const) {
        effects[`session.${name}`] = spyOn(CanvasSession.prototype, name);
    }

    let listening!: () => void, failed!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { listening = resolve; failed = reject; });
    // Capture the function value before Bun replaces the module's live binding.
    const realExpress = actualExpress;
    const makeExpress = Object.assign(() => {
        const app = realExpress();
        // Keep actual Express JSON parsing, middleware and route handlers. Only
        // replace the listener and omit the unrelated CLI/preheat callback.
        app.listen = (() => {
            server = createServer(app);
            server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
            server.once("error", failed);
            return server.listen(0, "127.0.0.1", listening);
        }) as typeof app.listen;
        return app;
    }, { json: realExpress.json });
    mock.module("express", () => ({ default: makeExpress }));
    const { startHttpServer } = await import("./http.js");
    startHttpServer();
    await ready;
    const address = server!.address();
    assert.ok(address && typeof address !== "string");
    base = `http://127.0.0.1:${address.port}`;

    const unauthorized = await fetch(`${base}/agent/codex/workspace`);
    assert.equal(unauthorized.status, 401);
    await unauthorized.arrayBuffer();
    const events = await fetch(`${base}/events?clientId=${clientId}&ownerContext=local`, { headers: auth(), signal: eventAbort.signal });
    assert.equal(events.status, 200);
    assert.ok(events.body);
    reader = events.body.getReader();
    const decoder = new TextDecoder();
    let firstFrame = "";
    while (!firstFrame.includes("\n\n")) {
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        firstFrame += decoder.decode(chunk.value, { stream: true });
    }
    assert.match(firstFrame, /^event: hello\n/);
    const health = await getJson("/health");
    assert.equal(health.clients, 1);
    assert.equal(health.codexBusy, false);
    assert.equal((health.conversation as Record<string, unknown>).status, "ready");
    clearEffects();
});

afterAll(async () => {
    try {
        eventAbort.abort();
        await reader?.cancel().catch(() => undefined);
        if (server?.listening) {
            const closed = new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
            sockets.forEach((socket) => socket.destroy());
            await closed;
        } else sockets.forEach((socket) => socket.destroy());
    } finally {
        if (store) await store.mergeThread(threadId, []).catch(() => undefined);
        mock.restore();
        if (directory) await fs.rm(directory, { recursive: true, force: true });
    }
});

test("HTTP rejects oversized or conflicting sources before skill, history, attachments, turn or broadcast effects", async () => {
    const uploads = Array.from({ length: 13 }, (_, index) => upload(index));
    const refs = Array.from({ length: 13 }, (_, index) => reference(index, "text"));
    const cases = [
        { name: "13 uploads", attachments: uploads, messageMetadata: { attachments: uploads.map(display) }, exactError: "参考素材最多 12 个" },
        { name: "13 canvas references", attachments: [], messageMetadata: { canvasReferences: refs }, exactError: "参考素材最多 12 个" },
        { name: "same-ID conflicting carrier", attachments: [upload(0), { ...upload(0), dataUrl: "data:image/png;base64,Yg==" }], messageMetadata: {} },
        { name: "forged canvas pairing", attachments: [{ ...upload(0), id: "canvas:missing-node" }], messageMetadata: { canvasReferences: [reference(0)] } },
    ];
    for (const input of cases) {
        clearEffects();
        const response = await postTurn(input.attachments, input.messageMetadata);
        assert.equal(response.status, 400, input.name);
        const body = await response.json() as { ok: boolean; error: string };
        assert.equal(body.ok, false, input.name);
        assert.ok(body.error, input.name);
        if (input.exactError) assert.equal(body.error, input.exactError, input.name);
        for (const [name, effect] of Object.entries(effects)) assert.equal(effect.mock.calls.length, 0, `${input.name}: ${name}`);
        await assert.rejects(() => fs.stat(metadataDirectory), { code: "ENOENT" }, input.name);
        const health = await getJson("/health");
        assert.equal(health.codexBusy, false, input.name);
        assert.equal((health.conversation as Record<string, unknown>).status, "ready", input.name);
    }
});

test("12 uploads reach session and engine as one normalized batch even when the HTTP input repeats a carrier", async () => {
    const canonical = Array.from({ length: 12 }, (_, index) => upload(index));
    clearEffects();
    const response = await postTurn([...canonical, { ...canonical[0], id: ` ${canonical[0]!.id} ` }], { attachments: canonical.map(display) });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { ok: boolean }).ok, true);
    assertNormalizedBatch(canonical.map((entry) => entry.id!));
    assert.equal(effects.resolveSkill!.mock.calls.length, 1);
    assert.equal(effects["metadata.recordPending"]!.mock.calls.length, 1);
    await store.mergeThread(threadId, []); // Drain the real store's queued bind callbacks.
});

test("12 canvas images retain paired carriers and normalize duplicate references before metadata and engine boundaries", async () => {
    const refs = Array.from({ length: 12 }, (_, index) => reference(index));
    const canonical = refs.map((entry, index) => ({ ...upload(index), id: `canvas:${entry.nodeId}` }));
    clearEffects();
    const response = await postTurn([...canonical, { ...canonical[0] }], {
        canvasReferences: [{ ...refs[0], nodeId: ` ${refs[0]!.nodeId} ` }, ...refs.slice(1), { ...refs[0] }],
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { ok: boolean }).ok, true);
    assertNormalizedBatch(canonical.map((entry) => entry.id));
    const metadataInput = effects["metadata.recordPending"]!.mock.calls[0]![1] as AgentMessageMetadata;
    assert.deepEqual(metadataInput.canvasReferences?.map((entry) => entry.nodeId), refs.map((entry) => entry.nodeId));
    await store.mergeThread(threadId, []);
});

function assertNormalizedBatch(ids: string[]) {
    assert.equal(runs.length, 1);
    const sessionCalls = effects["session.setTurnAttachments"]!.mock.calls;
    assert.equal(sessionCalls.length, 1);
    assert.strictEqual(sessionCalls[0]![1], runs[0]!.attachments);
    assert.deepEqual(runs[0]!.attachments.map((entry) => entry.id), ids);
    const context = runs[0]!.prompt.split("\n").filter((line) => line.includes("attachmentId="));
    assert.equal(context.length, ids.length);
    ids.forEach((id, index) => assert.ok(context[index]!.includes(`attachmentId=${id},`)));
    assert.ok(effects["session.emitThread"]!.mock.calls.some((call) => call[0] === "chat_message"));
}

function clearEffects() { Object.values(effects).forEach((effect) => effect.mockClear()); runs.length = 0; }
function auth() { return { "x-canvas-agent-token": token }; }
async function getJson(route: string) {
    const response = await fetch(`${base}${route}`, { headers: auth() });
    assert.equal(response.status, 200);
    return await response.json() as Record<string, unknown>;
}
async function postTurn(attachments: unknown, messageMetadata: unknown) {
    const current = await getJson("/agent/codex/workspace");
    const conversation = current.conversation as Record<string, unknown>;
    assert.equal(conversation.status, "ready");
    return await fetch(`${base}/agent/codex/turn`, {
        method: "POST", headers: { ...auth(), "content-type": "application/json" },
        body: JSON.stringify({
            clientId, ownerContext: "local", threadId, conversationId: conversation.conversationId, expectedRevision: conversation.revision,
            prompt: "Synthetic reference test", messageId: randomUUID(), attachments, messageMetadata,
            skill: { name: "synthetic-skill", path: path.join(directory, "SKILL.md") },
        }),
    });
}
function upload(index: number): AgentAttachment {
    return { id: `upload-${index}`, name: `image-${index}.png`, type: "image/png", dataUrl: "data:image/png;base64,YQ==", size: 1, width: 1, height: 1 };
}
function display(attachment: AgentAttachment) { return { ...attachment, url: attachment.dataUrl }; }
function reference(index: number, kind: AgentCanvasReference["kind"] = "image"): AgentCanvasReference {
    return { nodeId: `node-${index}`, kind, label: `@${index}`, title: `Reference ${index}`, ...(kind === "image" ? { previewUrl: "data:image/png;base64,YQ==" } : {}) };
}
