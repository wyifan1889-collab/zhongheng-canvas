/** Development-only original-canvas harness. No database, provider, credential or production proxy. */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Plugin } from "vite";
import { accountPolicy } from "../../apps/api/src/policy";
import { parseGenerationIdempotencyKey, parseGenerationIntent, parseGenerationSubmission, type GenerationIntent } from "../../apps/api/src/generation-contract";
import { parseGenerationImageRequest } from "../../apps/api/src/generation-image-request";

const host = "127.0.0.1:4180", origin = `http://${host}`;
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.env.VITE_API_TARGET) throw new Error("The isolated generation harness refuses configured API proxy targets.");
const png = readFileSync(resolve(webDir, "scripts/fixtures/media-recovery.png"));
const pngSha = "d0284c7222f68c1a8e70ff8016f9c9a1e61a230ef1f2a4b8d86c983546776061";
if (png.length !== 232 || createHash("sha256").update(png).digest("hex") !== pngSha) throw new Error("Synthetic PNG fixture does not match its pinned bytes.");
const account = { id: "synthetic-generation-account", name: "图片生成隔离账号（模拟）", role: "user" };
const model = { id: "synthetic-image", displayName: "合成单图模型 · 7 测试积分", capability: "image", group: null };
type Scenario = "success" | "price_changed" | "insufficient_balance" | "committed-503" | "provider-rejected" | "provider-unknown";
let scenario: Scenario = "success";
const counts = { submitPosts: 0, acceptedTasks: 0, quotePosts: 0, taskReads: 0, byKeyReads: 0, mediaResolves: 0, mediaDownloads: 0, walletReads: 0 };
type Task = { id: string; mediaId: string; intent: GenerationIntent; key: string; scenario: Scenario; completed: boolean; createdAt: string };
const tasks = new Map<string, Task>(), taskKeys = new Map<string, string>();
const credits = 7, walletCreatedAt = new Date().toISOString();
const wallet = { unit: "credit", availableUnits: credits, reservedUnits: 0, totalUnits: credits, version: 1, createdAt: walletCreatedAt, updatedAt: walletCreatedAt };
function changeWallet(available: number, reserved: number) {
    wallet.availableUnits += available; wallet.reservedUnits += reserved;
    wallet.totalUnits = wallet.availableUnits + wallet.reservedUnits;
    wallet.version++; wallet.updatedAt = new Date().toISOString();
}
const csp = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:", "media-src 'self' data: blob:", "font-src 'self' data:",
    `connect-src 'self' ws://${host}`, "worker-src 'self' blob:", "frame-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"].join("; ");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function json(response: ServerResponse, status: number, value: unknown) {
    response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(value));
}
function failure(response: ServerResponse, status: number, code: string) {
    json(response, status, { error: { code, message: "仅开发验收模拟响应" }, requestId: crypto.randomUUID() });
}
async function body(request: IncomingMessage): Promise<unknown> {
    if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json" || request.headers["content-encoding"]) throw new Error("invalid body");
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > accountPolicy.documentBytes) throw new Error("invalid body");
        chunks.push(buffer);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}
function supported(intent: GenerationIntent) {
    return intent.modelId === model.id && !!intent.projectId && !("errorCode" in parseGenerationImageRequest(intent.inputSnapshot, intent.parameterSnapshot));
}
function metadata(task: Task) {
    return { id: task.mediaId, kind: "image", contentType: "image/png", sizeBytes: png.length, createdAt: task.createdAt, url: `/api/v1/media/${task.mediaId}` };
}
function hasMedia(task: Task) { return task.completed && task.scenario !== "provider-rejected" && task.scenario !== "provider-unknown"; }
function view(task: Task) {
    const rejected = task.scenario === "provider-rejected", unknown = task.scenario === "provider-unknown";
    return {
        task: { id: task.id, projectId: task.intent.projectId, spaceId: task.intent.spaceId ?? null, nodeId: task.intent.nodeId ?? null,
            modelId: model.id, priceVersion: 1, quotedUnits: credits, billingUnitSnapshot: "request", creditsPerUnitSnapshot: credits,
            executionStatus: task.completed ? rejected ? "failed" : unknown ? "unknown" : "succeeded" : "queued",
            deliveryStatus: task.completed ? rejected ? "failed" : unknown ? "unknown" : "visible" : "pending",
            billingStatus: task.completed ? rejected ? "released" : unknown ? "pending_review" : "captured" : "reserved", createdAt: task.createdAt, updatedAt: task.createdAt },
        result: task.completed ? { id: task.id, taskId: task.id, status: rejected ? "failed" : unknown ? "unknown" : "succeeded", consumedUnits: hasMedia(task) ? 1 : null,
            resultSnapshot: hasMedia(task) ? { kind: "image", media: { mediaId: task.mediaId, kind: "image", contentType: "image/png", sizeBytes: png.length, etag: pngSha } } : {} } : null,
    };
}
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
}

