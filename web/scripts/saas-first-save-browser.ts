/** Development-only browser harness. Never import this script from the application. */
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Plugin } from "vite";
import type { CanvasDraft } from "../../packages/shared/src/index";
import { accountPolicy } from "../../apps/api/src/policy";

const host = "127.0.0.1:4180", origin = `http://${host}`;
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mediaRecoveryMode = process.argv.slice(2).includes("--media-recovery");
const mountPersistenceMode = process.argv.slice(2).includes("--mount-persistence");
const accountRecheckMode = process.argv.slice(2).includes("--account-recheck");
const cloudSelectionMode = process.argv.slice(2).includes("--cloud-selection");
if (mountPersistenceMode && !mediaRecoveryMode) throw new Error("--mount-persistence requires --media-recovery; no server was started.");
if (accountRecheckMode && !mediaRecoveryMode) throw new Error("--account-recheck requires --media-recovery; no server was started.");
if (process.env.VITE_API_TARGET) throw new Error("The isolated harness refuses configured API proxy targets.");
// Resolve the API workspace's existing pinned validator without importing its service or reading configuration.
const { z } = createRequire(resolve(webDir, "../apps/api/package.json"))("zod");
const pageSchema = z.strictObject({
    limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive().refine(Number.isSafeInteger).max(accountPolicy.pageSize)).optional(),
    cursor: z.string().optional(),
});
const cursorSchema = z.strictObject({ createdAt: z.iso.datetime(), id: z.uuid() });
// Same shape as the account API; keep the isolated harness independent of service initialization.
const mediaResolveSchema = z.strictObject({ ids: z.array(z.uuid().transform((value: string) => value.toLowerCase())).min(1).max(100) });
const accounts = {
    A: { id: "synthetic-save-account", name: "隔离测试账号 A（模拟）", role: "user" },
    B: { id: "synthetic-save-account-b", name: "隔离测试账号 B（模拟）", role: "user" },
};
let account = accounts.A;
const drafts = new Map<string, CanvasDraft>();
const owners = new Map<string, string>(), lastSavedIds = new Map<string, string>();
let scenario: "success" | "committed-503" | "unwritten-503" = "success";
let listFailure = false;
let cloudCanvas = true;
let cloudMedia = mediaRecoveryMode, mediaScopeVersion = 0, mediaPaused = false;
let downloadPaused = false;
let mediaScenario: "normal" | "missing" | "wrong-type" = "normal";
const mediaWaiters = new Set<{ download: boolean; release: (force?: boolean) => void }>(), seededMediaOwners = new Set<string>();
const mediaCounts = { resolveRequests: 0, downloadRequests: 0, draftWrites: 0 };
const accountCounts = { siteRequests: 0, sessionRequests: 0 };
let selectionArmed = false, selectionScopeVersion = 0, selectionReads = 0;
let selectionWaiter: { id: string; release: () => void } | null = null;
const seededSelectionOwners = new Set<string>();
const mediaFixture = {
    A: { id: "68591890-0000-4000-9000-000000000001", draftId: "68591890-0000-4000-8000-000000000001" },
    B: { id: "68591890-0000-4000-9000-000000000002", draftId: "68591890-0000-4000-8000-000000000002" },
};
// Pin the synthetic fixture before enabling this mode. The default harness never reads the file.
const mediaPng = mediaRecoveryMode ? readFileSync(resolve(webDir, "scripts/fixtures/media-recovery.png")) : null;
const expectedMediaPng = { bytes: 232, width: 64, height: 48,
    sha256: "d0284c7222f68c1a8e70ff8016f9c9a1e61a230ef1f2a4b8d86c983546776061" };
if (mediaPng && (mediaPng.length !== expectedMediaPng.bytes ||
    createHash("sha256").update(mediaPng).digest("hex") !== expectedMediaPng.sha256)) {
    throw new Error("Synthetic media recovery fixture does not match its pinned bytes.");
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const csp = [
    "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "media-src 'self' data: blob:", "font-src 'self' data:",
    `connect-src 'self' ws://${host}`, "worker-src 'self' blob:", "frame-src 'none'",
    "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");

function json(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
}
function failure(response: ServerResponse, status: number, code: string) {
    json(response, status, { error: { code, message: "仅开发验收模拟响应" }, requestId: crypto.randomUUID() });
}
async function body(request: IncomingMessage): Promise<Record<string, unknown> | null> {
    if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json" || request.headers["content-encoding"]) return null;
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > accountPolicy.documentBytes) return null;
        chunks.push(buffer);
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    return record(value) ? value : null;
}

