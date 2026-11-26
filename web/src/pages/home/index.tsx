import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, App, Button, Input, Modal, Select } from "@/components/creation/ui";
import { ArrowUpRight, AudioLines, Bot, History, Image, PencilLine, Video } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import localforage from "localforage";

import { CreationAgentComposer } from "@/components/creation/creation-agent-composer";
import { CreationModeTabs, type CreationKind } from "@/components/creation/creation-mode-tabs";
import { CreationLandingContext, CreationWorkbench } from "@/components/creation/creation-workbench";
import { WorkspaceFeedback, WorkspaceHeading, workspaceAction } from "@/components/creation/workspace-feedback";
import { Button as WorkspaceButton } from "@/components/ui/button";
import { createCreationShortcutRegistry } from "@/components/creation/creation-shortcut-target";
import { CreationShortcutTargetContext } from "@/components/creation/creation-shortcut-target-context";
import { RequireAccount } from "@/components/account/require-account";
import ImagePage from "@/pages/image";
import VideoPage from "@/pages/video";
import AudioPage from "@/pages/audio";
import { creationModeFromSearch, creationModeTarget } from "@/lib/creation-routes";
import { applyCreationMediaInspiration, useCreationMediaLaunch } from "@/stores/use-creation-media-launch";
import { applyCreationAgentInspiration } from "@/stores/use-creation-agent-launch";
import { useAccountStore } from "@/stores/use-account-store";
import { accountReturnPath } from "@/services/saas/account-navigation";
import { applyPreparedInspiration, prepareInspirationDraft, readInspirationDraftIntent, type PreparedInspiration } from "./inspiration-draft-handoff";

type Shortcut = { title: string; kind: CreationKind; prompt: string };
const kinds = [{ value: "agent", label: "Agent" }, { value: "image", label: "图片" }, { value: "video", label: "视频" }, { value: "audio", label: "音频" }];
const icons = { agent: Bot, image: Image, video: Video, audio: AudioLines };
const defaults: Shortcut[] = [
    { title: "梳理创作企划", kind: "agent", prompt: "帮我梳理一个创作企划：先明确目标、受众与风格，再给出可执行的步骤。" },
    { title: "设计产品海报", kind: "image", prompt: "设计一张产品主题海报，突出主体，留出简洁的标题区域，使用协调的配色。" },
    { title: "构思短片镜头", kind: "video", prompt: "一个自然光下的产品特写镜头，画面简洁，镜头缓慢推进。" },
    { title: "录制欢迎语", kind: "audio", prompt: "欢迎来到我们的创作空间。让我们从一个想法开始，把灵感变成作品。" },
];
const modeDefaults: Record<CreationKind, Shortcut[]> = {
    image: [
        { title: "产品海报", kind: "image", prompt: defaults[1].prompt },
        { title: "人物肖像", kind: "image", prompt: "自然光下的人物半身肖像，表情自然，背景简洁，保留真实的皮肤质感。" },
        { title: "自然风景", kind: "image", prompt: "清晨的山间湖泊，薄雾贴近水面，远山层次清晰，色彩柔和。" },
        { title: "空间概念", kind: "image", prompt: "一间采光充足的阅读空间，木质家具、绿植与简洁陈设，构图安静有序。" },
    ],
    video: [
        { title: "产品推进镜头", kind: "video", prompt: defaults[2].prompt },
        { title: "风景横移", kind: "video", prompt: "镜头沿湖岸缓慢横移，水面轻轻起伏，远山在晨雾中逐渐显现。" },
        { title: "人物动作", kind: "video", prompt: "人物在窗边翻开一本书，动作自然，柔和光线照亮手部和书页。" },
        { title: "场景转场", kind: "video", prompt: "镜头从门外缓慢进入一间明亮的工作室，视线从门框过渡到桌面的创作工具。" },
    ],
    audio: [
        { title: "欢迎语", kind: "audio", prompt: defaults[3].prompt },
        { title: "产品讲解", kind: "audio", prompt: "这款产品用简洁的设计解决日常需求。接下来，我们一起了解它的使用方法。" },
        { title: "通知播报", kind: "audio", prompt: "各位好，今天的活动即将开始。请确认设备已经就绪，并按指引进入会场。" },
        { title: "短篇旁白", kind: "audio", prompt: "清晨，阳光穿过窗帘落在桌面上。他翻开笔记本，写下今天的第一个想法。" },
    ],
    agent: [
        { title: "企划拆解", kind: "agent", prompt: defaults[0].prompt },
        { title: "需求澄清", kind: "agent", prompt: "我想开始一项创作。请先询问目标、使用场景和限制，再整理需要确认的需求。" },
        { title: "提示词整理", kind: "agent", prompt: "帮我把一个画面想法整理成清楚的提示词，分别说明主体、场景、光线和构图。" },
        { title: "创作步骤", kind: "agent", prompt: "帮我制定从灵感到交付的创作步骤，列出每一步所需材料和需要我确认的事项。" },
    ],
};
const selectModeShortcuts = (items: Shortcut[], kind: CreationKind): Shortcut[] => {
    const matching = items.filter(item => item.kind === kind), configured = new Set(matching.map(item => `${item.kind}:${item.prompt}`));
    return [...matching, ...modeDefaults[kind].filter(item => !configured.has(`${item.kind}:${item.prompt}`))].slice(0, 4);
};
const shortcutStorage = localforage.createInstance({ name: "infinite-canvas", storeName: "creation_shortcuts" });
const validShortcuts = (value: unknown): value is Shortcut[] => Array.isArray(value) && value.length === defaults.length && value.every((item) => item && typeof item.title === "string" && typeof item.prompt === "string" && kinds.some((kind) => kind.value === item.kind));
const inspirationDrafts = { store: useCreationMediaLaunch, getScope: () => useAccountStore.getState().getDraftScope() };
const mediaKindName = { image: "图片", video: "视频", audio: "音频" };