const controls = `
const panel = document.createElement("details"); panel.id = "generation-test-controls";
panel.setAttribute("data-canvas-shortcuts-ignore", "");
panel.style.cssText = "position:fixed;bottom:4px;left:4px;z-index:2147483647;padding:4px 8px;max-width:420px;background:#fef3c7;color:#422006;border:1px solid #a16207;font:12px/1.5 system-ui";
const title = document.createElement("summary"); title.textContent = "图片生成隔离测试（模拟账号/API，非真实付费）"; panel.append(title);
const note = document.createElement("p"); note.textContent = "初始7测试积分，每次冻结7积分，均为本机合成值，不改真实余额。价格变化与余额不足均模拟未受理拒绝，不创建任务或改变钱包；切回正常后仍须人工重新报价、确认。首次GET固定为创建时场景，切换按钮不改变旧任务。供应商拒绝退回积分；未知任务重复查询仍待核对。无供应商、队列或OSS；关闭服务会丢失内存任务和模拟钱包。"; panel.append(note);
const status = document.createElement("pre"); status.id = "generation-test-state"; panel.append(status);
const buttons = []; let busy = false;
async function update(change) {
  if (busy) return; busy = true; buttons.forEach(b => b.disabled = true);
  try { const r = await fetch("/__generation-test/state", { method: change ? "POST" : "GET", cache:"no-store", credentials:"same-origin",
    ...(change ? { headers:{"content-type":"application/json", "x-canvas-account-id":"synthetic-generation-account"}, body:JSON.stringify(change) } : {}) });
    if (!r.ok) throw Error(); const value = await r.json(); status.textContent = JSON.stringify(value, null, 2);
  } catch { status.textContent = "控制状态读取失败；请保留页面，勿重复提交。"; }
  finally { busy = false; buttons.forEach(b => b.disabled = false); }
}
for (const [label, change] of [["正常生成", {scenario:"success"}], ["模拟价格变化", {scenario:"price_changed"}], ["模拟余额不足（未受理）", {scenario:"insufficient_balance"}], ["已接受但返回503", {scenario:"committed-503"}], ["模拟供应商拒绝（积分退回）", {scenario:"provider-rejected"}], ["模拟供应商结果未知（待核对）", {scenario:"provider-unknown"}], ["刷新请求计数", null]]) {
  const b = document.createElement("button"); b.type="button"; b.textContent=label; b.style.cssText="margin:3px;padding:3px 6px;border:1px solid currentColor";
  b.onclick=()=>void update(change); panel.append(b); buttons.push(b);
}
document.body.append(panel); void update();
`;

