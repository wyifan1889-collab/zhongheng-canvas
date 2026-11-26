import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Alert, App, Button, Checkbox, ConfigProvider, Form, Input, Modal, Select } from "antd";
import zhCN from "antd/locale/zh_CN";
import { ArrowLeft, ArrowRight, Check, ChevronRight, FileText, FlaskConical, FolderOpen, Image, Infinity as InfinityIcon, LogOut, Mail, Moon, Plus, Save, ShieldCheck, Sun, Video, Volume2 } from "lucide-react";
import type { CanvasSaveState, SessionPrincipal } from "../../../../packages/shared/src/index";
import { createPreviewService, PreviewError, type AuthScenario, type PreviewDraft, type SaveScenario } from "@/services/saas/preview";
import { previewBrand, previewTheme } from "./brand";
import "antd/dist/reset.css";
import "./preview.css";

type View = "login" | "register" | "verify" | "forgot" | "reset" | "library" | "editor";
type Notice = { kind: "error" | "success" | "info"; text: string } | null;
const authScenarios = [
    { value: "normal", label: "正常流程" }, { value: "mail", label: "邮件发送失败" },
    { value: "rate", label: "操作过于频繁" }, { value: "captcha", label: "人机验证未通过" },
    { value: "captcha-service", label: "验证服务不可用" }, { value: "link-expired", label: "验证 / 重置链接失效" },
];
const saveScenarios = [
    { value: "normal", label: "正常保存" }, { value: "pending", label: "停留在保存中" },
    { value: "offline", label: "网络中断" }, { value: "rate", label: "保存超频" },
    { value: "expired", label: "登录失效" }, { value: "conflict", label: "另一窗口已保存" },
    { value: "oversize", label: "内容超过大小上限" },
];
const authTitles = { login: "欢迎回来", register: "开始你的创作", verify: "还差一步，验证邮箱", forgot: "找回你的账户", reset: "设置新的登录密码" };
const saveLabels: Record<CanvasSaveState, string> = {
    "local-only": "仅本页演示", dirty: "有未保存修改", saving: "模拟保存中…", synced: "已保存到演示内存", conflict: "版本冲突 · 修改已保留", error: "保存失败 · 修改已保留",
};