function releaseMediaReads(force = false) {
    for (const waiter of [...mediaWaiters]) waiter.release(force);
}
async function waitForMediaRead(response: ServerResponse, download: boolean) {
    const paused = () => mediaPaused || (download && downloadPaused);
    if (paused() && !response.destroyed) await new Promise<void>((resolveWait) => {
        const waiter = { download, release: (force = false) => {
            if (!force && paused()) return;
            mediaWaiters.delete(waiter); response.off("close", onClose); resolveWait();
        } };
        const onClose = () => waiter.release(true);
        mediaWaiters.add(waiter);
        response.once("close", onClose);
    });
    return !response.destroyed && !response.writableEnded;
}
function mediaMetadata(id: string) {
    return { id, kind: "image", contentType: "image/png", sizeBytes: expectedMediaPng.bytes,
        createdAt: "2026-10-22T00:00:00.000Z", url: `/api/v1/media/${id}` };
}
function seedMediaDraft() {
    const label = account === accounts.A ? "A" : "B", fixture = mediaFixture[label];
    if (drafts.has(fixture.draftId)) return seededMediaOwners.has(account.id) && owners.get(fixture.draftId) === account.id;
    const now = new Date().toISOString(), title = `模拟账号 ${label} · 媒体恢复验收`;
    drafts.set(fixture.draftId, {
        id: fixture.draftId, title, revision: 1, documentVersion: 1, createdAt: now, updatedAt: now,
        document: { id: `synthetic-media-recovery-${label}`, title, createdAt: now, updatedAt: now,
            nodes: [{ id: "synthetic-image", type: "image", title: "合成 PNG · 媒体恢复验收",
                position: { x: 40, y: 40 }, width: 320, height: 240,
                metadata: { cloudMediaId: fixture.id, content: "", status: "success", mimeType: "image/png", bytes: expectedMediaPng.bytes,
                    naturalWidth: expectedMediaPng.width, naturalHeight: expectedMediaPng.height } }],
            connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false,
            viewport: { x: 0, y: 0, k: 1 } },
    });
    owners.set(fixture.draftId, account.id);
    seededMediaOwners.add(account.id);
    mediaCounts.draftWrites++;
    return true;
}

function selectionFixtures() {
    const offset = account === accounts.A ? 0 : 2;
    return [3, 7].map((revision, index) => ({
        id: `eec58100-0000-4000-8000-00000000000${offset + index + 1}`,
        title: `模拟选版 ${index === 0 ? "A" : "B"} · 版本 ${revision}`, revision,
    }));
}
function seedSelectionDrafts() {
    if (seededSelectionOwners.has(account.id)) return true;
    const fixtures = selectionFixtures();
    if (fixtures.some(({ id }) => drafts.has(id))) return false;
    const now = new Date().toISOString();
    for (const fixture of fixtures) {
        drafts.set(fixture.id, { ...fixture, documentVersion: 1, createdAt: now, updatedAt: now,
            document: { id: `synthetic-selection-${fixture.id}`, title: fixture.title, createdAt: now, updatedAt: now,
                nodes: [{ id: "selection-text", type: "text", title: "合成选版内容", position: { x: 40, y: 40 }, width: 320, height: 180,
                    metadata: { content: fixture.title, status: "success" } }],
                connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } },
        });
        owners.set(fixture.id, account.id); mediaCounts.draftWrites++;
    }
    seededSelectionOwners.add(account.id);
    return true;
}
function releaseSelectionRead() {
    selectionArmed = false;
    selectionWaiter?.release();
}
async function waitForSelectionRead(response: ServerResponse, id: string) {
    if (selectionArmed && !response.destroyed) {
        selectionArmed = false;
        await new Promise<void>((resolveWait) => {
            const waiter = { id, release: () => {
                if (selectionWaiter === waiter) selectionWaiter = null;
                response.off("close", onClose); resolveWait();
            } };
            const onClose = () => waiter.release();
            selectionWaiter = waiter;
            response.once("close", onClose);
        });
    }
    return !response.destroyed && !response.writableEnded;
}