const harness: Plugin = {
    name: "isolated-generation-browser-test", enforce: "pre",
    configureServer(server) {
        server.middlewares.use((request, response, next) => {
            response.setHeader("content-security-policy", csp);
            response.setHeader("referrer-policy", "no-referrer");
            response.setHeader("x-content-type-options", "nosniff");
            let url: URL;
            try { url = new URL(request.url ?? "/", origin); } catch { failure(response, 400, "invalid_input"); return; }
            const requestOrigin = request.headers.origin;
            const canvasNavigation = requestOrigin === undefined && request.method === "GET" && request.headers["sec-fetch-mode"] === "navigate" &&
                request.headers["sec-fetch-dest"] === "document" && /^\/canvas(?:\/[A-Za-z0-9_-]+)?$/.test(url.pathname);
            if (request.headers.host !== host || url.origin !== origin || (requestOrigin !== undefined && requestOrigin !== origin) ||
                (request.headers["sec-fetch-site"] === "cross-site" && !canvasNavigation) ||
                (request.method !== "GET" && request.method !== "HEAD" && requestOrigin !== origin)) { failure(response, 403, "invalid_origin"); return; }
            void (async () => {
                const path = url.pathname;
                if (path === "/__generation-test/state") {
                    if (request.method === "POST") {
                        if (request.headers["x-canvas-account-id"] !== account.id) { failure(response, 409, "account_changed"); return; }
                        const change = await body(request);
                        if (!record(change) || Object.keys(change).length !== 1 || !["success", "price_changed", "insufficient_balance", "committed-503", "provider-rejected", "provider-unknown"].includes(change.scenario as string)) { failure(response, 400, "invalid_input"); return; }
                        scenario = change.scenario as Scenario;
                    } else if (request.method !== "GET") { failure(response, 405, "method_not_allowed"); return; }
                    json(response, 200, { synthetic: true, scenario, ...counts, wallet }); return;
                }
                if (path === "/api/v1/site" && request.method === "GET") {
                    json(response, 200, { schemaVersion: 1,
                        brand: { name: "无限画布 · 图片生成隔离验收", tagline: "仅合成数据，无真实付费", logoPath: null },
                        theme: { light: { accent: "#171717", background: "#fafaf9", surface: "#ffffff", text: "#171717" }, dark: { accent: "#fafafa", background: "#171717", surface: "#1c1917", text: "#fafafa" } },
                        features: { registration: false, cloudCanvas: false, cloudMedia: true, recharge: false, generation: { text: false, image: true, video: false, audio: false } },
                        authentication: { method: "email-password", captcha: { provider: "turnstile", siteKey: "synthetic-not-for-verification", action: "account" } } }); return;
                }
                if (path === "/api/v1/session" && request.method === "GET") { json(response, 200, { user: account }); return; }
                if (path === "/api/v1/wallet" || path.startsWith("/api/v1/generation/") || path.startsWith("/api/v1/media/")) {
                    if (!request.headers["x-canvas-account-id"]) { failure(response, 400, "account_context_required"); return; }
                    if (request.headers["x-canvas-account-id"] !== account.id) { failure(response, 409, "account_changed"); return; }
                    if (url.search) { failure(response, 400, "invalid_input"); return; }
                    if (path === "/api/v1/wallet" && request.method === "GET") { counts.walletReads++; json(response, 200, { wallet: { ...wallet,
                        availableUnits: String(wallet.availableUnits), reservedUnits: String(wallet.reservedUnits), totalUnits: String(wallet.totalUnits) } }); return; }
                    if (path === "/api/v1/generation/models" && request.method === "GET") { json(response, 200, { items: [model], requestId: crypto.randomUUID() }); return; }
                    if (path === "/api/v1/generation/quote" && request.method === "POST") {
                        counts.quotePosts++;
                        const intent = parseGenerationIntent(await body(request));
                        if (!supported(intent)) { failure(response, 400, "unsupported_generation"); return; }
                        json(response, 200, { quote: { modelId: model.id, priceVersion: 1, quotedUnits: credits, billingUnit: "request", creditsPerUnit: credits }, requestId: crypto.randomUUID() }); return;
                    }
                    if (path === "/api/v1/generation/tasks" && request.method === "POST") {
                        counts.submitPosts++;
                        const { confirmedPriceVersion, ...intent } = parseGenerationSubmission(await body(request));
                        const key = parseGenerationIdempotencyKey(typeof request.headers["idempotency-key"] === "string" ? request.headers["idempotency-key"] : null);
                        if (!supported(intent)) { failure(response, 400, "unsupported_generation"); return; }
                        const existing = tasks.get(taskKeys.get(key) ?? "");
                        if (existing) {
                            if (confirmedPriceVersion !== 1 || canonical(existing.intent) !== canonical(intent)) { failure(response, 409, "idempotency_conflict"); return; }
                            json(response, 200, { ...view(existing), created: false, requestId: crypto.randomUUID() }); return;
                        }
                        if (scenario === "price_changed" || confirmedPriceVersion !== 1) { failure(response, 409, "price_changed"); return; }
                        if (scenario === "insufficient_balance" || wallet.availableUnits < credits) { failure(response, 402, "insufficient_balance"); return; }
                        const task: Task = { id: crypto.randomUUID(), mediaId: crypto.randomUUID(), key, intent, scenario, completed: false, createdAt: new Date().toISOString() };
                        changeWallet(-credits, credits);
                        tasks.set(task.id, task); taskKeys.set(key, task.id); counts.acceptedTasks++;
                        if (task.scenario === "committed-503") { failure(response, 503, "service_unavailable"); return; }
                        json(response, 201, { ...view(task), created: true, requestId: crypto.randomUUID() }); return;
                    }
                    if (path.startsWith("/api/v1/generation/tasks/") && request.method === "GET") {
                        const byKey = path.startsWith("/api/v1/generation/tasks/by-key/");
                        let id: string;
                        if (byKey) { counts.byKeyReads++; id = taskKeys.get(parseGenerationIdempotencyKey(decodeURIComponent(path.slice("/api/v1/generation/tasks/by-key/".length)))) ?? ""; }
                        else { counts.taskReads++; id = path.slice("/api/v1/generation/tasks/".length); }
                        const task = tasks.get(id);
                        if (!task) { failure(response, 404, "not_found"); return; }
                        if (!task.completed) {
                            task.completed = true;
                            if (task.scenario === "provider-rejected") changeWallet(credits, -credits);
                            else if (task.scenario !== "provider-unknown") changeWallet(0, -credits);
                        }
                        json(response, 200, { ...view(task), requestId: crypto.randomUUID() }); return;
                    }
                    if (path === "/api/v1/media/resolve" && request.method === "POST") {
                        counts.mediaResolves++;
                        const input = await body(request);
                        if (!record(input) || Object.keys(input).length !== 1 || !Array.isArray(input.ids) || input.ids.length < 1 || input.ids.length > 100 || input.ids.some((id) => typeof id !== "string" || !uuid.test(id))) { failure(response, 400, "invalid_input"); return; }
                        const ids = input.ids;
                        const owned = [...tasks.values()].filter((task) => hasMedia(task) && ids.includes(task.mediaId));
                        json(response, 200, { items: owned.map(metadata), missing: ids.filter((id) => !owned.some((task) => task.mediaId === id)) }); return;
                    }
                    if (path.startsWith("/api/v1/media/") && request.method === "GET") {
                        const id = path.slice("/api/v1/media/".length);
                        const task = [...tasks.values()].find((item) => hasMedia(item) && item.mediaId === id);
                        if (!task) { failure(response, 404, "not_found"); return; }
                        counts.mediaDownloads++;
                        response.writeHead(200, { "content-type": "image/png", "content-length": png.length, "cache-control": "no-store" }); response.end(png); return;
                    }
                }
                if (path.startsWith("/api/") || path.startsWith("/__generation-test")) { failure(response, 404, "not_found"); return; }
                next();
            })().catch(() => { if (!response.headersSent) failure(response, 400, "invalid_input"); else response.end(); });
        });
    },
    transformIndexHtml() { return [{ tag: "script", attrs: { type: "module" }, children: controls, injectTo: "body" }]; },
};

const server = await createServer({
    root: webDir, configFile: resolve(webDir, "vite.config.ts"), base: "/", envDir: false, envFile: false,
    envPrefix: "GENERATION_BROWSER_UNUSED_", plugins: [harness], logLevel: "error", clearScreen: false,
    server: { host: "127.0.0.1", port: 4180, strictPort: true, open: false, cors: false, allowedHosts: ["127.0.0.1"], proxy: {},
        fs: { strict: true, allow: [webDir, resolve(webDir, "../packages/shared")] } },
});
if (Object.keys(server.config.server.proxy ?? {}).length) { await server.close(); throw new Error("The isolated generation harness refuses resolved proxy routes."); }
await server.listen();
console.log(`仅开发隔离验收：${origin}/canvas；模拟账号/生成/计费，非真实供应商、队列、OSS或备份。`);
process.once("SIGINT", () => void server.close());
process.once("SIGTERM", () => void server.close());
