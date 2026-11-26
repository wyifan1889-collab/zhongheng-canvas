/**
 * Local T10 browser fixture: original account/draft/share/media HTTP handlers,
 * a fresh in-memory PGlite database and private in-memory object storage.
 * Start with Bun --no-env-file. Vite runs separately with VITE_API_TARGET.
 * Never import this script into the application or a deployed API.
 */
import { readFile } from "node:fs/promises";
import { createAccountApi } from "../../apps/api/src/accounts";
import { createApp } from "../../apps/api/src/app";
import { createTestDatabase } from "../../apps/api/test/database";
import { createRateStore } from "../../packages/database/src/rate-limit";
import { createMemoryObjectStorage } from "../../packages/storage/src/index";
import type { CanvasDraft, JsonObject } from "../../packages/shared/src/index";

// Refuse the real-Postgres opt-in before createTestDatabase can inspect it.
if (Object.keys(process.env).some((name) => name.includes("DATABASE") || name.startsWith("SAAS_TEST"))) {
    throw new Error("T10 browser fixture refuses DATABASE/SAAS_TEST environment configuration; no database was opened.");
}
const port = Number(process.env.T10_SHARE_API_PORT ?? "60610");
const webOrigin = process.env.T10_SHARE_WEB_ORIGIN ?? "http://127.0.0.1:60611";
const webUrl = new URL(webOrigin);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || webUrl.protocol !== "http:" ||
    webUrl.hostname !== "127.0.0.1" || !webUrl.port || webUrl.origin !== webOrigin || webUrl.username || webUrl.password) {
    throw new Error("T10 fixture requires a dedicated API port and an exact http://127.0.0.1:<port> web origin.");
}
const database = await createTestDatabase(); // Fresh PGlite only; never reads DATABASE_URL.
const secret = `t10-local-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const captcha = crypto.randomUUID();
const mail = new Map<string, string>();
const storage = createMemoryObjectStorage();
const app = createApp(createAccountApi({
    database: database.db, origin: webOrigin, cloudCanvas: true,
    auth: { secret, sendVerificationEmail: async ({ to, url }) => { mail.set(to, url); }, sendResetPassword: async () => {} },
    rates: createRateStore(database.pool, secret),
    verifyHuman: async (request) => request.headers.get("x-captcha-response") === captcha,
    media: { storage, quotaBytes: 32 * 1024 * 1024, maxBytes: { image: 8 * 1024 * 1024, video: 8 * 1024 * 1024, audio: 8 * 1024 * 1024 } },
    onFault: () => { console.error("T10 fixture: original API reported a fault; no private error body was logged."); },
}), "t10-fixture-public-test-key", true, true);

type Label = "owner" | "viewer" | "editor" | "outsider";
type TestAccount = { id: string; name: string; email: string; password: string; cookie: string; peer: string };
const accounts = {} as Record<Label, TestAccount>;
const base = "/api/__t10-fixture";
const counts = { draftReads: 0, draftWrites: 0, mediaResolves: 0, mediaDownloads: 0, mediaUploads: 0 };
const seed = { canvasId: crypto.randomUUID(), sharedMediaId: "", ownerUnreferencedMediaId: "", editorMediaId: "", joinPath: "" };
let server: ReturnType<typeof Bun.serve> | undefined;

function cookies(response: Response) { return response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; "); }
function json(value: unknown, status = 200, headers: HeadersInit = {}) {
    const projected = new Headers(headers); projected.set("cache-control", "no-store"); projected.set("referrer-policy", "no-referrer");
    return Response.json(value, { status, headers: projected });
}
async function call(path: string, init: RequestInit = {}, account?: TestAccount): Promise<Response> {
    const headers = new Headers(init.headers); headers.set("origin", webOrigin);
    if (account) { headers.set("cookie", account.cookie); headers.set("x-canvas-account-id", account.id); }
    return app(new Request(`${webOrigin}${path}`, { ...init, headers }), account?.peer ?? "198.51.100.200");
}
async function jsonCall(path: string, body: unknown, account: TestAccount, method = "POST") {
    const response = await call(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, account);
    if (!response.ok) throw new Error(`Original API refused fixture operation: ${method} ${path.split("/").slice(0, 5).join("/")} HTTP ${response.status}`);
    return response.json();
}
async function register(label: Label, index: number) {
    const name = `T10 隔离 ${label}`, email = `t10-${label}@example.test`, password = `fixture-${crypto.randomUUID()}`;
    const peer = `198.51.100.${210 + index}`;
    const signup = await app(new Request(`${webOrigin}/api/auth/sign-up/email`, { method: "POST",
        headers: { origin: webOrigin, "content-type": "application/json", "x-captcha-response": captcha }, body: JSON.stringify({ name, email, password }) }), peer);
    if (!signup.ok || !mail.has(email)) throw new Error("Original registration/verification flow did not complete.");
    const verify = await app(new Request(mail.get(email)!), peer); mail.delete(email);
    if (verify.status !== 302) throw new Error("Original email verification was not accepted.");
    accounts[label] = { id: "", name, email, password, cookie: "", peer };
    const login = await loginAccount(accounts[label]);
    accounts[label].cookie = cookies(login);
    const session = await call("/api/v1/session", {}, accounts[label]);
    const info = await session.json();
    if (!session.ok || !info.user?.id) throw new Error("Original session was not confirmed.");
    accounts[label].id = info.user.id;
}
function loginAccount(account: TestAccount) {
    return app(new Request(`${webOrigin}/api/auth/sign-in/email`, { method: "POST",
        headers: { origin: webOrigin, "content-type": "application/json", "x-captcha-response": captcha },
        body: JSON.stringify({ email: account.email, password: account.password }) }), account.peer);
}
async function upload(account: TestAccount, bytes: Uint8Array) {
    const response = await call("/api/v1/media", { method: "POST", headers: { "content-type": "image/png" }, body: bytes }, account);
    const result = await response.json();
    if (response.status !== 201 || !result.media?.id) throw new Error("Original private media upload did not complete.");
    return result.media.id as string;
}
async function invite(role: "viewer" | "editor", reset = false) {
    const result = await jsonCall(`/api/v1/canvas/${seed.canvasId}/share-link`, { role, ...(reset ? { reset: true } : {}) }, accounts.owner);
    seed.joinPath = `/canvas/join/${result.share.token}`;
    return result.share.token as string;
}
async function activateMembers() {
    const token = await invite("editor");
    for (const label of ["viewer", "editor"] as const) {
        await jsonCall(`/api/v1/canvas/${seed.canvasId}/members`, { userId: accounts[label].id, role: label }, accounts.owner);
        await jsonCall(`/api/v1/canvas/share/${token}/join`, {}, accounts[label]);
    }
}
async function snapshot() {
    const response = await call(`/api/v1/canvases/${seed.canvasId}`, {}, accounts.owner);
    const current = await response.json();
    return { isolation: "Fresh PGlite + memory objects; original API and original web application", counts,
        accounts: Object.fromEntries(Object.entries(accounts).map(([label, account]) => [label, { id: account.id, name: account.name, email: account.email }])),
        seed: { ...seed, canvasPath: `/canvas/${seed.canvasId}` },
        authoritative: response.ok ? { revision: current.draft.revision, title: current.draft.title, document: current.draft.document } : null };
}

const controls = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>T10 本机真实 API 夹具</title>
<style>body{font:15px/1.6 system-ui;max-width:1000px;margin:30px auto;padding:0 20px}button,a{margin:4px;padding:5px 8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f4f4;padding:16px}</style>
<h1>T10 本机真实 API 夹具</h1><p>数据库与对象只在本进程内存中。登录、邮箱验证、素材、画布、分享和成员操作均使用原 API。原版页面由单独的 Vite 提供。本页只切换合成测试账号及调用实际权限操作；不导入真实资料。</p>
<p>初始 viewer/editor 是 pending，必须登录后在原加入页确认。需要直接检查已加入场景时，使用“激活两名成员”。不同浏览器保持各自 Cookie，停止本进程即清除全部合成资料。</p>
<div id="logins"></div><p><a id="canvas">打开原画布</a><a id="join">打开当前原加入页</a></p><div id="actions"></div><p id="status" role="status"></p><pre id="state"></pre>
<script>
const base=${JSON.stringify(base)}, status=document.querySelector('#status');
async function refresh(){const r=await fetch(base+'/state',{cache:'no-store'});const v=await r.json();document.querySelector('#state').textContent=JSON.stringify(v,null,2);document.querySelector('#canvas').href=v.seed.canvasPath;document.querySelector('#join').href=v.seed.joinPath;return v;}
async function command(path,body){status.textContent='正在调用原 API…';const r=await fetch(base+path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const v=await r.json();status.textContent=r.ok?'已完成；切换账号后请打开或刷新原页面。':v.error;await refresh();}
for(const account of ['owner','viewer','editor','outsider']){const b=document.createElement('button');b.textContent='登录 '+account;b.onclick=()=>command('/login',{account});document.querySelector('#logins').append(b);}
for(const [action,label] of [['activate-members','激活两名成员（真实 join）'],['downgrade-editor','editor 降为 viewer'],['revoke-viewer','撤销 viewer'],['revoke-editor','撤销 editor'],['reset-link','重置当前链接'],['clear-counts','清请求计数']]){const b=document.createElement('button');b.textContent=label;b.onclick=()=>command('/action',{action});document.querySelector('#actions').append(b);}
const b=document.createElement('button');b.textContent='刷新服务器状态';b.onclick=()=>refresh();document.querySelector('#actions').append(b);refresh();
</script></html>`;

