import type { CanvasDraft, SessionPrincipal } from "../../../../packages/shared/src/index";

export type AuthScenario = "normal" | "mail" | "rate" | "captcha" | "captcha-service" | "link-expired";
export type SaveScenario = "normal" | "offline" | "rate" | "expired" | "conflict" | "oversize" | "pending";
export type PreviewDraft = CanvasDraft & { document: { note: string } };
type Account = SessionPrincipal & { email: string; verified: boolean };
export class PreviewError extends Error {
    constructor(public code: string, message: string) { super(message); }
}

/** Deliberately not authentication or cloud storage: tab-local synthetic state, no I/O, no passwords. */
export function createPreviewService() {
    const accounts = new Map<string, Account>([
        ["creator@example.test", { id: "demo-a", name: "创作者 A", email: "creator@example.test", role: "user", verified: true }],
        ["guest@example.test", { id: "demo-b", name: "创作者 B", email: "guest@example.test", role: "user", verified: true }],
    ]);
    const drafts = new Map<string, { ownerId: string; draft: PreviewDraft }>();
    const verification = new Set<string>();
    const resetLinks = new Set<string>();
    let current: Account | null = null;
    const fail = (code: string, message: string): never => { throw new PreviewError(code, message); };
    const normalize = (email: string) => {
        const value = email.trim().toLowerCase();
        if (!/^[^\s@]+@example\.test$/.test(value)) fail("demo_email", "请使用 @example.test 演示邮箱，不要填写真实个人信息。");
        return value;
    };
    const requireAccount = () => current ?? fail("unauthorized", "登录状态已失效，重新演示登录后再保存；编辑内容仍保留。");
    const getRecord = (id: string) => {
        const owner = requireAccount();
        const record = drafts.get(id);
        if (!record || record.ownerId !== owner.id) return fail("not_found", "找不到这个演示画布，或你没有访问权限。");
        return record;
    };
    const guardAuth = (scenario: AuthScenario) => {
        if (scenario === "rate") fail("rate_limited", "操作过于频繁，请稍后再试。预览中切回「正常」后可重新操作；没有真实计时。");
        if (scenario === "captcha") fail("captcha_failed", "人机验证未通过，请重新验证后提交。");
        if (scenario === "captcha-service") fail("service_unavailable", "验证服务暂时不可用，请稍后再试。本次操作没有绕过验证。");
    };
    const sendMail = (scenario: AuthScenario) => {
        if (scenario === "mail") fail("mail_unavailable", "邮件发送未确认，请稍后重新申请；未验证账号仍不能登录。");
    };
    const create = (title: string, note = "") => {
        const owner = requireAccount();
        const clean = title.trim();
        if (!clean || [...clean].length > 100) return fail("invalid_input", "画布名称需要 1–100 个字。");
        const now = new Date().toISOString();
        const draft: PreviewDraft = { id: crypto.randomUUID(), title: clean, documentVersion: 1, document: { note }, revision: 1, createdAt: now, updatedAt: now };
        drafts.set(draft.id, { ownerId: owner.id, draft });
        return structuredClone(draft);
    };
    current = accounts.get("creator@example.test")!;
    create("春日新品 · 创作提案", "一支关于春天的短片。\n\n先梳理主题、受众和画面，再决定需要哪些素材。");
    create("播客开场 · 声音脚本", "把一个想法讲清楚。\n\n这只是示例文字，不会调用语音或其他模型。");
    current = null;

    return {
        register(name: string, email: string, scenario: AuthScenario) {
            guardAuth(scenario);
            const key = normalize(email);
            if (accounts.has(key)) fail("account_exists", "这个演示邮箱已注册，请登录或重新申请验证邮件。");
            accounts.set(key, { id: crypto.randomUUID(), name: name.trim() || "新创作者", email: key, verified: false, role: "user" });
            sendMail(scenario); // A failed mail can leave an unverified account, as in the backend contract.
            verification.add(key);
        },
        resend(email: string, scenario: AuthScenario) {
            guardAuth(scenario);
            const key = normalize(email);
            sendMail(scenario);
            if (accounts.has(key) && !accounts.get(key)!.verified) verification.add(key);
        },
        verify(email: string, scenario: AuthScenario) {
            const key = normalize(email);
            if (scenario === "link-expired" || !verification.has(key)) fail("invalid_link", "验证链接不可用或已失效，请重新申请验证邮件。");
            accounts.get(key)!.verified = true;
            verification.delete(key);
        },
        login(email: string, scenario: AuthScenario = "normal") {
            guardAuth(scenario);
            const account = accounts.get(normalize(email));
            if (!account) return fail("auth_rejected", "没有这个演示账号，请先注册或选择演示账号 A / B。");
            if (!account.verified) return fail("unverified", "请先完成邮箱验证，再登录。");
            current = account;
            return { id: account.id, name: account.name, role: account.role } satisfies SessionPrincipal;
        },
        requestReset(email: string, scenario: AuthScenario) {
            guardAuth(scenario);
            const key = normalize(email);
            sendMail(scenario);
            if (accounts.has(key)) resetLinks.add(key);
        },
        resetPassword(email: string, scenario: AuthScenario) {
            const key = normalize(email);
            if (scenario === "link-expired" || !resetLinks.has(key)) fail("invalid_link", "重置链接不可用或已失效，请重新申请。");
            resetLinks.delete(key);
            if (current?.email === key) current = null;
            // No password is accepted/stored. This demonstrates navigation and session revocation only.
        },
        logout() { current = null; },
        list() {
            const owner = requireAccount();
            return [...drafts.values()].filter((item) => item.ownerId === owner.id).map((item) => structuredClone(item.draft));
        },
        get(id: string) { return structuredClone(getRecord(id).draft); },
        create,
        save(input: PreviewDraft, scenario: SaveScenario) {
            if (scenario === "expired") current = null;
            const record = getRecord(input.id);
            if (scenario === "offline") fail("network_error", "网络连接中断，未保存。本页的修改仍保留，恢复后请手动重试。");
            if (scenario === "rate") fail("rate_limited", "保存过于频繁，未保存。请稍后手动重试，旧稿没有被覆盖。");
            if (scenario === "oversize" || new TextEncoder().encode(JSON.stringify(input.document)).byteLength > 5 * 1024 * 1024) {
                fail("payload_too_large", "内容超过 5 MiB，未保存。请缩减内容；图片和视频需走素材存储，旧稿没有被覆盖。");
            }
            if (scenario === "pending") fail("preview_pending", "请由预览面板手动完成模拟响应。");
            if (scenario === "conflict" && record.draft.revision === input.revision) {
                record.draft = { ...record.draft, revision: record.draft.revision + 1, document: { note: "另一窗口保存的演示版本。你的当前修改没有被覆盖。" } };
            }
            if (record.draft.revision !== input.revision) fail("revision_conflict", "另一窗口已保存新版本。你的修改仍在这里，请比较后选择处理方式。");
            const title = input.title.trim();
            if (!title || [...title].length > 100) fail("invalid_input", "画布名称需要 1–100 个字。");
            record.draft = { ...structuredClone(input), title, revision: input.revision + 1, updatedAt: new Date().toISOString() };
            return structuredClone(record.draft);
        },
    };
}