// Static, visible controls only. No application/store imports, automatic saves or credential handling.
const browserControls = `
const panel = document.createElement("details");
panel.id = "first-save-test-controls";
panel.setAttribute("data-canvas-shortcuts-ignore", "");
panel.setAttribute("aria-label", "文档保存隔离测试控制");
panel.style.cssText = "position:fixed;bottom:4px;left:4px;z-index:2147483647;max-width:calc(100vw - 8px);width:max-content;padding:3px 6px;border:1px solid #a16207;border-radius:4px;background:#fef3c7;color:#422006;font:11px/1.5 system-ui;box-sizing:border-box";
const title = document.createElement("summary");
title.textContent = "隔离测试：模拟账号/云端，非真实备份";
title.style.cssText = "cursor:pointer;font-weight:600";
title.title = "展开或收起模拟控制";
panel.append(title);
const note = document.createElement("div");
note.style.cssText = "max-width:410px;margin-top:6px";
note.textContent = "仅合成测试，不导入真实资料或供应商 Key。所有云稿只存内存，停止服务即丢失。保存场景用于POST/PUT；目录503只影响GET列表。另一窗口更新只改当前账号最近保存的内存稿。分页样例不写本机作品；切换模拟账号后必须刷新页面重新确认账户。";
panel.append(note);
const status = document.createElement("div");
status.style.cssText = "max-width:410px";
status.setAttribute("role", "status");
status.setAttribute("aria-live", "polite");
panel.append(status);
const controls = document.createElement("div");
controls.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;margin-top:4px";
panel.append(controls);
for (const event of ["pointerdown", "keydown", "keyup", "click"]) panel.addEventListener(event, (event) => event.stopPropagation());
const labels = { success: "正常保存", "committed-503": "保存后返回 503", "unwritten-503": "不写入返回 503" };
const buttons = [];
let controlAccountId = "";
async function update(change) {
    buttons.forEach((button) => button.disabled = true);
    try {
        const response = await fetch("/__first-save-test/scenario", {
            method: change ? "POST" : "GET", credentials: "omit", cache: "no-store", redirect: "error",
            ...(change ? { headers: { "content-type": "application/json", "x-canvas-account-id": controlAccountId }, body: JSON.stringify(change) } : {}),
        });
        if (!response.ok) throw new Error();
        const value = await response.json();
        controlAccountId = value.account.id;
        title.textContent = "隔离测试：模拟账号/云端，非真实备份 · " + value.accountLabel;
        status.textContent = "模拟账号：" + value.accountLabel + "；保存：" + labels[value.scenario] + "；目录读取：" + (value.listFailure ? "模拟503" : "正常") + "；本账号内存稿：" + value.draftCount + "；云开关：" + (value.cloudCanvas ? "开启" : "关闭") + "；最近保存版本：" + (value.lastRevision ?? "无") + "。这是上次检查的模拟状态；切换账号后请刷新页面，开关变化后重新检查账户或刷新。";
        if (value.mediaRecovery) {
            const media = value.mediaRecovery;
            status.textContent += " 媒体夹具：" + media.scenario + "；云媒体：" + (media.enabled ? "开启" : "关闭") +
                "；读取：" + (media.paused ? "手动暂停" : "正常") + "；等待数：" + media.pendingReads +
                "；有效解析/下载请求：" + media.resolveRequests + "/" + media.downloadRequests +
                "；内存云稿写入：" + media.draftWrites + "（含样例创建）。计数为本进程累计，需手动刷新。";
        }
        if (value.accountRecheck) {
            const recheck = value.accountRecheck;
            status.textContent += " 复查夹具：同账号角色 " + recheck.role + "；仅下载暂停：" + (recheck.downloadPaused ? "开启" : "关闭") +
                "；下载等待数：" + recheck.pendingDownloads + "；site/session 请求：" + recheck.siteRequests + "/" + recheck.sessionRequests + "。";
        }
        if (value.cloudSelection) {
            const selection = value.cloudSelection;
            status.textContent += " 选版夹具：" + (selection.armed ? "下一次单稿GET待暂停" : "未布置暂停") +
                "；等待稿ID：" + (selection.pendingId ?? "无") + "；合法单稿读取：" + selection.draftReads +
                "；内存云稿写入：" + selection.draftWrites + "。列表读取不暂停；请求仍受产品原有截止约束。";
        }
        if (change) panel.open = Boolean(change.account);
    } catch { status.textContent = "测试控制未确认，请手动重试；未自动保存或重发。"; }
    finally { buttons.forEach((button) => button.disabled = false); }
}
for (const [value, label] of Object.entries(labels)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.style.cssText = "padding:2px 7px;border:1px solid #a16207;border-radius:3px;background:#fff;color:#422006;font:inherit;cursor:pointer";
    button.addEventListener("click", () => void update({ scenario: value }));
    controls.append(button); buttons.push(button);
}
const close = document.createElement("button");
close.type = "button";
close.textContent = "关闭模拟云保存";
close.style.cssText = buttons[0].style.cssText;
close.addEventListener("click", () => void update({ cloudCanvas: false }));
controls.append(close); buttons.push(close);
const advance = document.createElement("button");
advance.type = "button";
advance.textContent = "模拟另一窗口更新";
advance.style.cssText = buttons[0].style.cssText;
advance.addEventListener("click", () => void update({ advanceLatest: true }));
controls.append(advance); buttons.push(advance);
for (const [label, change] of [
    ["切换模拟账号 A", { account: "A" }], ["切换模拟账号 B", { account: "B" }],
    ["生成分页测试目录（51条合成）", { seedDirectory: true }],
    ["仅目录读取返回503", { listFailure: true }], ["恢复目录正常读取", { listFailure: false }],
]) {
    const button = document.createElement("button");
    button.type = "button"; button.textContent = label; button.style.cssText = buttons[0].style.cssText;
    button.addEventListener("click", () => void update(change));
    controls.append(button); buttons.push(button);
}
if (${mediaRecoveryMode}) {
    note.textContent += " 媒体模式只读取合成 PNG，云端为内存模拟；浏览器仍使用原版画布和本机存储。按钮只切换模拟响应，不改产品存储、不模拟 IndexedDB 完成；不是实际云备份。";
    for (const [label, change] of [
        ["生成媒体云稿（重复不覆盖）", { seedMedia: true }],
        ["素材正常", { mediaScenario: "normal" }], ["素材缺失", { mediaScenario: "missing" }],
        ["素材返回错误类型", { mediaScenario: "wrong-type" }],
        ["暂停素材读取", { mediaPaused: true }], ["释放素材读取", { mediaPaused: false }],
        ["关闭模拟云媒体", { cloudMedia: false }], ["开启模拟云媒体", { cloudMedia: true }],
        ["刷新请求计数", null],
    ]) {
        const button = document.createElement("button");
        button.type = "button"; button.textContent = label; button.style.cssText = buttons[0].style.cssText;
        button.addEventListener("click", () => void update(change));
        controls.append(button); buttons.push(button);
    }
}
if (${accountRecheckMode}) {
    note.textContent += " 账号复查按钮派发合成可见性事件，不代表真实切换标签；角色与云保存开关变化不撤销同账号云媒体读取。";
    for (const [label, change] of [
        ["模拟同账号管理员角色", { role: "admin" }], ["模拟同账号普通用户角色", { role: "user" }],
        ["仅暂停素材下载", { downloadPaused: true }], ["释放素材下载", { downloadPaused: false }],
    ]) {
        const button = document.createElement("button");
        button.type = "button"; button.textContent = label; button.style.cssText = buttons[0].style.cssText;
        button.addEventListener("click", () => void update(change));
        controls.append(button); buttons.push(button);
    }
    const recheck = document.createElement("button");
    recheck.type = "button"; recheck.textContent = "触发可见性复查（合成事件）"; recheck.style.cssText = buttons[0].style.cssText;
    recheck.addEventListener("click", () => {
        if (document.visibilityState !== "visible") { status.textContent = "页面当前不可见，未派发复查事件。"; return; }
        document.dispatchEvent(new Event("visibilitychange"));
        status.textContent = "已派发合成可见性事件；请刷新请求计数并核对 site/session 响应，不代表真实切换标签。";
    });
    controls.append(recheck); buttons.push(recheck);
}
if (${cloudSelectionMode}) {
    note.textContent += " 选版模式仅生成同账号两份合成文本云稿（A版本3、B版本7），只暂停下一次合法单稿GET；目录GET不停。种子重复不覆盖，无自动保存。";
    for (const [label, change] of [
        ["生成选版 A/B 云稿（重复不覆盖）", { seedSelection: true }],
        ["暂停下一次单稿GET", { pauseNextDraft: true }],
        ["释放/取消单稿GET暂停", { releaseDraft: true }],
        ["刷新选版等待状态", null],
    ]) {
        const button = document.createElement("button");
        button.type = "button"; button.textContent = label; button.style.cssText = buttons[0].style.cssText;
        button.addEventListener("click", () => void update(change));
        controls.append(button); buttons.push(button);
    }
}
document.addEventListener("pointerdown", (event) => { if (!panel.contains(event.target)) panel.open = false; });
document.body.append(panel);
${mountPersistenceMode ? 'const { installMountPersistenceControls } = await import("/scripts/mount-persistence-gate.ts"); installMountPersistenceControls(panel);' : ""}
void update();
`;