export default function IndexPage() {
    const { t } = useTranslation(), { message } = App.useApp();
    const location = useLocation(), navigate = useNavigate();
    const locationRef = useRef(location), live = useRef(false); locationRef.current = location;
    useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
    const incoming = useMemo(() => readInspirationDraftIntent(location.search), [location.search]);
    const account = useAccountStore(), scope = account.getDraftScope();
    const scopeKey = scope ? JSON.stringify([scope.accountId, scope.epoch]) : null;
    const active = creationModeFromSearch(location.search);
    const changeMode = (kind: CreationKind) => navigate(creationModeTarget(kind, location), { state: location.state });
    const modeTabs = <CreationModeTabs value={active} onChange={changeMode} />;
    const [shortcuts, setShortcuts] = useState<Shortcut[] | null>(null), [editing, setEditing] = useState<Shortcut[] | null>(null);
    const [shortcutScope, setShortcutScope] = useState<string | null>(null);
    const [loading, setLoading] = useState(true), [saving, setSaving] = useState(false), [storageError, setStorageError] = useState("");
    const request = useRef(0);
    const handoffVersion = useRef(0), applyingRef = useRef(false);
    const [prepared, setPrepared] = useState<PreparedInspiration | null>(null), [handoffNotice, setHandoffNotice] = useState("");
    const [handoffLoading, setHandoffLoading] = useState(false), [handoffApplying, setHandoffApplying] = useState(false);
    const visiblePrepared = incoming.intent && prepared && scope && scope.accountId === prepared.scope.accountId && scope.epoch === prepared.scope.epoch && prepared.kind === incoming.intent.kind && prepared.prompt === incoming.intent.prompt ? prepared : null;
    const visibleShortcuts = shortcutScope === scopeKey ? shortcuts ?? defaults : defaults;
    const modeShortcuts = selectModeShortcuts(shortcutScope === scopeKey ? shortcuts ?? [] : [], active);
    const [shortcutTargets] = useState(() => createCreationShortcutRegistry({ getScope: () => useAccountStore.getState().getDraftScope(), getDraftState: useCreationMediaLaunch.getState }));
    const prepareIncoming = async () => {
        const version = ++handoffVersion.current;
        setPrepared(null); setHandoffNotice(""); setHandoffLoading(false);
        if (!incoming.intent || !scope) return;
        setHandoffLoading(true);
        const next = await prepareInspirationDraft(incoming.intent, inspirationDrafts);
        if (version !== handoffVersion.current) return;
        setPrepared(next); setHandoffLoading(false);
        if (!next) setHandoffNotice("草稿或账号尚未就绪，没有替换当前内容。请确认账户与本机存储后重新核对。");
    };
    useEffect(() => {
        void prepareIncoming();
        return () => { ++handoffVersion.current; };
    }, [incoming.intent, scopeKey]);
    const clearIncoming = () => {
        ++handoffVersion.current;
        setPrepared(null); setHandoffNotice(""); setHandoffLoading(false);
        const target = creationModeTarget(incoming.intent?.kind ?? active, location);
        const query = new URLSearchParams(target.search); query.delete("prompt");
        navigate({ ...target, search: `?${query}` }, { replace: true, state: location.state });
    };
    const confirmIncoming = async () => {
        if (!visiblePrepared || applyingRef.current) return;
        const version = handoffVersion.current, confirmation = visiblePrepared;
        applyingRef.current = true; setHandoffApplying(true);
        try {
            const result = await applyPreparedInspiration(confirmation, inspirationDrafts);
            if (version !== handoffVersion.current) return;
            if (result === "changed") { setPrepared(null); setHandoffNotice("草稿或账号已变化，没有替换当前内容。请重新核对后再决定。"); return; }
            clearIncoming();
            if (result === "applied") message.success("灵感已填入草稿。请核对参数后自行提交生成。");
            else message.error("灵感已填入当前输入，但本机保存未完成；请保留此页并检查草稿状态。");
        } finally { applyingRef.current = false; setHandoffApplying(false); }
    };
    useEffect(() => {
        const sequence = ++request.current;
        setShortcutScope(scopeKey); setShortcuts(null); setEditing(null); setStorageError(""); setSaving(false); setLoading(Boolean(scope));
        if (!scope) return;
        void shortcutStorage.getItem<unknown>(scope.accountId).then((value) => {
            if (sequence !== request.current) return;
            if (value !== null && !validShortcuts(value)) { setStorageError("灵感捷径暂时无法读取，已显示默认内容；保存前请检查配置。"); return; }
            if (value) setShortcuts(value as Shortcut[]);
        }).catch(() => { if (sequence === request.current) setStorageError("灵感捷径读取失败，已显示默认内容。可以稍后重新打开首页。"); })
            .finally(() => { if (sequence === request.current) setLoading(false); });
        return () => { ++request.current; };
    }, [scopeKey]);

    const saveShortcuts = async () => {
        const current = useAccountStore.getState().getDraftScope(), sequence = request.current;
        if (!editing || !current || !scope || current.accountId !== scope.accountId || current.epoch !== scope.epoch || saving) return;
        if (editing.some((item) => !item.title.trim() || !item.prompt.trim())) { message.warning("请填写每个捷径的名称和提示词。"); return; }
        const next = editing.map((item) => ({ ...item, title: item.title.trim(), prompt: item.prompt.trim() }));
        setSaving(true);
        try {
            await shortcutStorage.setItem(current.accountId, next);
            if (sequence !== request.current) return;
            setShortcuts(next); setEditing(null); setStorageError(""); message.success("灵感捷径已保存到本机。");
        } catch { if (sequence === request.current) message.error("保存未完成，配置内容已保留，请重试。"); }
        finally { if (sequence === request.current) setSaving(false); }
    };
    const applyShortcut = async (item: Shortcut) => {
        const current = useAccountStore.getState().getDraftScope();
        if (!current) { message.info("请先通过左下角账户入口登录，再使用灵感捷径。"); return; }
        const origin = locationRef.current;
        const target = item.kind === "agent" ? null : shortcutTargets.capture(item.kind);
        if (target?.status === "blocked") { message.info("当前草稿尚未就绪或任务仍在处理中，请稍后再填入灵感。"); return; }
        const applied = item.kind === "agent" ? await applyCreationAgentInspiration(item.prompt) : await applyCreationMediaInspiration(item.kind, item.prompt);
        if (!live.current || locationRef.current !== origin) return;
        const latest = useAccountStore.getState().getDraftScope();
        if (!latest || latest.accountId !== current.accountId || latest.epoch !== current.epoch) return;
        if (applied && (!target || target.status === "absent" || target.status === "captured" && target.apply(item.prompt))) changeMode(item.kind);
        else message.info("草稿尚未就绪或已被编辑，灵感内容没有覆盖当前输入，请重试。");
    };

    const heading = <WorkspaceHeading id="creation-workspace-title" title={t(`creationWorkspace.titles.${active}`)} action={
        <WorkspaceButton asChild variant="outline" className={workspaceAction}><Link to={active === "image" ? "/generation/history?view=conversations" : "/generation/history"}><History aria-hidden="true" />{t("generationHistory.title")}</Link></WorkspaceButton>
    } />;
    const shortcutsPanel = <section aria-label="创作灵感" className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-end gap-2">
            <Link to="/inspiration" className="flex items-center gap-1 py-1 text-xs text-muted-foreground hover:text-primary">探索灵感<ArrowUpRight className="size-3.5" /></Link>
            <Button type="text" size="small" aria-label="配置灵感捷径" disabled={!scope || loading || shortcutScope !== scopeKey} icon={<PencilLine className="size-3.5" />} onClick={() => setEditing(visibleShortcuts.map((item) => ({ ...item })))}>配置捷径</Button>
        </div>
        <div aria-label="灵感捷径" className="grid min-w-0 grid-cols-2 gap-3 sm:grid-cols-4">
            {modeShortcuts.map((item, index) => { const Icon = icons[item.kind]; return <button type="button" key={`${active}:${index}`} onClick={() => void applyShortcut(item)} title={item.prompt} className="flex min-h-[84px] min-w-0 items-center gap-2.5 rounded-xl border border-border bg-card p-3 text-left transition-colors hover:border-primary"><span className="flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-accent text-primary"><Icon className="size-[18px]" /></span><span className="min-w-0"><strong className="block break-words text-[13px] font-medium">{item.title}</strong><span className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{item.prompt}</span></span></button>; })}
        </div>
        {storageError ? <WorkspaceFeedback state="error">{storageError}</WorkspaceFeedback> : null}
    </section>;

    return <CreationShortcutTargetContext value={shortcutTargets}><CreationLandingContext value={{ heading, shortcuts: shortcutsPanel }}><div className="flex h-full min-h-0 flex-col bg-background">
        {incoming.invalid ? <Alert className="m-3 shrink-0" type="warning" showIcon title="灵感链接不完整或模式无效，当前草稿未修改。" action={<Button size="small" onClick={clearIncoming}>忽略链接</Button>} /> : null}
        <div className="min-h-0 flex-1">
        {active === "agent" ? <CreationWorkbench kind="agent" hasContent={false} composer={<CreationAgentComposer modeTabs={modeTabs} />} /> : incoming.intent ? <div role="status" className="p-5 text-sm text-muted-foreground">请先选择保留现有草稿或填入灵感提示词。</div> : <RequireAccount>{active === "image" ? <ImagePage modeTabs={modeTabs} /> : active === "video" ? <VideoPage modeTabs={modeTabs} /> : <AudioPage modeTabs={modeTabs} />}</RequireAccount>}
        </div>
        <Modal title={incoming.intent ? `填入${mediaKindName[incoming.intent.kind]}灵感` : "填入灵感"} open={Boolean(incoming.intent)} onCancel={() => { if (!handoffApplying) clearIncoming(); }} closable={!handoffApplying} mask={{ closable: !handoffApplying }} keyboard={!handoffApplying} destroyOnHidden
            footer={<div className="flex flex-wrap justify-end gap-2"><Button disabled={handoffApplying} onClick={clearIncoming}>保留现有草稿</Button>{!scope ? <Button type="primary" disabled={account.status !== "ready" || account.busy} onClick={() => navigate("/login", { state: { from: accountReturnPath(location.pathname, location.search, location.hash) } })}>登录后选择</Button> : visiblePrepared ? <Button type="primary" loading={handoffApplying} disabled={handoffLoading} onClick={() => void confirmIncoming()}>{visiblePrepared.existingPrompt.trim() || visiblePrepared.referenceCount ? "替换提示词" : "填入提示词"}</Button> : <Button type="primary" loading={handoffLoading} disabled={handoffApplying} onClick={() => void prepareIncoming()}>重新核对草稿</Button>}</div>}
            modalRender={(node) => <div data-canvas-shortcuts-ignore>{node}</div>}>
            <p className="mb-3 text-sm text-muted-foreground">仅替换所选模式的提示词，原参考素材和生成参数保留。不会自动生成或确认费用。</p>
            <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/40 p-3 text-sm" aria-label="待填入的灵感提示词">{incoming.intent?.prompt}</div>
            {!scope ? <p role="status" className="mt-3 text-sm text-muted-foreground">请先登录并确认账户，当前草稿未修改。登录返回后仍需明确选择。</p> : handoffLoading ? <p role="status" className="mt-3 text-sm text-muted-foreground">正在读取当前账户的本机草稿…</p> : visiblePrepared ? <div className="mt-4 text-sm"><p className="mb-2 font-medium">{visiblePrepared.existingPrompt.trim() || visiblePrepared.referenceCount ? `当前已有${mediaKindName[visiblePrepared.kind]}草稿（${visiblePrepared.referenceCount} 个参考素材）` : "当前模式没有提示词"}</p>{visiblePrepared.existingPrompt ? <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-border p-3 text-muted-foreground" aria-label="现有草稿提示词">{visiblePrepared.existingPrompt}</div> : null}</div> : null}
            {handoffNotice ? <p role="status" className="mt-3 text-sm text-muted-foreground">{handoffNotice}</p> : null}
        </Modal>
        <Modal title="配置灵感捷径" open={Boolean(editing) && shortcutScope === scopeKey} onCancel={() => { if (!saving) setEditing(null); }} onOk={() => void saveShortcuts()} confirmLoading={saving} okText="保存到本机" cancelText="取消" mask={{ closable: !saving }} width={640} destroyOnHidden modalRender={(node) => <div data-canvas-shortcuts-ignore>{node}</div>}>
            <p className="text-sm text-muted-foreground">这里编辑已保存的四条捷径，按对应模式优先展示；不足四条时由本地内置预设补足，其他模式配置保留。内置预设不是管理员发布内容。</p>
            <div className="space-y-5 py-2">{editing?.map((item, index) => <div key={index} className="space-y-2"><div className="flex gap-2"><Input aria-label={`捷径 ${index + 1} 名称`} value={item.title} disabled={saving} onChange={(event) => setEditing((rows) => rows?.map((row, i) => i === index ? { ...row, title: event.target.value } : row) ?? null)} /><Select aria-label={`捷径 ${index + 1} 创作方式`} value={item.kind} disabled={saving} options={kinds} onChange={(kind: CreationKind) => setEditing((rows) => rows?.map((row, i) => i === index ? { ...row, kind } : row) ?? null)} className="w-28 shrink-0" /></div><Input.TextArea aria-label={`捷径 ${index + 1} 提示词`} value={item.prompt} disabled={saving} autoSize={{ minRows: 2 }} onChange={(event) => setEditing((rows) => rows?.map((row, i) => i === index ? { ...row, prompt: event.target.value } : row) ?? null)} /></div>)}</div>
        </Modal>
    </div></CreationLandingContext></CreationShortcutTargetContext>;
}
