// Developer-only behavioral fixture: real IndexedDB, synthetic identities, no network transport.
import { createReceiptedDraftClient } from "./creation-receipts";
import { createCreationReceiptStore } from "./creation-receipt-store";

if (import.meta.env.DEV && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
    const root = document.getElementById("receipt-check")!;
    root.innerHTML = `
        <h1>保存回执 · 开发检查</h1>
        <p>真实浏览器 IndexedDB；账号、作品与 API 响应均为合成数据。不会连接账户后端、读取原画布或上传。</p>
        <p>请在独立测试来源使用。不会删除测试记录。刷新不会自动查询或提交。</p>
        <label>测试账号 <select id="account"><option value="receipt-check-A">合成账号 A</option><option value="receipt-check-B">合成账号 B</option></select></label>
        <p><button id="create">写回执并模拟响应丢失</button> <button id="read">读取本账号回执</button> <button id="failure">验证存储失败不发送</button> <button id="reload">刷新测试页</button></p>
        <p id="counts"></p><p id="status" role="status">尚未操作</p><ul id="records"></ul>`;
    const account = document.getElementById("account") as HTMLSelectElement;
    const status = document.getElementById("status")!;
    const records = document.getElementById("records")!;
    const receipts = createCreationReceiptStore();
    let epoch = 1, posts = 0, gets = 0;
    const scope = () => ({ accountId: account.value, epoch });
    const updateCounts = () => { document.getElementById("counts")!.textContent = `本页模拟 POST ${posts} 次 / GET ${gets} 次；真实 API 请求 0 次`; };
    const transport = (async (_path, options) => {
        if (options?.method === "POST") { posts++; updateCounts(); throw new Error("synthetic-response-loss"); }
        gets++; updateCounts();
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
    }) as typeof fetch;
    let client = createReceiptedDraftClient(scope, receipts, transport);
    account.onchange = () => { epoch++; client = createReceiptedDraftClient(scope, receipts, transport); records.replaceChildren(); status.textContent = "已切换合成账号，未自动读取或请求。"; };
    const run = (id: string, action: () => Promise<void>) => {
        const button = document.getElementById(id) as HTMLButtonElement;
        button.onclick = async () => { button.disabled = true; try { await action(); } catch { status.textContent = "检查未完成，请查看对应测试；未输出原始错误。"; } finally { button.disabled = false; } };
    };
    run("create", async () => {
        const version = epoch;
        const intent = client.prepareCreate("synthetic-receipt-project", { title: "不会写进回执的合成标题", documentVersion: 1, document: { id: "synthetic-receipt-project", nodes: [{ text: "不会写进回执的合成正文" }] } });
        await intent.submit().catch((error) => { if (error.outcome !== "unknown") throw error; });
        if (version !== epoch) return;
        status.textContent = `回执已提交，模拟保存响应丢失：${intent.id}。尚未核对，不表示云端成功。`;
    });
    run("read", async () => {
        const version = epoch, owner = account.value;
        const references = await client.recover("synthetic-receipt-project");
        const metadata = await receipts.list(owner, "synthetic-receipt-project");
        if (version !== epoch) return;
        records.replaceChildren();
        for (const reference of references) {
            const row = document.createElement("li"), text = document.createElement("span"), button = document.createElement("button");
            text.textContent = `${reference.id}（只读引用，无 submit） `;
            button.textContent = `主动核对 ${reference.id}`;
            button.onclick = async () => {
                button.disabled = true;
                try {
                    const check = await reference.reconcile();
                    if (version !== epoch) return;
                    status.textContent = `模拟核对：${check.status}；回执保留，不重传、不覆盖。`;
                } catch { if (version === epoch) status.textContent = "核对未完成，回执保留。"; }
                finally { button.disabled = false; }
            };
            row.append(text, button); records.append(row);
        }
        const fieldsOnly = metadata.every((row) => Object.keys(row).sort().join(",") === "accountId,creationId,localProjectId");
        status.textContent = `找到 ${references.length} 条本账号回执；仅三字段：${fieldsOnly ? "通过" : "失败"}。此操作没有网络请求。`;
    });
    run("failure", async () => {
        let sends = 0;
        const broken = createReceiptedDraftClient(scope, { put: async () => { throw new Error("synthetic-storage-failure"); }, list: async () => [] }, (async () => { sends++; return new Response(); }) as typeof fetch);
        const intent = broken.prepareCreate("synthetic-receipt-project", { title: "失败合成稿", documentVersion: 1, document: { id: "synthetic-receipt-project" } });
        const result = await intent.submit().catch((error) => error);
        status.textContent = `存储失败阻断：${result.code === "receipt_unavailable" && sends === 0 ? "通过" : "失败"}；模拟 POST ${sends} 次。`;
    });
    document.getElementById("reload")!.onclick = () => location.reload();
    updateCounts();
}