const harness: Plugin = {
    name: "isolated-first-save-browser-test",
    enforce: "pre",
    configureServer(server) {
        server.middlewares.use((request, response, next) => {
            response.setHeader("content-security-policy", csp);
            response.setHeader("referrer-policy", "no-referrer");
            response.setHeader("x-content-type-options", "nosniff");
            const requestOrigin = request.headers.origin;
            let url: URL;
            try { url = new URL(request.url ?? "/", origin); }
            catch { failure(response, 400, "invalid_input"); return; }
            // Browser-extension top-level navigation may be cross-site. Only serve the canvas shell;
            // data routes, embedded documents, explicit foreign origins and writes keep the same guard.
            const canvasNavigation = requestOrigin === undefined && request.method === "GET" &&
                request.headers["sec-fetch-mode"] === "navigate" && request.headers["sec-fetch-dest"] === "document" &&
                /^\/canvas(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname);
            if (request.headers.host !== host || url.origin !== origin || (requestOrigin !== undefined && requestOrigin !== origin) ||
                (request.headers["sec-fetch-site"] === "cross-site" && !canvasNavigation) ||
                (request.method !== "GET" && request.method !== "HEAD" && requestOrigin !== origin)) {
                failure(response, 403, "invalid_origin"); return;
            }
            void (async () => {
                const path = url.pathname;
                if (path === "/__first-save-test/scenario") {
                    if (request.method === "POST") {
                        if (request.headers["x-canvas-account-id"] !== account.id) { failure(response, 409, "account_changed"); return; }
                        const change = await body(request);
                        if (!change || Object.keys(change).length !== 1 ||
                            !(change.cloudCanvas === false || change.advanceLatest === true || change.seedDirectory === true ||
                                typeof change.listFailure === "boolean" || change.account === "A" || change.account === "B" ||
                                (typeof change.scenario === "string" && ["success", "committed-503", "unwritten-503"].includes(change.scenario)) ||
                                (accountRecheckMode && (change.role === "user" || change.role === "admin" || typeof change.downloadPaused === "boolean")) ||
                                (cloudSelectionMode && (change.seedSelection === true || change.pauseNextDraft === true || change.releaseDraft === true)) ||
                                (mediaRecoveryMode && (change.seedMedia === true || typeof change.mediaPaused === "boolean" ||
                                    typeof change.cloudMedia === "boolean" || (typeof change.mediaScenario === "string" && ["normal", "missing", "wrong-type"].includes(change.mediaScenario)))))) {
                            failure(response, 400, "invalid_input"); return;
                        }
                        if (request.headers["x-canvas-account-id"] !== account.id) { failure(response, 409, "account_changed"); return; }
                        if (change.cloudCanvas === false) {
                            cloudCanvas = false;
                            if (cloudSelectionMode) { selectionScopeVersion++; releaseSelectionRead(); }
                        }
                        else if (change.account === "A" || change.account === "B") {
                            account = accounts[change.account]; mediaScopeVersion++; releaseMediaReads(true);
                            if (cloudSelectionMode) { selectionScopeVersion++; releaseSelectionRead(); }
                        }
                        else if (cloudSelectionMode && change.seedSelection === true) {
                            if (!cloudCanvas) { failure(response, 503, "cloud_unavailable"); return; }
                            if (!seedSelectionDrafts()) { failure(response, 409, "creation_exists"); return; }
                        }
                        else if (cloudSelectionMode && change.pauseNextDraft === true) {
                            if (!cloudCanvas) { failure(response, 503, "cloud_unavailable"); return; }
                            if (selectionArmed || selectionWaiter) { failure(response, 409, "selection_busy"); return; }
                            selectionArmed = true;
                        }
                        else if (cloudSelectionMode && change.releaseDraft === true) releaseSelectionRead();
                        else if (mediaRecoveryMode && typeof change.cloudMedia === "boolean") {
                            cloudMedia = change.cloudMedia; mediaScopeVersion++; releaseMediaReads(true);
                        }
                        else if (accountRecheckMode && (change.role === "user" || change.role === "admin")) {
                            // Keep A/B object identity and ownership; role does not gate same-account media reads.
                            account.role = change.role;
                        }
                        else if (accountRecheckMode && typeof change.downloadPaused === "boolean") {
                            downloadPaused = change.downloadPaused;
                            if (!downloadPaused) releaseMediaReads();
                        }
                        else if (mediaRecoveryMode && typeof change.mediaPaused === "boolean") {
                            mediaPaused = change.mediaPaused;
                            if (!mediaPaused) releaseMediaReads();
                        }
                        else if (mediaRecoveryMode && typeof change.mediaScenario === "string") {
                            mediaScenario = change.mediaScenario as typeof mediaScenario;
                        }
                        else if (mediaRecoveryMode && change.seedMedia === true) {
                            if (!cloudCanvas || !cloudMedia) { failure(response, 503, "cloud_unavailable"); return; }
                            if (!seedMediaDraft()) { failure(response, 409, "creation_exists"); return; }
                        }
                        else if (typeof change.listFailure === "boolean") listFailure = change.listFailure;
                        else if (change.seedDirectory === true) {
                            const now = new Date().toISOString();
                            // One explicit fixture action seeds pageSize + 1 items; no timer, product quota, local write or last-saved binding.
                            for (let index = 1; index <= accountPolicy.pageSize + 1; index++) {
                                const id = crypto.randomUUID(), title = `模拟账号 ${account === accounts.A ? "A" : "B"} · 目录样例 ${index}`;
                                drafts.set(id, {
                                    id, title, documentVersion: 1, revision: 1, createdAt: now, updatedAt: now,
                                    document: { id: `synthetic-directory-${id}`, title, createdAt: now, updatedAt: now, nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } },
                                });
                                owners.set(id, account.id);
                                mediaCounts.draftWrites++;
                            }
                        }
                        else if (change.advanceLatest === true) {
                            const lastSavedId = lastSavedIds.get(account.id);
                            const draft = lastSavedId ? drafts.get(lastSavedId) : undefined;
                            if (!draft) { failure(response, 404, "not_found"); return; }
                            const revision = draft.revision + 1;
                            const title = `模拟另一窗口更新 · 版本 ${revision}`;
                            drafts.set(draft.id, { ...draft, title, document: { ...draft.document, title }, revision, updatedAt: new Date().toISOString() });
                            mediaCounts.draftWrites++;
                        }
                        else { scenario = change.scenario as typeof scenario; cloudCanvas = true; }
                    } else if (request.method !== "GET") { failure(response, 404, "not_found"); return; }
                    const lastSavedId = lastSavedIds.get(account.id);
                    json(response, 200, { scenario, cloudCanvas, listFailure, account, accountLabel: account === accounts.A ? "A" : "B",
                        draftCount: [...owners.values()].filter((id) => id === account.id).length,
                        lastRevision: lastSavedId ? drafts.get(lastSavedId)?.revision ?? null : null,
                        ...(cloudSelectionMode ? { cloudSelection: { armed: selectionArmed, pendingId: selectionWaiter?.id ?? null,
                            draftReads: selectionReads, draftWrites: mediaCounts.draftWrites, fixtures: selectionFixtures() } } : {}),
                        ...(accountRecheckMode ? { accountRecheck: { role: account.role, downloadPaused,
                            pendingDownloads: [...mediaWaiters].filter((waiter) => waiter.download).length, ...accountCounts } } : {}),
                        ...(mediaRecoveryMode ? { mediaRecovery: { enabled: cloudMedia, scenario: mediaScenario,
                            paused: mediaPaused, pendingReads: mediaWaiters.size, ...mediaCounts } } : {}) }); return;
                }
                if (path.startsWith("/__first-save-test")) { failure(response, 404, "not_found"); return; }
                if (path === "/api/v1/site" && request.method === "GET") {
                    if (accountRecheckMode) accountCounts.siteRequests++;
                    json(response, 200, {
                        schemaVersion: 1,
                        brand: { name: "无限画布 · 隔离测试", tagline: "仅合成数据，无真实云备份", logoPath: null },
                        theme: {
                            light: { accent: "#171717", background: "#fafaf9", surface: "#ffffff", text: "#171717" },
                            dark: { accent: "#fafafa", background: "#171717", surface: "#1c1917", text: "#fafafa" },
                        },
                        features: { registration: false, cloudCanvas, cloudMedia, recharge: false, generation: { text: false, image: false, video: false, audio: false } },
                        authentication: { method: "email-password", captcha: { provider: "turnstile", siteKey: "synthetic-public-key-not-for-verification", action: "account" } },
                    }); return;
                }
                if (path === "/api/v1/session" && request.method === "GET") {
                    if (accountRecheckMode) accountCounts.sessionRequests++;
                    json(response, 200, { user: account }); return;
                }
                if (mediaRecoveryMode && (path === "/api/v1/media" || path.startsWith("/api/v1/media/"))) {
                    const resolving = path === "/api/v1/media/resolve" && request.method === "POST";
                    const mediaId = path.slice("/api/v1/media/".length).toLowerCase();
                    if (!resolving && !(request.method === "GET" && uuid.test(mediaId))) { failure(response, 404, "not_found"); return; }
                    if (url.search) { failure(response, 400, "invalid_input"); return; }
                    if (!request.headers["x-canvas-account-id"]) { failure(response, 400, "account_context_required"); return; }
                    if (request.headers["x-canvas-account-id"] !== account.id) { failure(response, 409, "account_changed"); return; }
                    if (!cloudMedia) { failure(response, 503, "cloud_unavailable"); return; }
                    const startedAccount = account.id, startedScope = mediaScopeVersion;
                    let ids: string[] = [mediaId];
                    if (resolving) {
                        const parsed = mediaResolveSchema.safeParse(await body(request));
                        if (!parsed.success) { failure(response, 400, "invalid_input"); return; }
                        ids = [...new Set(parsed.data.ids)] as string[];
                    }
                    const currentScope = () => {
                        if (startedAccount !== account.id || startedScope !== mediaScopeVersion) { failure(response, 409, "account_changed"); return false; }
                        if (!cloudMedia) { failure(response, 503, "cloud_unavailable"); return false; }
                        return true;
                    };
                    if (!currentScope()) return;
                    if (resolving) mediaCounts.resolveRequests++; else mediaCounts.downloadRequests++;
                    if (!await waitForMediaRead(response, !resolving) || !currentScope()) return;
                    const ownedId = mediaFixture[startedAccount === accounts.A.id ? "A" : "B"].id;
                    const visible = (id: string) => id === ownedId && seededMediaOwners.has(startedAccount) && mediaScenario !== "missing";
                    if (resolving) {
                        json(response, 200, { items: ids.filter(visible).map(mediaMetadata), missing: ids.filter((id) => !visible(id)) }); return;
                    }
                    if (!visible(mediaId)) { failure(response, 404, "not_found"); return; }
                    response.writeHead(200, { "content-type": mediaScenario === "wrong-type" ? "text/plain" : "image/png",
                        "content-length": mediaPng!.length, "cache-control": "no-store" });
                    response.end(mediaPng); return;
                }
                const draftId = path.startsWith("/api/v1/canvases/") ? path.slice("/api/v1/canvases/".length) : null;
                if ((path === "/api/v1/canvases" && ["GET", "POST"].includes(request.method ?? "")) || (draftId && ["GET", "PUT"].includes(request.method ?? ""))) {
                    if (!request.headers["x-canvas-account-id"]) { failure(response, 400, "account_context_required"); return; }
                    if (request.headers["x-canvas-account-id"] !== account.id) { failure(response, 409, "account_changed"); return; }
                    if (path === "/api/v1/canvases" && request.method === "GET") {
                        const query: Record<string, string> = Object.create(null);
                        for (const [key, value] of url.searchParams) {
                            if (Object.hasOwn(query, key)) { failure(response, 400, "invalid_input"); return; }
                            query[key] = value;
                        }
                        const parsed = pageSchema.safeParse(query);
                        if (!parsed.success) { failure(response, 400, "invalid_input"); return; }
                        let before: { createdAt: string; id: string } | undefined;
                        if (parsed.data.cursor) {
                            try { before = cursorSchema.parse(JSON.parse(Buffer.from(parsed.data.cursor, "base64url").toString("utf8"))); }
                            catch { failure(response, 400, "invalid_cursor"); return; }
                        }
                        if (listFailure) { failure(response, 503, "service_unavailable"); return; }
                        const limit = parsed.data.limit ?? accountPolicy.pageSize;
                        // In-memory dates are milliseconds; cursors retain the API's six-digit UTC shape.
                        const micros = (value: string) => BigInt(Date.parse(value)) * 1000n + BigInt((/\.(\d+)Z$/.exec(value)?.[1] ?? "").padEnd(6, "0").slice(3, 6));
                        const cursorTime = before ? micros(before.createdAt) : null;
                        const rows = [...drafts.values()].filter((draft) => owners.get(draft.id) === account.id &&
                            (!before || micros(draft.createdAt) < cursorTime! ||
                                (micros(draft.createdAt) === cursorTime && draft.id < before.id.toLowerCase())))
                            .sort((a, b) => a.createdAt === b.createdAt ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.createdAt < b.createdAt ? 1 : -1)
                            .slice(0, limit + 1);
                        const items = rows.slice(0, limit).map(({ id, title, revision, createdAt, updatedAt }) => ({ id, title, revision, createdAt, updatedAt }));
                        const last = items.at(-1);
                        const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({
                            createdAt: last.createdAt.replace(/\.(\d{3})Z$/, ".$1000Z"), id: last.id,
                        })).toString("base64url") : null;
                        json(response, 200, { items, nextCursor }); return;
                    }
                    if (draftId && !uuid.test(draftId)) { failure(response, 404, "not_found"); return; }
                    if (draftId && request.method === "GET") {
                        const id = draftId.toLowerCase(), draft = owners.get(id) === account.id ? drafts.get(id) : undefined;
                        if (cloudSelectionMode && draft) {
                            if (!cloudCanvas) { failure(response, 503, "cloud_unavailable"); return; }
                            const startedAccount = account.id, startedScope = selectionScopeVersion;
                            selectionReads++;
                            if (!await waitForSelectionRead(response, id)) return;
                            if (account.id !== startedAccount || selectionScopeVersion !== startedScope) { failure(response, 409, "account_changed"); return; }
                        }
                        if (draft) json(response, 200, { draft }); else failure(response, 404, "not_found");
                        return;
                    }
                    if (!cloudCanvas) { failure(response, 503, "service_unavailable"); return; }
                    const mode = scenario;
                    const updating = request.method === "PUT";
                    const input = await body(request);
                    const allowed = [updating ? "expectedRevision" : "creationId", "title", "documentVersion", "document"];
                    if (!input || Object.keys(input).some((key) => !allowed.includes(key)) || typeof input.title !== "string" ||
                        !input.title.trim() || [...input.title.trim()].length > accountPolicy.titleLength || input.documentVersion !== 1 || !record(input.document)) {
                        failure(response, 400, "invalid_input"); return;
                    }
                    if (updating ? typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
                        : typeof input.creationId !== "string" || !uuid.test(input.creationId)) {
                        failure(response, 400, "invalid_input"); return;
                    }
                    if (!cloudCanvas) { failure(response, 503, "service_unavailable"); return; }
                    if (request.headers["x-canvas-account-id"] !== account.id) { failure(response, 409, "account_changed"); return; }
                    const id = updating ? draftId!.toLowerCase() : (input.creationId as string).toLowerCase();
                    // Read after body parsing; comparison and Map write below are synchronous CAS in this single-process fixture.
                    const current = drafts.get(id);
                    if (current && owners.get(id) !== account.id) { failure(response, 404, "not_found"); return; }
                    if (updating) {
                        if (!current) { failure(response, 404, "not_found"); return; }
                        if (current.revision !== input.expectedRevision) {
                            json(response, 409, { error: { code: "revision_conflict", message: "画布已有新版本，请保留本地修改后处理冲突" }, currentRevision: current.revision, requestId: crypto.randomUUID() }); return;
                        }
                    } else if (current) { failure(response, 409, "creation_exists"); return; }
                    if (mode === "unwritten-503") { failure(response, 503, "service_unavailable"); return; }
                    const now = new Date().toISOString();
                    const draft: CanvasDraft = {
                        id, title: input.title.trim(), documentVersion: 1, document: input.document as CanvasDraft["document"],
                        revision: current ? current.revision + 1 : 1, createdAt: current?.createdAt ?? now, updatedAt: now,
                    };
                    drafts.set(id, draft);
                    mediaCounts.draftWrites++;
                    owners.set(id, account.id);
                    lastSavedIds.set(account.id, id);
                    if (mode === "committed-503") failure(response, 503, "service_unavailable");
                    else json(response, updating ? 200 : 201, { draft, requestId: crypto.randomUUID() });
                    return;
                }
                if (path === "/api" || path.startsWith("/api/") || !["GET", "HEAD"].includes(request.method ?? "")) {
                    failure(response, 404, "not_found"); return;
                }
                next();
            })().catch(() => { if (!response.headersSent) failure(response, 400, "invalid_input"); else response.end(); });
        });
    },
    transformIndexHtml() { return [{ tag: "script", attrs: { type: "module" }, children: browserControls, injectTo: "body" }]; },
};

