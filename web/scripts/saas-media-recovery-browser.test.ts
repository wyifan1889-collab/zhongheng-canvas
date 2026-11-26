/** Set CANVAS_MEDIA_RECOVERY_HTTP_TEST=1 to run this development-only HTTP check; ordinary test discovery skips it. No browser is driven or used to decode images. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer as createPortProbe } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createMediaClient } from "../src/services/api/media";
import { createDraftClient } from "../src/services/saas/drafts";
import { createAccountClient } from "../src/services/saas/account";
import { inspectCanvasDocument } from "../src/services/saas/canvas-document";
import { validateCanvasDocumentMount } from "../src/services/saas/canvas-document-mount";
import { hydrateCanvasCloudMediaDocument, revokeCloudMediaObjectUrls } from "../src/services/saas/cloud-media-hydration";

const origin = "http://127.0.0.1:4180";
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const A = "synthetic-save-account", B = "synthetic-save-account-b";
const mediaA = "68591890-0000-4000-9000-000000000001", mediaB = "68591890-0000-4000-9000-000000000002";
const draftA = "68591890-0000-4000-8000-000000000001", draftB = "68591890-0000-4000-8000-000000000002";
const pngSha = "d0284c7222f68c1a8e70ff8016f9c9a1e61a230ef1f2a4b8d86c983546776061";
const contractTest = process.env.CANVAS_MEDIA_RECOVERY_HTTP_TEST === "1" ? test : test.skip;
type State = {
    account: { id: string; role: "user" | "admin" }; draftCount: number;
    mediaRecovery?: { enabled: boolean; scenario: string; paused: boolean; pendingReads: number;
        resolveRequests: number; downloadRequests: number; draftWrites: number };
    accountRecheck?: { role: "user" | "admin"; downloadPaused: boolean; pendingDownloads: number;
        siteRequests: number; sessionRequests: number };
    cloudSelection?: { armed: boolean; pendingId: string | null; draftReads: number; draftWrites: number;
        fixtures: Array<{ id: string; title: string; revision: number }> };
};

// Deadlines below bound only this explicitly invoked test and its own child cleanup.
async function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(label)), milliseconds);
        })]);
    } finally { if (timer) clearTimeout(timer); }
}

async function assertPortFree() {
    const probe = createPortProbe();
    try {
        await new Promise<void>((resolveReady, reject) => {
            probe.once("error", reject);
            probe.listen({ host: "127.0.0.1", port: 4180, exclusive: true }, resolveReady);
        });
    } catch { throw new Error("Port 4180 is occupied or unavailable; this test never stops an existing process."); }
    finally { if (probe.listening) await new Promise<void>((resolveClosed, reject) => probe.close((error) => error ? reject(error) : resolveClosed())); }
}

async function withHarness(mediaMode: boolean, run: () => Promise<void>, mountPersistence = false, accountRecheck = false, cloudSelection = false) {
    await assertPortFree();
    const child = Bun.spawn({
        cmd: [process.execPath, "--no-env-file", "run", "scripts/saas-first-save-browser.ts", ...(mediaMode ? ["--media-recovery"] : []), ...(mountPersistence ? ["--mount-persistence"] : []), ...(accountRecheck ? ["--account-recheck"] : []), ...(cloudSelection ? ["--cloud-selection"] : [])],
        cwd: webDir, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    let output = "", ready!: () => void, failed!: (error: Error) => void;
    const started = new Promise<void>((resolveReady, reject) => { ready = resolveReady; failed = reject; });
    const stderr = new Response(child.stderr).text();
    const stdout = (async () => {
        const reader = child.stdout.getReader(), decoder = new TextDecoder();
        try {
            for (;;) {
                const next = await reader.read();
                if (next.done) break;
                output += decoder.decode(next.value, { stream: true });
                // Readiness comes from this spawned child, never an unrelated listener on the same port.
                if (output.includes(`${origin}/canvas`)) ready();
            }
        } finally { reader.releaseLock(); }
    })();
    void stdout.catch((error) => failed(new Error(`Could not read the test-owned harness output: ${String(error)}`)));
    void child.exited.then(async (code) => failed(new Error(`Harness exited before readiness (${code}): ${await stderr}`)));
    try {
        await within(started, 30_000, "The isolated harness did not become ready.");
        await run();
    } finally {
        if (child.exitCode === null) {
            child.kill();
            try { await within(child.exited, 5_000, "Harness cleanup did not finish."); }
            catch { child.kill("SIGKILL"); await within(child.exited, 5_000, "The test-owned harness could not be stopped."); }
        }
        await Promise.all([stdout, stderr]);
    }
}

function httpHarness() {
    const requests: Array<{ method: string; path: string; status: number }> = [];
    const transport: typeof fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, origin);
        if (url.origin !== origin) throw new Error("The contract check refuses non-loopback requests.");
        const method = init?.method ?? "GET", headers = new Headers(init?.headers);
        if (method !== "GET" && method !== "HEAD" && !headers.has("origin")) headers.set("origin", origin);
        const response = await fetch(url, { ...init, headers, redirect: "error", signal: init?.signal ?? AbortSignal.timeout(10_000) });
        requests.push({ method, path: url.pathname, status: response.status });
        return response;
    }, { preconnect: fetch.preconnect });
    const owned = (owner: string, path: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers); headers.set("x-canvas-account-id", owner);
        return transport(path, { ...init, headers });
    };
    const state = async (): Promise<State> => {
        const response = await transport("/__first-save-test/scenario");
        expect(response.status).toBe(200);
        return response.json();
    };
    const control = async (owner: string, change: Record<string, unknown>): Promise<State> => {
        const response = await owned(owner, "/__first-save-test/scenario", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(change),
        });
        expect(response.status).toBe(200);
        return response.json();
    };
    const pending = async (count: number, downloadsOnly = false) => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
            const value = await state();
            if ((downloadsOnly ? value.accountRecheck?.pendingDownloads : value.mediaRecovery?.pendingReads) === count) return value;
            await Bun.sleep(10);
        }
        throw new Error(`Expected ${count} pending media ${downloadsOnly ? "downloads" : "reads"}.`);
    };
    return { transport, owned, state, control, pending, requests };
}

async function apiError(response: Response, status: number, code: string) {
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
}
const outcome = <T>(promise: Promise<T>) => promise.then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

// Only the loopback fixture contract is covered here. Modal close/reselect and
// selection authority belong to the original application's separate acceptance.
contractTest("explicit cloud selection harness pauses one GET without blocking the directory or saving", async () => {
    const controlPath = "/__first-save-test/scenario";
    const changes = [{ seedSelection: true }, { pauseNextDraft: true }, { releaseDraft: true }];
    await withHarness(false, async () => {
        const h = httpHarness();
        expect((await h.state()).cloudSelection).toBeUndefined();
        for (const change of changes) {
            await apiError(await h.owned(A, controlPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(change) }), 400, "invalid_input");
        }
        expect((await h.state()).draftCount).toBe(0);
    });
    await withHarness(false, async () => {
        const h = httpHarness();
        const client = createDraftClient(() => ({ accountId: A, epoch: 1 }), h.transport);
        const initial = await h.state();
        expect(initial.mediaRecovery).toBeUndefined();
        expect(initial.cloudSelection).toMatchObject({ armed: false, pendingId: null, draftReads: 0, draftWrites: 0 });
        const [first, second] = initial.cloudSelection!.fixtures;
        expect(first).toMatchObject({ title: "模拟选版 A · 版本 3", revision: 3 });
        expect(second).toMatchObject({ title: "模拟选版 B · 版本 7", revision: 7 });
        expect(first.id).not.toBe(second.id);
        const post = (change: Record<string, unknown>) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(change) });
        await apiError(await h.owned(B, controlPath, post(changes[0])), 409, "account_changed");
        await apiError(await h.owned(A, controlPath, { ...post(changes[0]), headers: { "content-type": "application/json", origin: "https://unrelated.invalid" } }), 403, "invalid_origin");
        await apiError(await h.owned(A, controlPath, post({ seedSelection: true, pauseNextDraft: true })), 400, "invalid_input");
        expect((await h.control(A, changes[0])).cloudSelection?.draftWrites).toBe(2);
        expect((await h.control(A, changes[0])).cloudSelection?.draftWrites).toBe(2);
        const directory = await client.list();
        expect(directory.items.map(({ id, revision }) => ({ id, revision })).sort((a, b) => a.id.localeCompare(b.id)))
            .toEqual([first, second].map(({ id, revision }) => ({ id, revision })).sort((a, b) => a.id.localeCompare(b.id)));
        expect(directory.nextCursor).toBeNull();
        const waitPending = async (id: string | null) => {
            const deadline = Date.now() + 5_000;
            while (Date.now() < deadline) {
                const value = await h.state();
                if (value.cloudSelection?.pendingId === id) return value;
                await Bun.sleep(10);
            }
            throw new Error(`Expected the selection fixture pending ID to be ${id}.`);
        };
        await h.control(A, changes[1]);
        await apiError(await h.owned(A, controlPath, post(changes[1])), 409, "selection_busy");
        await apiError(await h.owned(B, `/api/v1/canvases/${first.id}`), 409, "account_changed");
        await apiError(await h.owned(A, "/api/v1/canvases/eec58100-0000-4000-8000-000000000099"), 404, "not_found");
        expect((await h.state()).cloudSelection?.armed).toBe(true);
        let settled = false;
        const held = outcome(client.get(first.id)).then((value) => { settled = true; return value; });
        expect((await waitPending(first.id)).cloudSelection?.armed).toBe(false);
        expect(await client.list()).toEqual(directory);
        const ready = await client.get(second.id);
        expect(ready).toMatchObject(second);
        expect(inspectCanvasDocument(ready.document).snapshot.nodes).toHaveLength(1);
        expect(settled).toBe(false);
        expect((await h.state()).cloudSelection?.pendingId).toBe(first.id);
        await h.control(A, changes[2]);
        const released = await held;
        if (!released.ok) throw released.error;
        expect(released.value).toMatchObject(first);
        expect(inspectCanvasDocument(released.value.document).snapshot.nodes).toHaveLength(1);
        expect(await client.get(first.id)).toEqual(released.value);
        expect(await client.list()).toEqual(directory);
        expect((await h.control(A, changes[0])).cloudSelection?.draftWrites).toBe(2);

        // Disconnect cleans the one-shot waiter; releasing twice never writes or re-arms.
        await h.control(A, changes[1]);
        const abort = new AbortController();
        const cancelled = outcome(h.owned(A, `/api/v1/canvases/${first.id}`, { signal: abort.signal }));
        await waitPending(first.id);
        abort.abort();
        expect(await cancelled).toMatchObject({ ok: false });
        await waitPending(null);
        await h.control(A, changes[2]);
        expect((await h.control(A, changes[2])).cloudSelection).toMatchObject({ armed: false, pendingId: null, draftWrites: 2 });

        await h.control(A, changes[1]);
        const staleOwner = outcome(h.owned(A, `/api/v1/canvases/${first.id}`));
        await waitPending(first.id);
        await h.control(A, { account: "B" });
        const denied = await staleOwner;
        if (!denied.ok) throw denied.error;
        await apiError(denied.value, 409, "account_changed");
        expect((await h.state()).cloudSelection).toMatchObject({ armed: false, pendingId: null, draftWrites: 2 });
        await apiError(await h.owned(B, `/api/v1/canvases/${first.id}`), 404, "not_found");
        await h.control(B, { account: "A" });
        expect(await client.list()).toEqual(directory);
        expect(h.requests.filter((request) => request.path.startsWith("/api/v1/canvases") && request.method !== "GET")).toEqual([]);
    }, false, false, true);
}, 120_000);

async function verifyPng(url: string) {
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.length).toBe(232);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(pngSha);
    // PNG signature/IHDR checks are byte-contract checks, not browser image decoding.
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([64, 48]);
}

contractTest("explicit media harness contracts over real HTTP, with default mode isolated and no browser claims", async () => {
    const invalid = spawnSync(process.execPath, ["--no-env-file", "run", "scripts/saas-first-save-browser.ts", "--mount-persistence"], {
        cwd: webDir, encoding: "utf8", timeout: 10_000,
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("--mount-persistence requires --media-recovery; no server was started.");
    expect(invalid.stdout).not.toContain(`${origin}/canvas`);
    const invalidRecheck = spawnSync(process.execPath, ["--no-env-file", "run", "scripts/saas-first-save-browser.ts", "--account-recheck"], {
        cwd: webDir, encoding: "utf8", timeout: 10_000,
    });
    expect(invalidRecheck.status).toBe(1);
    expect(invalidRecheck.stderr).toContain("--account-recheck requires --media-recovery; no server was started.");
    expect(invalidRecheck.stdout).not.toContain(`${origin}/canvas`);
    await withHarness(false, async () => {
        const h = httpHarness();
        expect(await (await h.transport("/canvas")).text()).not.toContain("/scripts/mount-persistence-gate.ts");
        expect((await (await h.transport("/api/v1/site")).json()).features.cloudMedia).toBe(false);
        expect((await h.state()).mediaRecovery).toBeUndefined();
        expect((await h.state()).accountRecheck).toBeUndefined();
        for (const change of [{ seedMedia: true }, { mediaScenario: "normal" }, { mediaPaused: true }, { cloudMedia: true }, { role: "admin" }, { downloadPaused: true }]) {
            await apiError(await h.owned(A, "/__first-save-test/scenario", {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(change),
            }), 400, "invalid_input");
        }
        await apiError(await h.owned(A, `/api/v1/media/${mediaA}`), 404, "not_found");
        await apiError(await h.owned(A, "/api/v1/media/resolve", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [mediaA] }),
        }), 404, "not_found");
        expect((await h.state()).draftCount).toBe(0);
    });

    await withHarness(true, async () => {
        const h = httpHarness(), urls: string[] = [];
        const createUrl = (blob: Blob) => { const url = URL.createObjectURL(blob); urls.push(url); return url; };
        const media = createMediaClient(() => A, h.transport);
        const drafts = createDraftClient(() => ({ accountId: A, epoch: 1 }), h.transport);
        try {
            expect((await h.state()).accountRecheck).toBeUndefined();
            for (const change of [{ role: "admin" }, { downloadPaused: true }]) {
                await apiError(await h.owned(A, "/__first-save-test/scenario", {
                    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(change),
                }), 400, "invalid_input");
            }
            const site = await (await h.transport("/api/v1/site")).json();
            expect(site.features).toMatchObject({ cloudCanvas: true, cloudMedia: true, recharge: false,
                generation: { text: false, image: false, video: false, audio: false } });
            expect((await h.state()).draftCount).toBe(0);
            const seeded = await h.control(A, { seedMedia: true });
            expect(seeded.mediaRecovery?.draftWrites).toBe(1);
            const source = await drafts.get(draftA), original = JSON.stringify(source);
            const inspected = inspectCanvasDocument(source.document, source.documentVersion);
            expect(inspected.mediaReferences.filter((ref) => ref.kind === "cloud-media").map((ref) => ref.cloudMediaId)).toEqual([mediaA]);
            expect(validateCanvasDocumentMount(source.document, source.documentVersion).status).toBe("mountable");
            expect((await h.control(A, { seedMedia: true })).mediaRecovery?.draftWrites).toBe(1);
            expect(await drafts.get(draftA)).toEqual(source);
            expect((await drafts.list()).items.map((draft) => draft.id)).toEqual([draftA]);

            const before = (await h.state()).mediaRecovery!;
            const first = await hydrateCanvasCloudMediaDocument(source.document, media, createUrl);
            const second = await hydrateCanvasCloudMediaDocument(source.document, media, createUrl);
            expect(first.objectUrls).toHaveLength(1); expect(second.objectUrls).toHaveLength(1);
            expect(first.objectUrls[0]).not.toBe(second.objectUrls[0]);
            await verifyPng(first.objectUrls[0]); await verifyPng(second.objectUrls[0]);
            expect(validateCanvasDocumentMount(second.document).project.nodes[0].metadata?.content).toBe(second.objectUrls[0]);
            const after = (await h.state()).mediaRecovery!;
            expect([after.resolveRequests - before.resolveRequests, after.downloadRequests - before.downloadRequests]).toEqual([2, 2]);
            revokeCloudMediaObjectUrls(first.objectUrls);
            await expect(fetch(first.objectUrls[0])).rejects.toThrow();
            await verifyPng(second.objectUrls[0]);
            expect(JSON.stringify(source)).toBe(original);

            for (const [scenario, code] of [["missing", "missing"], ["wrong-type", "download_failed"]] as const) {
                await h.control(A, { mediaScenario: scenario });
                await expect(hydrateCanvasCloudMediaDocument(source.document, media, createUrl)).rejects.toMatchObject({ code });
                expect(urls).toHaveLength(2);
                await verifyPng(second.objectUrls[0]);
                expect(await drafts.get(draftA)).toEqual(source);
                expect((await h.state()).mediaRecovery?.draftWrites).toBe(1);
            }
            await h.control(A, { mediaScenario: "normal" });
            const binary = await h.owned(A, `/api/v1/media/${mediaA}`);
            expect(binary.headers.get("content-length")).toBe("232");
            expect(binary.headers.get("cache-control")).toContain("no-store");
            expect(binary.headers.get("x-content-type-options")).toBe("nosniff");
            expect(createHash("sha256").update(Buffer.from(await binary.arrayBuffer())).digest("hex")).toBe(pngSha);

            await apiError(await h.transport(`/api/v1/media/${mediaA}`), 400, "account_context_required");
            await apiError(await h.owned(B, `/api/v1/media/${mediaA}`), 409, "account_changed");
            const resolveBody = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [mediaA] }) };
            await apiError(await h.transport("/api/v1/media/resolve", resolveBody), 400, "account_context_required");
            await apiError(await h.owned(B, "/api/v1/media/resolve", resolveBody), 409, "account_changed");
            for (const input of [{ ids: [] }, { ids: ["not-a-uuid"] }, { ids: [mediaA], owner: A }, { ids: Array(101).fill(mediaA) }]) {
                await apiError(await h.owned(A, "/api/v1/media/resolve", {
                    ...resolveBody, body: JSON.stringify(input),
                }), 400, "invalid_input");
            }
            await apiError(await h.owned(A, "/api/v1/media/resolve?extra=1", resolveBody), 400, "invalid_input");
            for (const [path, method] of [["/api/v1/media", "POST"], [`/api/v1/media/${mediaA}`, "DELETE"],
                ["/api/v1/media/resolve", "GET"], ["/api/v1/not-implemented", "GET"], ["/api/v1/generations", "POST"]]) {
                await apiError(await h.owned(A, path, { method }), 404, "not_found");
            }
            await apiError(await h.transport("/api/v1/site", { headers: { origin: "https://unrelated.invalid" } }), 403, "invalid_origin");
            // Vite rejects a foreign Host before the fixture middleware, using a plain-text response.
            const blockedHost = await h.transport("/api/v1/site", { headers: { host: "unrelated.invalid" } });
            expect(blockedHost.status).toBe(403);
            expect(await blockedHost.text()).toContain("Blocked request");
            await apiError(await h.transport("/api/v1/site", { headers: { "sec-fetch-site": "cross-site" } }), 403, "invalid_origin");
            // The browser tool uses a cross-site top-level navigation without Origin.
            // This exception must serve only the canvas SPA, never expose API/control reads.
            const navigation = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
            const page = await h.transport("/canvas", { headers: navigation });
            expect(page.status).toBe(200);
            const csp = page.headers.get("content-security-policy")!;
            expect(csp).toContain("connect-src 'self' ws://127.0.0.1:4180");
            expect(csp).toContain("img-src 'self' data: blob:");
            expect(csp).toContain("media-src 'self' data: blob:");
            expect(csp).not.toContain("https:");
            const html = await page.text();
            expect(html).toContain('src="/src/main.tsx"');
            expect(html).toContain('<div id="root"></div>');
            expect(html).toContain("生成媒体云稿（重复不覆盖）");
            expect(html).not.toContain("/scripts/mount-persistence-gate.ts");
            const projectPage = await h.transport("/canvas/synthetic-navigation?source=contract", { headers: navigation });
            expect(projectPage.status).toBe(200);
            expect(await projectPage.text()).toContain('src="/src/main.tsx"');
            for (const path of ["/api/v1/site", `/api/v1/media/${mediaA}`, "/__first-save-test/scenario", "/account", "/logo.svg"]) {
                await apiError(await h.owned(A, path, { headers: navigation }), 403, "invalid_origin");
            }
            const rejectedNavigationHeaders: Record<string, string>[] = [
                { "sec-fetch-site": "cross-site", "sec-fetch-dest": "document" },
                { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
                { ...navigation, "sec-fetch-dest": "iframe" },
                { ...navigation, origin: "https://unrelated.invalid" },
                { ...navigation, origin },
            ];
            for (const headers of rejectedNavigationHeaders) {
                await apiError(await h.transport("/canvas", { headers }), 403, "invalid_origin");
            }
            await apiError(await h.transport("/canvas", { method: "POST", headers: navigation }), 403, "invalid_origin");
            const headNavigation = await h.transport("/canvas", { method: "HEAD", headers: navigation });
            expect(headNavigation.status).toBe(403);
            await headNavigation.arrayBuffer();

            await h.control(A, { mediaPaused: true });
            const manual = outcome(media.resolve([mediaA]));
            await h.pending(1);
            await h.control(A, { mediaPaused: false });
            expect(await manual).toMatchObject({ ok: true, value: { items: [{ id: mediaA }], missing: [] } });
            await h.pending(0);

            await h.control(A, { mediaPaused: true });
            const oldOwner = outcome(media.download(mediaA));
            await h.pending(1);
            await h.control(A, { account: "B" });
            expect(await oldOwner).toMatchObject({ ok: false, error: { status: 409 } });
            await h.pending(0);
            await h.control(B, { mediaPaused: false });
            expect((await h.control(B, { seedMedia: true })).mediaRecovery?.draftWrites).toBe(2);
            const otherMedia = createMediaClient(() => B, h.transport);
            expect(await otherMedia.resolve([mediaA])).toEqual({ items: [], missing: [mediaA] });
            await apiError(await h.owned(B, `/api/v1/media/${mediaA}`), 404, "not_found");
            await apiError(await h.owned(A, `/api/v1/media/${mediaA}`), 409, "account_changed");
            const otherDrafts = createDraftClient(() => ({ accountId: B, epoch: 1 }), h.transport);
            expect((await otherDrafts.list()).items.map((draft) => draft.id)).toEqual([draftB]);
            await expect(otherDrafts.get(draftA)).rejects.toMatchObject({ code: "not_found", status: 404 });

            await h.control(B, { mediaPaused: true });
            const featureChanged = outcome(otherMedia.resolve([mediaB]));
            await h.pending(1);
            await h.control(B, { cloudMedia: false });
            expect(await featureChanged).toMatchObject({ ok: false, error: { status: 409, code: "account_changed" } });
            await h.pending(0);
            await apiError(await h.owned(B, `/api/v1/media/${mediaB}`), 503, "cloud_unavailable");
            await h.control(B, { cloudMedia: true });

            const abort = new AbortController();
            const disconnected = outcome(h.owned(B, `/api/v1/media/${mediaB}`, { signal: abort.signal }));
            await h.pending(1);
            abort.abort();
            expect(await disconnected).toMatchObject({ ok: false });
            await h.pending(0);
            await h.control(B, { mediaPaused: false });
            expect((await otherMedia.download(mediaB)).size).toBe(232);
            const final = await h.state();
            expect(final.mediaRecovery?.draftWrites).toBe(2);
            expect(final.mediaRecovery?.pendingReads).toBe(0);
            expect(final.draftCount).toBe(1);
            expect(h.requests.filter((request) => request.path.startsWith("/api/v1/canvases") && ["POST", "PUT", "DELETE"].includes(request.method))).toEqual([]);
        } finally { revokeCloudMediaObjectUrls(urls); }
    });
    // Only this explicit pair of flags loads the gate into the ORIGINAL application shell.
    // HTTP verifies the executable module is served, not that a browser executed or committed IndexedDB.
    await withHarness(true, async () => {
        const h = httpHarness(), page = await h.transport("/canvas");
        expect(page.status).toBe(200);
        const html = await page.text();
        expect(html).toContain('src="/src/main.tsx"');
        expect(html).toContain('import("/scripts/mount-persistence-gate.ts")');
        const module = await h.transport("/scripts/mount-persistence-gate.ts");
        expect(module.status).toBe(200);
        expect(module.headers.get("content-type")).toContain("javascript");
        await module.text();
        expect((await h.state()).draftCount).toBe(0);
        expect((await h.state()).mediaRecovery?.draftWrites).toBe(0);
    }, true);
    // This validates actual site/session/media HTTP contracts. It does not trigger browser
    // visibility, claim a frontend epoch change, or replace the separate page acceptance.
    await withHarness(true, async () => {
        const h = httpHarness(), account = createAccountClient(h.transport);
        const media = createMediaClient(() => A, h.transport);
        const controlPath = "/__first-save-test/scenario";
        const initial = await h.state();
        expect(initial.accountRecheck).toEqual({ role: "user", downloadPaused: false, pendingDownloads: 0, siteRequests: 0, sessionRequests: 0 });
        expect(await account.site()).toMatchObject({ cloudCanvas: true, cloudMedia: true });
        expect(await account.session()).toMatchObject({ id: A, role: "user" });
        const checked = await h.state();
        expect(checked.accountRecheck).toMatchObject({ siteRequests: 1, sessionRequests: 1 });

        // Rejected controls cannot mutate the role/gates or count as account rechecks.
        for (const change of [{ role: "root" }, { downloadPaused: "true" }, { role: "admin", downloadPaused: true }]) {
            await apiError(await h.owned(A, controlPath, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(change) }), 400, "invalid_input");
        }
        const roleChange = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "admin" }) };
        await apiError(await h.transport(controlPath, roleChange), 409, "account_changed");
        await apiError(await h.owned(B, controlPath, roleChange), 409, "account_changed");
        await apiError(await h.owned(A, controlPath, { ...roleChange, headers: { ...roleChange.headers, origin: "https://unrelated.invalid" } }), 403, "invalid_origin");
        await apiError(await h.owned(A, controlPath, { ...roleChange, headers: { ...roleChange.headers, "sec-fetch-site": "cross-site" } }), 403, "invalid_origin");
        expect((await h.state()).accountRecheck).toEqual(checked.accountRecheck);

        await h.control(A, { seedMedia: true });
        const source = await createDraftClient(() => ({ accountId: A, epoch: 1 }), h.transport).get(draftA);
        const expectPngDownload = async (download: ReturnType<typeof outcome<Response>>) => {
            const result = await download;
            if (!result.ok) throw result.error;
            expect(result.value.status).toBe(200);
            expect(result.value.headers.get("content-type")).toBe("image/png");
            const bytes = Buffer.from(await result.value.arrayBuffer());
            expect(bytes.length).toBe(232);
            expect(createHash("sha256").update(bytes).digest("hex")).toBe(pngSha);
        };
        for (const change of [{ role: "admin" }, { cloudCanvas: false }]) {
            await h.control(A, { downloadPaused: true });
            // Resolving metadata remains available; this new gate pauses downloads only.
            expect(await media.resolve([mediaA])).toMatchObject({ items: [{ id: mediaA }], missing: [] });
            let settled = false;
            const download = outcome(h.owned(A, `/api/v1/media/${mediaA}`)).then((value) => { settled = true; return value; });
            const waiting = await h.pending(1, true);
            const changed = await h.control(A, change);
            expect(changed.account.id).toBe(A);
            expect(changed.accountRecheck?.pendingDownloads).toBe(1);
            expect(changed.accountRecheck?.siteRequests).toBe(waiting.accountRecheck?.siteRequests);
            expect(changed.accountRecheck?.sessionRequests).toBe(waiting.accountRecheck?.sessionRequests);
            const site = await account.site(), user = await account.session();
            expect(site.cloudCanvas).toBe(!("cloudCanvas" in change));
            expect(user).toMatchObject({ id: A, role: "admin" });
            const rechecked = await h.state();
            expect(rechecked.accountRecheck?.siteRequests).toBe(waiting.accountRecheck!.siteRequests + 1);
            expect(rechecked.accountRecheck?.sessionRequests).toBe(waiting.accountRecheck!.sessionRequests + 1);
            expect(rechecked.accountRecheck?.pendingDownloads).toBe(1);
            expect(settled).toBe(false);
            await h.control(A, { downloadPaused: false });
            await expectPngDownload(download);
            await h.pending(0, true);
        }
        // Changing the role keeps owner identity and cannot seed a different account's draft.
        await h.control(A, { scenario: "success" });
        expect((await h.control(A, { seedMedia: true })).mediaRecovery?.draftWrites).toBe(1);
        expect(await createDraftClient(() => ({ accountId: A, epoch: 1 }), h.transport).get(draftA)).toEqual(source);
        expect((await h.control(A, { role: "user" })).account).toMatchObject({ id: A, role: "user" });
        expect(await account.session()).toMatchObject({ id: A, role: "user" });

        for (const releaseFirst of ["mediaPaused", "downloadPaused"] as const) {
            await h.control(A, { mediaPaused: true });
            await h.control(A, { downloadPaused: true });
            let settled = false;
            const both = outcome(h.owned(A, `/api/v1/media/${mediaA}`)).then((value) => { settled = true; return value; });
            await h.pending(1, true);
            expect((await h.control(A, { [releaseFirst]: false })).accountRecheck?.pendingDownloads).toBe(1);
            expect(settled).toBe(false);
            await h.control(A, { [releaseFirst === "mediaPaused" ? "downloadPaused" : "mediaPaused"]: false });
            await expectPngDownload(both);
            await h.pending(0, true);
        }

        // The new gate does not weaken account/cloud-media scope validation.
        await h.control(A, { downloadPaused: true });
        const ownerChanged = outcome(h.owned(A, `/api/v1/media/${mediaA}`));
        await h.pending(1, true);
        await h.control(A, { account: "B" });
        const rejectedOwner = await ownerChanged;
        if (!rejectedOwner.ok) throw rejectedOwner.error;
        await apiError(rejectedOwner.value, 409, "account_changed");
        await h.pending(0, true);
        await apiError(await h.owned(A, `/api/v1/media/${mediaA}`), 409, "account_changed");
        await h.control(B, { seedMedia: true });
        const featureChanged = outcome(h.owned(B, `/api/v1/media/${mediaB}`));
        await h.pending(1, true);
        await h.control(B, { cloudMedia: false });
        const rejectedFeature = await featureChanged;
        if (!rejectedFeature.ok) throw rejectedFeature.error;
        await apiError(rejectedFeature.value, 409, "account_changed");
        await h.pending(0, true);
        const disabled = await h.state();
        await apiError(await h.owned(B, `/api/v1/media/${mediaB}`), 503, "cloud_unavailable");
        await apiError(await h.owned(B, "/api/v1/media/resolve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: [mediaB] }) }), 503, "cloud_unavailable");
        expect((await h.state()).mediaRecovery).toEqual(disabled.mediaRecovery);
        await h.control(B, { cloudMedia: true });

        const abort = new AbortController();
        const cancelled = outcome(h.owned(B, `/api/v1/media/${mediaB}`, { signal: abort.signal }));
        await h.pending(1, true);
        abort.abort();
        expect(await cancelled).toMatchObject({ ok: false });
        await h.pending(0, true);
        await h.control(B, { downloadPaused: false });
        const released = await h.control(B, { downloadPaused: false });
        expect(released.accountRecheck?.pendingDownloads).toBe(0);
        expect(released.mediaRecovery?.draftWrites).toBe(2);
        expect(released.mediaRecovery?.pendingReads).toBe(0);
        expect(h.requests.filter((request) => request.path.startsWith("/api/v1/canvases") && ["POST", "PUT", "DELETE"].includes(request.method))).toEqual([]);
        expect(released.accountRecheck?.siteRequests).toBe(h.requests.filter((request) => request.path === "/api/v1/site" && request.status === 200).length);
        expect(released.accountRecheck?.sessionRequests).toBe(h.requests.filter((request) => request.path === "/api/v1/session" && request.status === 200).length);
    }, false, true);
}, 120_000);