try {
    for (const [index, label] of (["owner", "viewer", "editor", "outsider"] as const).entries()) await register(label, index);
    const png = new Uint8Array(await readFile(new URL("./fixtures/media-recovery.png", import.meta.url)));
    seed.sharedMediaId = await upload(accounts.owner, png);
    seed.ownerUnreferencedMediaId = await upload(accounts.owner, png);
    seed.editorMediaId = await upload(accounts.editor, png);
    const now = new Date().toISOString(), title = "T10 共享画布 · 合成资料";
    const document: JsonObject = { id: "t10-source-device-local-id", title, createdAt: now, updatedAt: now,
        nodes: [
            { id: "fixture-text", type: "text", title: "共享文本", position: { x: 80, y: 100 }, width: 320, height: 180, metadata: { content: "这段文字来自原云稿。viewer 只读；editor 保存使用原 revision CAS。", status: "success" } },
            { id: "fixture-image", type: "image", title: "已引用的私有图片", position: { x: 460, y: 100 }, width: 320, height: 240,
                metadata: { cloudMediaId: seed.sharedMediaId, content: "", status: "success", mimeType: "image/png", bytes: png.length, naturalWidth: 64, naturalHeight: 48 } },
        ], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
    const created: { draft: CanvasDraft } = await jsonCall("/api/v1/canvases", { creationId: seed.canvasId, title, documentVersion: 1, document }, accounts.owner);
    if (created.draft.id !== seed.canvasId) throw new Error("Original canvas creation identity did not match.");
    await invite("editor");
    for (const label of ["viewer", "editor"] as const) {
        await jsonCall(`/api/v1/canvas/${seed.canvasId}/members`, { userId: accounts[label].id, role: label }, accounts.owner);
    }
    server = Bun.serve({ hostname: "127.0.0.1", port, async fetch(request, running) {
        const url = new URL(request.url), peer = running.requestIP(request)?.address;
        if (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1") return json({ error: "Local fixture only" }, 403);
        if (url.pathname.startsWith(base)) {
            if (request.method !== "GET" && request.headers.get("origin") !== webOrigin) return json({ error: "Fixture origin mismatch" }, 403);
            try {
                if (request.method === "GET" && url.pathname === base) return new Response(controls, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" } });
                if (request.method === "GET" && url.pathname === `${base}/state`) return json(await snapshot());
                if (request.method === "POST" && url.pathname === `${base}/login`) {
                    const body = await request.json(), account = accounts[body.account as Label];
                    if (!account) return json({ error: "Unknown fixture account" }, 400);
                    const response = await loginAccount(account);
                    if (!response.ok) return json({ error: "Original sign-in was refused" }, response.status);
                    const headers = new Headers(); for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
                    return json({ ok: true, accountId: account.id }, 200, headers);
                }
                if (request.method === "POST" && url.pathname === `${base}/action`) {
                    const { action } = await request.json();
                    if (action === "activate-members") await activateMembers();
                    else if (action === "downgrade-editor") await jsonCall(`/api/v1/canvas/${seed.canvasId}/members`, { userId: accounts.editor.id, role: "viewer" }, accounts.owner);
                    else if (action === "revoke-viewer" || action === "revoke-editor") {
                        const label = action === "revoke-viewer" ? "viewer" : "editor";
                        const response = await call(`/api/v1/canvas/${seed.canvasId}/members/${encodeURIComponent(accounts[label].id)}`, { method: "DELETE" }, accounts.owner);
                        if (!response.ok) throw new Error("Original member deletion was refused.");
                    } else if (action === "reset-link") await invite("editor", true);
                    else if (action === "clear-counts") for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
                    else return json({ error: "Unknown fixture action" }, 400);
                    return json({ ok: true });
                }
                return json({ error: "Unknown fixture endpoint" }, 404);
            } catch { return json({ error: "Fixture action failed; original API did not confirm completion." }, 503); }
        }
        if (/^\/api\/v1\/canvases\/[^/]+$/.test(url.pathname)) {
            if (request.method === "GET") counts.draftReads++;
            if (request.method === "PUT") counts.draftWrites++;
        }
        if (url.pathname === "/api/v1/media/resolve") counts.mediaResolves++;
        else if (/^\/api\/v1\/media\/[^/]+$/.test(url.pathname) && request.method === "GET") counts.mediaDownloads++;
        else if (url.pathname === "/api/v1/media" && request.method === "POST") counts.mediaUploads++;
        return app(new Request(new URL(url.pathname + url.search, webOrigin), request), "127.0.0.1");
    } });
    console.log(`T10 isolated original API: http://127.0.0.1:${port}`);
    console.log(`Fixture controls (through Vite): ${webOrigin}${base}`);
    console.log(JSON.stringify({ canvasId: seed.canvasId, sharedMediaId: seed.sharedMediaId, ownerUnreferencedMediaId: seed.ownerUnreferencedMediaId, editorMediaId: seed.editorMediaId,
        accountIds: Object.fromEntries(Object.entries(accounts).map(([label, account]) => [label, account.id])) }));
} catch {
    await database.close();
    throw new Error("T10 fixture startup failed. Ensure the original T10 API/migrations are integrated and the dedicated ports are free. No persistent database or object store was used.");
}
async function shutdown() { server?.stop(true); await database.close(); process.exit(0); }
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