const server = await createServer({
    root: webDir, configFile: resolve(webDir, "vite.config.ts"), base: "/", envDir: false, envFile: false,
    envPrefix: "FIRST_SAVE_BROWSER_UNUSED_", plugins: [harness], logLevel: "error", clearScreen: false,
    server: {
        host: "127.0.0.1", port: 4180, strictPort: true, open: false, cors: false,
        allowedHosts: ["127.0.0.1"], proxy: {},
        fs: { strict: true, allow: [webDir, resolve(webDir, "../packages/shared")] },
    },
});
if (Object.keys(server.config.server.proxy ?? {}).length) {
    await server.close();
    throw new Error("The isolated harness refuses resolved proxy routes.");
}
await server.listen();
console.log(`仅开发隔离验收：${origin}/canvas；账号/云稿均模拟，停止服务即丢失内存云稿。${mediaRecoveryMode ? "已显式开启合成 PNG 媒体恢复模式，非真实云备份。" : ""}${accountRecheckMode ? "已显式开启账号复查夹具；可见性按钮使用合成事件，不代表真实切标签。" : ""}${cloudSelectionMode ? "已显式开启单稿GET选版暂停夹具；仅手动种子和释放，不自动保存。" : ""}`);
process.once("SIGINT", () => void server.close());
process.once("SIGTERM", () => void server.close());