function Workspace({ dark, toggleTheme }: { dark: boolean; toggleTheme: () => void }) {
    const { modal } = App.useApp();
    const [api] = useState(createPreviewService);
    const [view, setView] = useState<View>("login");
    const [principal, setPrincipal] = useState<SessionPrincipal | null>(null);
    const [email, setEmail] = useState("creator@example.test");
    const [authScenario, setAuthScenario] = useState<AuthScenario>("normal");
    const [saveScenario, setSaveScenario] = useState<SaveScenario>("normal");
    const [notice, setNotice] = useState<Notice>(null);
    const [projects, setProjects] = useState<PreviewDraft[]>([]);
    const [draft, setDraft] = useState<PreviewDraft | null>(null);
    const [baseline, setBaseline] = useState<PreviewDraft | null>(null);
    const [saveState, setSaveState] = useState<CanvasSaveState>("local-only");
    const [expired, setExpired] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [newTitle, setNewTitle] = useState("未命名画布");
    const [createError, setCreateError] = useState("");
    const [remote, setRemote] = useState<PreviewDraft | null>(null);
    const busy = saveState === "saving";
    const dirty = !!draft && !!baseline && (draft.title !== baseline.title || draft.document.note !== baseline.document.note);
    const needsPreserve = view === "editor" && (dirty || saveState === "conflict" || busy);

    useEffect(() => {
        if (!needsPreserve) return;
        const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", beforeUnload);
        return () => window.removeEventListener("beforeunload", beforeUnload);
    }, [needsPreserve]);

    const report = (error: unknown) => setNotice({ kind: "error", text: error instanceof PreviewError ? error.message : "演示操作未完成，请重试。" });
    const navigate = (next: View) => { if (next === "register") setEmail("new-creator@example.test"); setView(next); setNotice(null); };
    const leave = (action: () => void) => {
        if (busy) return;
        if (needsPreserve) modal.confirm({
            title: "还有未保存的修改", content: "离开会丢弃当前编辑中的修改，但不会覆盖已保存的演示版本。",
            okText: "放弃修改并离开", cancelText: "留在这里", onOk: action,
        }); else action();
    };
    const login = (address: string, scenario: AuthScenario = "normal") => {
        try {
            const account = api.login(address, scenario);
            setPrincipal(account); setEmail(address.trim().toLowerCase()); setProjects(api.list());
            setDraft(null); setBaseline(null); setExpired(false); setSaveState("local-only"); navigate("library");
        } catch (error) {
            if (error instanceof PreviewError && error.code === "unverified") { setEmail(address.trim().toLowerCase()); setView("verify"); }
            report(error);
        }
    };
    const library = () => leave(() => {
        try { setProjects(api.list()); setDraft(null); setBaseline(null); navigate("library"); }
        catch (error) { report(error); }
    });
    const openDraft = (item: PreviewDraft) => {
        const copy = api.get(item.id);
        setDraft(copy); setBaseline(copy); setSaveState("synced"); setSaveScenario("normal"); setExpired(false); navigate("editor");
    };
    const edit = (patch: Partial<PreviewDraft>) => {
        if (!draft || busy) return;
        const updated = { ...draft, ...patch };
        setDraft(updated);
        setNotice((current) => current?.kind === "success" ? null : current);
        if (saveState !== "conflict") setSaveState(updated.title === baseline?.title && updated.document.note === baseline?.document.note ? "synced" : "dirty");
    };
    const save = (scenario = saveScenario) => {
        if (!draft || expired) return;
        setNotice(null);
        if (scenario === "pending") { setSaveState("saving"); return; }
        try {
            const saved = api.save(draft, scenario);
            setDraft(saved); setBaseline(saved); setSaveState("synced"); setProjects(api.list());
            setNotice({ kind: "success", text: "已保存到本页演示内存。返回列表再打开可以检查结果；刷新页面会清空，不是云保存。" });
        } catch (error) {
            setSaveState(error instanceof PreviewError && error.code === "revision_conflict" ? "conflict" : "error");
            if (error instanceof PreviewError && error.code === "unauthorized") setExpired(true);
            report(error);
        }
    };
    const submitAuth = (values: { name?: string; email?: string }) => {
        const address = (values.email ?? email).trim().toLowerCase();
        setEmail(address); setNotice(null);
        try {
            if (view === "login") { login(address, authScenario); return; }
            if (view === "register") {
                api.register(values.name ?? "新创作者", address, authScenario);
                setView("verify"); setNotice({ kind: "info", text: "演示已进入待验证状态。不会真实发送邮件，请用下方模拟按钮继续。" });
            } else if (view === "forgot") {
                api.requestReset(address, authScenario); setView("reset");
                setNotice({ kind: "info", text: "如果账号存在，你将收到重置邮件。本次只模拟打开重置页面，没有发送真实邮件。" });
            } else if (view === "reset") {
                api.resetPassword(address, authScenario); setPrincipal(null); setView("login");
                setNotice({ kind: "success", text: "模拟重置完成，旧演示登录态已退出。请重新登录；演示不储存或验证真实密码。" });
            }
        } catch (error) {
            if (view === "register" && error instanceof PreviewError && error.code === "mail_unavailable") setView("verify");
            report(error);
        }
    };

    return <>
        <div className="preview-banner"><FlaskConical size={17} /><span><strong>流程演示，未接真实服务</strong><span className="banner-detail"> · 仅本页内存，刷新清空 · 不要输入真实资料或密码</span></span><span className="preview-phase">P1-A</span></div>
        <div className="preview-layout">
            <aside className="preview-sidebar">
                <div className="preview-brand"><InfinityIcon size={30} strokeWidth={1.6} /><span>{previewBrand.name}<small>创作空间 · 预览</small></span></div>
                <div className="preview-nav-label">工作空间</div>
                <Button type={principal ? "text" : "default"} icon={<FolderOpen size={17} />} disabled={busy} onClick={() => principal ? library() : navigate("login")}>我的画布</Button>
                <div className="preview-nav-label">后续接入</div>
                <span className="preview-future"><Image size={16} />图片创作<span>未开放</span></span>
                <span className="preview-future"><Video size={16} />视频创作<span>未开放</span></span>
                <span className="preview-future"><Volume2 size={16} />音频创作<span>未开放</span></span>
                <p className="preview-side-note">文本草稿可体验。<br />模型调用、充值与素材云存储尚未接入。</p>
                <div className="preview-sidebar-bottom">
                    <Button type="text" icon={dark ? <Sun size={16} /> : <Moon size={16} />} onClick={toggleTheme}>{dark ? "切换浅色" : "切换深色"}</Button>
                    {principal && <><div className="preview-user"><span className="preview-avatar">{principal.name.slice(0, 1)}</span><div>{principal.name}<small>演示账号 · {expired ? "需重新登录" : "已登录"}</small></div></div><Button type="text" disabled={busy} icon={<LogOut size={16} />} onClick={() => leave(() => { api.logout(); setPrincipal(null); setDraft(null); setBaseline(null); setSaveState("local-only"); navigate("login"); })}>退出演示账号</Button></>}
                    <small>品牌与配色尚未定稿</small>
                </div>
            </aside>
            <main className="preview-main">
                <header className="preview-topline"><span>你的创作，从这里开始</span><span>账户与保存流程预览</span></header>
                {view !== "library" && view !== "editor" ? <div className="preview-auth-layout">
                    <section className="preview-intro">
                        <span className="preview-eyebrow">A SPACE FOR YOUR IDEAS</span>
                        <h1>一个想法，<br />无限可能。</h1>
                        <p>{previewBrand.tagline}</p>
                        <div className="preview-intro-board" aria-hidden="true"><div className="preview-idea"><FileText size={18} /><span>记录灵感<small>从一句话开始</small></span></div><span className="preview-connector" /><div className="preview-idea second"><FolderOpen size={18} /><span>展开创作<small>让想法彼此连接</small></span></div></div>
                        <ol className="preview-journey"><li><span>01</span>建立账户</li><li><span>02</span>进入画布</li><li><span>03</span>保留创作</li></ol>
                        <p className="preview-disclaimer">本轮先看流程，不是最终视觉稿。无需填写任何供应商 Key。</p>
                    </section>
                    <section className="preview-auth-card">
                        {view !== "login" && <Button className="preview-back" type="text" icon={<ArrowLeft size={16} />} onClick={() => navigate("login")}>返回登录</Button>}
                        <h2>{authTitles[view]}</h2>
                        <p className="preview-muted">{view === "verify" ? email : view === "register" ? "创建独立账户，开启属于自己的创作空间。" : "演示邮箱统一使用 @example.test，不接真实账户。"}</p>
                        {notice && <div className="preview-notice" role="status"><Alert type={notice.kind} showIcon title={notice.text} /></div>}
                        {view === "verify" ? <div className="preview-verify">
                            <Mail size={38} strokeWidth={1.4} /><p>验证前不能登录。没收到邮件时，可重新申请；发送失败不会变成登录成功。</p>
                            <Button type="primary" block onClick={() => {
                                try { api.verify(email, authScenario); setView("login"); setNotice({ kind: "success", text: "演示邮箱已验证，现在可以登录。" }); }
                                catch (error) { report(error); }
                            }}>模拟点击验证链接</Button>
                            <Button block onClick={() => {
                                try { api.resend(email, authScenario); setNotice({ kind: "info", text: "已模拟重新申请验证邮件。没有真实发送，可继续模拟验证。" }); }
                                catch (error) { report(error); }
                            }}>重新申请验证邮件</Button>
                            <Button type="link" onClick={() => navigate("login")}>返回登录试一试</Button>
                        </div> : <Form key={view} layout="vertical" requiredMark={false} initialValues={{ email, name: "新创作者", human: false }} onFinish={submitAuth} autoComplete="off" clearOnDestroy>
                            {view === "register" && <Form.Item label="你的称呼" name="name" rules={[{ required: true, message: "请输入演示称呼" }]}><Input size="large" /></Form.Item>}
                            {view !== "reset" && <Form.Item label="演示邮箱" name="email" rules={[{ required: true, message: "请输入演示邮箱" }, { pattern: /^[^\s@]+@example\.test$/i, message: "仅使用 @example.test 演示邮箱" }]}><Input size="large" inputMode="email" autoComplete="off" /></Form.Item>}
                            {view !== "forgot" && <Form.Item label={view === "reset" ? "新密码（仅演示外观）" : "密码（仅演示外观）"} extra="固定演示值，不收集或验证真实密码。"><Input.Password size="large" value="demo-only" readOnly autoComplete="off" /></Form.Item>}
                            {view !== "reset" && <Form.Item name="human" valuePropName="checked" rules={[{ validator: (_, checked) => checked ? Promise.resolve() : Promise.reject(new Error("请勾选模拟人机验证")) }]}><Checkbox>模拟人机验证通过（不是实际验证码）</Checkbox></Form.Item>}
                            <Button type="primary" block size="large" htmlType="submit" icon={<ArrowRight size={17} />} iconPlacement="end">{view === "login" ? "登录演示账户" : view === "register" ? "创建演示账户" : view === "forgot" ? "申请重置邮件（模拟）" : "确认重置（模拟）"}</Button>
                        </Form>}
                        {view === "login" && <><div className="preview-auth-links"><Button type="link" onClick={() => navigate("register")}>没有账号？注册</Button><Button type="link" onClick={() => navigate("forgot")}>忘记密码</Button></div><div className="preview-quick"><span>也可以跳过表单，直接看工作空间</span><Button onClick={() => login("creator@example.test")}>体验账号 A · 示例画布</Button><Button onClick={() => login("guest@example.test")}>体验账号 B · 空状态</Button></div></>}
                        {view === "reset" && <Button type="link" onClick={() => navigate("forgot")}>链接失效？重新申请</Button>}
                        <details className="preview-controls"><summary><FlaskConical size={15} />体验异常情况<ChevronRight size={14} /></summary><label htmlFor="auth-scenario">当前模拟情境</label><Select id="auth-scenario" value={authScenario} options={authScenarios} onChange={setAuthScenario} /><small>只影响演示操作，不发送请求、不修改真实防护数值。验证链接情境用于链接按钮，邮件情境用于发信操作。</small></details>
                    </section>
                </div> : view === "library" ? <section className="preview-library">
                    <div className="preview-library-heading"><div><span className="preview-eyebrow">YOUR WORKSPACE</span><h1>我的画布<span className="preview-count">{projects.length}</span></h1><p>把零散的灵感，慢慢变成完整的作品。</p></div><Button type="primary" size="large" icon={<Plus size={18} />} onClick={() => { setNewTitle("未命名画布"); setCreateError(""); setCreateOpen(true); }}>新建演示画布</Button></div>
                    <div className="preview-library-note"><ShieldCheck size={17} /><span>以下仅是当前演示账号的项目，不读取原有浏览器作品。保存只在本页内存中有效。</span></div>
                    {notice && <Alert type={notice.kind} showIcon title={notice.text} />}
                    {projects.length ? <div className="preview-grid">{projects.map((item, index) => <button className="preview-project" key={item.id} onClick={() => openDraft(item)}><div className="preview-project-visual"><span className="preview-project-number">0{index + 1}</span><div className="preview-note-thumbnail"><FileText size={18} /><span>{item.document.note || "留一块空白，给下一个好想法。"}</span></div><span className="preview-project-type">文本草稿 · 演示</span></div><div className="preview-project-info"><h2>{item.title}</h2><span>版本 {item.revision}<ArrowRight size={16} /></span></div></button>)}</div> : <div className="preview-empty"><FolderOpen size={46} strokeWidth={1} /><h2>你的第一张画布，从这里开始</h2><p>这个演示账户还没有项目。新建一张，写下第一个想法。</p><Button icon={<Plus size={16} />} onClick={() => { setNewTitle("我的第一张画布"); setCreateError(""); setCreateOpen(true); }}>创建第一张演示画布</Button></div>}
                    <p className="preview-muted preview-library-footer">图片、视频、音频生成和素材云存储将在后续接入。这里没有充值入口或模拟余额。</p>
                </section> : draft && <section className="preview-editor">
                    <div className="preview-editor-toolbar"><Button type="text" disabled={busy} icon={<ArrowLeft size={17} />} onClick={library}>我的画布</Button><span className="preview-save-state" role="status">{saveState === "synced" && <Check size={15} />}{saveLabels[saveState]}</span><Button type="primary" disabled={expired} loading={busy} icon={<Save size={16} />} onClick={() => save()}>保存演示草稿</Button></div>
                    <div className="preview-editor-notice" role="status">{notice && <Alert type={notice.kind} showIcon title={notice.text} />}</div>
                    <div className="preview-editor-grid"><div className="preview-board"><div className="preview-board-caption">文本草稿流程演示 · 尚未接入官方画布引擎 / 素材</div><section className="preview-note-editor"><div className="preview-note-label"><FileText size={16} />灵感笔记<span>版本 {draft.revision}</span></div><label htmlFor="draft-title">画布名称</label><Input id="draft-title" value={draft.title} disabled={busy} onChange={(event) => edit({ title: event.target.value })} /><label htmlFor="draft-note">创作内容</label><Input.TextArea id="draft-note" value={draft.document.note} disabled={busy} autoSize={{ minRows: 8, maxRows: 18 }} placeholder="写下你的想法…本轮只演示文本草稿，不上传媒体。" onChange={(event) => edit({ document: { note: event.target.value } })} /><small>手动点击保存。不自动覆盖、不自动重试。</small></section></div>
                        <aside className="preview-inspector"><span className="preview-eyebrow">FLOW CHECK</span><h2>试一试保存过程</h2><p>选一种情境，再点击「保存演示草稿」，检查失败时是否知道下一步怎么做。</p><label htmlFor="save-scenario">保存情境</label><Select id="save-scenario" value={saveScenario} options={saveScenarios} disabled={busy} onChange={setSaveScenario} />
                            {busy && <div className="preview-recovery"><p>停留在保存中供你查看。没有超时或自动重试；点下方按钮才完成模拟响应。</p><Button block onClick={() => save("normal")}>完成模拟保存</Button></div>}
                            {expired && <div className="preview-recovery"><p>输入仍在。重新演示登录后，不会自动提交。</p><Button block onClick={() => { try { api.login(email); setExpired(false); setSaveState("dirty"); setSaveScenario("normal"); setNotice({ kind: "info", text: "演示登录已恢复，修改仍未保存，请手动点击保存。" }); } catch (error) { report(error); } }}>重新演示登录并保留编辑</Button></div>}
                            {saveState === "conflict" && <div className="preview-recovery"><h3>先保留，再比较</h3><p>当前文字没有丢失。先看另一版本，或另存副本，避免直接覆盖。</p><Button block onClick={() => { try { setRemote(api.get(draft.id)); } catch (error) { report(error); } }}>比较两个版本</Button><Button block onClick={() => { try { const copy = api.create(`${draft.title}（副本）`, draft.document.note); openDraft(copy); setNotice({ kind: "success", text: "已另存为演示副本，原项目的另一版本未被覆盖。" }); } catch (error) { report(error); } }}>另存为演示副本</Button></div>}
                            <div className="preview-inspector-foot"><ShieldCheck size={18} /><p>本页仅验证交互和文案。真实账户隔离、邮件、限流和云保存需后续独立联调。</p></div>
                        </aside></div>
                </section>}
            </main>
        </div>
        <Modal title="新建演示画布" open={createOpen} onCancel={() => setCreateOpen(false)} okText="创建并打开" cancelText="取消" onOk={() => {
            try { const item = api.create(newTitle); setCreateOpen(false); openDraft(item); setProjects(api.list()); }
            catch (error) { setCreateError(error instanceof PreviewError ? error.message : "创建未完成"); }
        }}><p>仅创建本页内存里的文本草稿，刷新会清空。</p><label htmlFor="new-title">画布名称</label><Input id="new-title" value={newTitle} onChange={(event) => setNewTitle(event.target.value)} />{createError && <p role="alert">{createError}</p>}</Modal>
        <Modal title="比较版本 · 不会自动覆盖" open={!!remote} onCancel={() => setRemote(null)} footer={<Button onClick={() => setRemote(null)}>保留我的修改，继续编辑</Button>}>
            <h3>我的未保存内容</h3><pre className="preview-comparison">{draft?.document.note}</pre><h3>另一窗口的已保存内容</h3><pre className="preview-comparison">{remote?.document.note}</pre><p>当前预览提供保留编辑和另存副本。合并/覆盖的正式交互待你确认后接入。</p>
        </Modal>
    </>;
}

function PreviewRoot() {
    const [dark, setDark] = useState(false);
    const theme = previewTheme(dark);
    return <ConfigProvider locale={zhCN} theme={theme.config}><App><div className="saas-preview" style={theme.style}><Workspace dark={dark} toggleTheme={() => setDark((value) => !value)} /></div></App></ConfigProvider>;
}
export function mountPreview() { createRoot(document.getElementById("root")!).render(<PreviewRoot />); }
