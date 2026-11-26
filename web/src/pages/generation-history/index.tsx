import { useEffect, useRef, useState } from "react";
import { AudioLines, ChevronLeft, ChevronRight, CircleAlert, CircleCheck, CircleHelp, Clock3, Download, ExternalLink, FileText, Image as ImageIcon, Loader2, Pencil, Plus, RefreshCw, Search, TriangleAlert, Video, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import dayjs from "dayjs";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { creationPath, historyCreationTarget, imageConversationPath } from "@/lib/creation-routes";
import { WorkspaceFeedback, WorkspaceHeading, workspaceAction } from "@/components/creation/workspace-feedback";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { historyOriginTarget, historyTitleSchema, parseHistoryReturnQuery, type HistoryDetail } from "@/services/saas/generation-history-detail";

import { useAccountStore } from "@/stores/use-account-store";
import { generationTrackingPresentation } from "@/stores/use-generation-tracker";
import type { GenerationHistoryItem, GenerationHistoryQuery, GenerationHistoryScope } from "@/services/saas/generation-history";
import { createHistoryReader, historyImageIds, initialHistoryState, type HistoryPreview, type HistoryState } from "./history-reader";
import { readImageConversations, subscribeImageConversations } from "@/pages/image/image-conversations";

const types = ["all", "image", "video", "audio", "text"] as const;
const executions = ["all", "succeeded", "failed", "running", "queued", "pending"] as const;
const icons = { image: ImageIcon, video: Video, audio: AudioLines, text: FileText, unknown: CircleHelp };

export default function GenerationHistoryPage() {
    const { t } = useTranslation();
    const account = useAccountStore(), scope = account.getDraftScope();
    const location = useLocation();
    const conversations = new URLSearchParams(location.search).get("view") === "conversations";
    return <section aria-labelledby="generation-history-title" className="h-full min-h-0 min-w-0 overflow-y-auto p-4 text-foreground md:p-6">
        <div className="mx-auto flex w-full max-w-[1076px] flex-col gap-4">
            <WorkspaceHeading id="generation-history-title" title={t("generationHistory.title")} description={conversations ? "本机图片创作对话" : t("generationHistory.description")} action={
                <Button asChild variant="outline" className={workspaceAction}><Link to={creationPath("image")}><Plus aria-hidden="true" />{t("creationWorkspace.goToCreation")}</Link></Button>
            } />
            <nav aria-label="历史记录视图" className="flex flex-wrap gap-2">
                <Button asChild variant={conversations ? "secondary" : "outline"}><Link aria-current={conversations ? "page" : undefined} to="/generation/history?view=conversations">图片对话</Link></Button>
                <Button asChild variant={conversations ? "outline" : "secondary"}><Link aria-current={conversations ? undefined : "page"} to="/generation/history">生成任务</Link></Button>
            </nav>
            {account.busy || account.status === "loading" || account.status === "idle"
                ? <WorkspaceFeedback state="loading">{t("generationHistory.accountLoading")}</WorkspaceFeedback>
                : account.status !== "ready" ? <WorkspaceFeedback state="error">{t("generationHistory.accountUnavailable")}</WorkspaceFeedback>
                    : !scope ? <WorkspaceFeedback state="empty">{t("generationHistory.signInRequired")}</WorkspaceFeedback>
                        : conversations ? <ImageConversationHistory key={`${scope.accountId}:${scope.epoch}`} scope={scope} />
                            : <HistoryWorkbench key={`${scope.accountId}:${scope.epoch}`} scope={scope} />}
        </div>
    </section>;
}

function ImageConversationHistory({ scope }: { scope: GenerationHistoryScope }) {
    const [items, setItems] = useState<Awaited<ReturnType<typeof readImageConversations>>>();
    const [error, setError] = useState(false);
    const [readVersion, setReadVersion] = useState(0);
    useEffect(() => {
        let active = true;
        const current = () => {
            const owner = useAccountStore.getState().getDraftScope();
            return active && owner?.accountId === scope.accountId && owner.epoch === scope.epoch;
        };
        setError(false);
        void readImageConversations(scope).then(items => { if (current()) setItems(items); }, () => { if (current()) setError(true); });
        const unsubscribe = subscribeImageConversations(() => setReadVersion(value => value + 1));
        return () => { active = false; unsubscribe(); };
    }, [scope.accountId, scope.epoch, readVersion]);
    if (error) return <WorkspaceFeedback state="error" action={<Button variant="outline" onClick={() => setReadVersion(value => value + 1)}><RefreshCw />重新读取</Button>}>图片对话读取失败</WorkspaceFeedback>;
    if (!items) return <WorkspaceFeedback state="loading">正在读取图片对话…</WorkspaceFeedback>;
    if (!items.length) return <WorkspaceFeedback state="empty">暂无图片对话</WorkspaceFeedback>;
    return <ul aria-label="图片对话记录" className="divide-y rounded-lg border bg-card">
        {items.map(item => <li key={item.id}>
            <Link to={imageConversationPath(item.id)} className="flex min-w-0 items-center gap-3 px-4 py-3 hover:bg-muted/50">
                <ImageIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.title}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{item.turns} 轮 · {dayjs(item.updatedAt).format("YYYY-MM-DD HH:mm")}</span>
                </span>
                <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            </Link>
        </li>)}
    </ul>;
}

function HistoryWorkbench({ scope }: { scope: GenerationHistoryScope }) {
    const navigate = useNavigate(), location = useLocation();
    const [state, setState] = useState(initialHistoryState);
    const reader = useRef<ReturnType<typeof createHistoryReader> | null>(null);
    useEffect(() => {
        const instance = createHistoryReader({ scope, getScope: () => useAccountStore.getState().getDraftScope(), onState: setState });
        reader.current = instance;
        const unsubscribe = useAccountStore.subscribe(() => instance.syncScope());
        void instance.read(parseHistoryReturnQuery(location.state?.generationHistoryQuery));
        return () => { unsubscribe(); instance.dispose(); reader.current = null; };
    }, [scope.accountId, scope.epoch, location.key]);
    return <GenerationHistoryContent state={state} onDetail={(id) => { void reader.current?.detail(id); }} onCloseDetail={() => reader.current?.closeDetail()} onOpenOrigin={(detail) => {
        const current = useAccountStore.getState().getDraftScope(), canvas = useCanvasStore.getState();
        const target = canvas.hydrated && historyOriginTarget(detail, canvas.projects.map(project => project.id));
        if (target && current?.accountId === scope.accountId && current.epoch === scope.epoch) navigate(target);
    }} onRead={(query) => { void reader.current?.read(query); }} onPreview={(id, imageId) => { void reader.current?.preview(id, imageId); }} onPreviewError={(id, url) => reader.current?.previewFailed(id, url)}
        onRename={async (id, title) => await reader.current?.rename(id, title) ?? false} onOpenWorkbench={(row) => {
        const target = historyCreationTarget(row.type);
        if (target && useAccountStore.getState().getDraftScope()?.accountId === scope.accountId && useAccountStore.getState().getDraftScope()?.epoch === scope.epoch) navigate(target, { state: { fromGenerationHistory: { taskId: row.taskId, type: row.type, query: state.query } } });
    }} />;
}

type PreviewActions = { onPreview: (taskId: string, imageId?: string) => void; onPreviewError: (taskId: string, url?: string) => void };

/** Real page content, shared with its SSR tests; no alternate fixture page. */
export function GenerationHistoryContent({ state, onRead, onPreview, onPreviewError, onRename, onOpenWorkbench, onDetail, onCloseDetail, onOpenOrigin }: PreviewActions & {
    state: HistoryState; onRead: (query: GenerationHistoryQuery) => void; onRename?: (taskId: string, title: string) => Promise<boolean>;
    onOpenWorkbench?: (item: GenerationHistoryItem) => void;
    onDetail?: (taskId: string) => void; onCloseDetail?: () => void; onOpenOrigin?: (detail: HistoryDetail) => void;
}) {
    const { t } = useTranslation();
    const { query } = state;
    const [search, setSearch] = useState(query.search ?? "");
    useEffect(() => { setSearch(query.search ?? ""); }, [query.search]);
    const [rename, setRename] = useState<{ row: GenerationHistoryItem; title: string; saving?: boolean; failed?: boolean }>();
    const openRename = onRename ? (row: GenerationHistoryItem) => setRename({ row, title: row.title ?? "" }) : undefined;
    const filtered = Boolean(query.type || query.status || query.search);
    const loading = state.phase === "loading", blocked = state.error === "accountChanged";
    const page = query.pageNumber ?? 1, lastPage = Math.max(1, Math.ceil(state.total / 50));
    const pages = [...new Set([1, ...Array.from({ length: 5 }, (_, index) => page + index - 2), lastPage])].filter((value) => value > 0 && value <= lastPage).sort((a, b) => a - b);
    const headers = ["type", "model", "status", "credits", "createdAt", "result"] as const;
    return <Tabs value={query.type ?? "all"} onValueChange={(key) => onRead({ ...query, pageNumber: 1, type: key === "all" ? undefined : key as GenerationHistoryQuery["type"] })} className="min-w-0 gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
            <TabsList aria-label="创作类型" className="h-11! w-full sm:w-auto">
                {types.map((type) => <TabsTrigger key={type} value={type} className="min-h-10 px-3" disabled={blocked}>{t(`generationHistory.types.${type}`)}</TabsTrigger>)}
            </TabsList>
            <div className="flex w-full items-center justify-between gap-2 sm:w-auto">
                <Select value={query.status ?? "all"} disabled={blocked} onValueChange={(value) => onRead({ ...query, pageNumber: 1, status: value === "all" ? undefined : value as GenerationHistoryQuery["status"] })}>
                    <SelectTrigger aria-label={t("generationHistory.filterStatus")} className="h-11 w-40 max-w-full"><SelectValue>{t(`generationHistory.execution.${query.status ?? "all"}`)}</SelectValue></SelectTrigger>
                    <SelectContent position="popper" align="end">{executions.map((value) => <SelectItem key={value} value={value} className="min-h-11">{t(`generationHistory.execution.${value}`)}</SelectItem>)}</SelectContent>
                </Select>
                <Button variant="outline" className="h-11" disabled={blocked || loading} aria-busy={loading} onClick={() => onRead(query)}><RefreshCw aria-hidden="true" className={loading ? "size-4 animate-spin motion-reduce:animate-none" : "size-4"} />{t("generationHistory.refresh")}</Button>
            </div>
        </div>
        <form role="search" aria-label={t("generationHistory.search")} className="flex w-full max-w-md min-w-0 items-center gap-2" onSubmit={event => {
            event.preventDefault();
            if (!blocked && (!search.trim() || historyTitleSchema.safeParse(search).success)) onRead({ ...query, pageNumber: 1, search: search.trim() || undefined });
        }}>
            <Input type="search" aria-label={t("generationHistory.searchLabel")} placeholder={t("generationHistory.searchLabel")} value={search}
                disabled={blocked} className="h-11 min-w-0 flex-1" onChange={event => setSearch(event.target.value)} />
            <Button type="submit" variant="outline" className="h-11" disabled={blocked || Boolean(search.trim() && !historyTitleSchema.safeParse(search).success)}><Search aria-hidden="true" />{t("generationHistory.search")}</Button>
            {query.search ? <Button type="button" variant="ghost" size="icon" className="size-11" aria-label={t("generationHistory.clearSearch")} disabled={blocked}
                onClick={() => { setSearch(""); onRead({ ...query, pageNumber: 1, search: undefined }); }}><X aria-hidden="true" /></Button> : null}
        </form>
        <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
            <p>{t("generationHistory.executionFilterNote")} {t("generationHistory.pageSizeDescription")}</p>
            <p>{t("generationHistory.creditsExplanation")}</p>
            {onOpenWorkbench ? <p>返回创作只打开对应类型的工作台，原任务请在日志或回执中核对；不会新建生成。</p> : null}
        </div>
        {types.map((type) => <TabsContent key={type} value={type} className="min-w-0 space-y-4">{type === (query.type ?? "all") ? <>
            {state.error ? <WorkspaceFeedback state="error" description={state.items.length ? t("generationHistory.retainedRows") : undefined}
                action={!blocked ? <Button variant="outline" className={workspaceAction} disabled={loading} onClick={() => onRead(query)}><RefreshCw aria-hidden="true" />{t("generationHistory.retry")}</Button> : null}>
                {t(`generationHistory.${state.error}`)}
            </WorkspaceFeedback> : null}
            {loading ? <WorkspaceFeedback state="loading">{t("generationHistory.loading")}</WorkspaceFeedback> : null}
            {state.items.length ? <>
            <div role="region" aria-label="创作历史记录，可横向滚动查看全部列" tabIndex={0} className="hidden max-w-full overflow-x-auto rounded-xl border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring md:block">
                <table className="w-full min-w-[960px] table-fixed text-left text-sm [&_td]:px-3 [&_td]:py-3 [&_th]:px-3">
                    <caption className="sr-only">{t("generationHistory.title")}，{t("generationHistory.pageSizeDescription")}</caption>
                    <thead className="border-b bg-muted/50 text-xs text-muted-foreground"><tr>
                        {headers.map((key) => <th key={key} scope="col" className={`px-3 py-3 font-medium ${key === "status" ? "w-60" : key === "model" ? "w-40" : key === "createdAt" || key === "result" ? "w-32" : key === "credits" ? "w-28" : "w-24"}`}>{t(`generationHistory.columns.${key}`)}</th>)}
                        {onOpenWorkbench ? <th scope="col" className="w-32 px-3 py-3 font-medium">创作入口</th> : null}
                    </tr></thead>
                    <tbody className="divide-y">{state.items.map((row) => {
                        const type = row.type ?? "unknown", Icon = icons[type], presentation = generationTrackingPresentation(row), preview = state.previews[row.taskId];
                        const StatusIcon = presentation.level === "success" ? CircleCheck : presentation.level === "warning" ? TriangleAlert : presentation.level === "error" ? CircleAlert : Clock3;
                        // Reuse the existing provider's semantic theme variables; no page palette.
                        const tone = presentation.level === "success" ? "border-[var(--ant-color-success-border)] bg-[var(--ant-color-success-bg)] text-[var(--ant-color-success-text)]"
                            : presentation.level === "warning" ? "border-[var(--ant-color-warning-border)] bg-[var(--ant-color-warning-bg)] text-[var(--ant-color-warning-text)]" : "";
                        return <tr key={row.taskId} data-row-key={row.taskId} className="align-top transition-colors hover:bg-muted/40">
                            <td className="px-4 py-4"><span className="inline-flex items-center gap-2"><Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />{t(`generationHistory.types.${type}`)}</span></td>
                            <th scope="row" className="break-all px-4 py-4 font-medium"><HistoryRecordName row={row} disabled={state.phase !== "ready" || blocked} onDetail={onDetail} onRename={openRename} /></th>
                            <td className="space-y-2 px-4 py-4"><Badge variant={presentation.level === "error" ? "destructive" : "outline"} data-status-level={presentation.level} title={presentation.description} className={`h-auto min-h-6 gap-1.5 whitespace-normal ${tone}`}><StatusIcon aria-hidden="true" />{presentation.title}</Badge>
                                <p className="text-xs leading-relaxed text-muted-foreground">{t("generationHistory.statusSummary", { execution: t(`generationHistory.execution.${row.executionStatus}`), delivery: t(`generationHistory.delivery.${row.deliveryStatus}`), billing: t(`generationHistory.billing.${row.billingStatus}`) })}</p></td>
                            <td className="break-all px-4 py-4 tabular-nums">{row.credits === null ? t("generationHistory.unverified") : t("generationHistory.creditsValue", { credits: row.credits })}</td>
                            <td className="px-4 py-4 text-xs leading-relaxed text-muted-foreground"><time dateTime={row.createdAt}>{dayjs(row.createdAt).format("YYYY-MM-DD HH:mm:ss")}</time></td>
                            <td className="px-4 py-3">{!row.result ? <span className="text-xs text-muted-foreground">{t("generationHistory.noResult")}</span>
                                : row.type !== "image" ? <span className="text-xs text-muted-foreground">{t("generationHistory.savedResult")}</span>
                                    : preview?.status === "ready" && preview.url?.startsWith("blob:") ? <HistoryImagePreview row={row} preview={preview} onPreviewError={onPreviewError} />
                                        : <div>{preview?.status === "error" ? <p className="text-xs text-muted-foreground">{t("generationHistory.previewFailed")}</p> : null}
                                            <Button variant="ghost" className="h-11 px-2" disabled={loading || preview?.status === "loading"} aria-busy={preview?.status === "loading"} onClick={() => onPreview(row.taskId)}>{preview?.status === "loading" ? <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : null}{t(`generationHistory.${preview?.status === "error" ? "retryPreview" : preview?.status === "loading" ? "previewLoading" : "preview"}`)}</Button></div>}</td>
                            {onOpenWorkbench ? <td className="px-4 py-3">{historyCreationTarget(row.type) ? <Button variant="link" className="h-11 px-0" onClick={() => onOpenWorkbench(row)}>返回{t(`generationHistory.types.${row.type}`)}创作</Button> : <span className="text-xs text-muted-foreground">暂无原工作台定位信息</span>}</td> : null}
                        </tr>;
                    })}</tbody>
                </table>
            </div>
            <div className="space-y-3 md:hidden" aria-label="创作历史记录列表">
                {state.items.map((row) => <HistoryMobileRow key={row.taskId} row={row} state={state} loading={loading} blocked={blocked} onPreview={onPreview} onPreviewError={onPreviewError} onDetail={onDetail} onRename={openRename} onOpenWorkbench={onOpenWorkbench} />)}
            </div>
            </> : state.phase === "ready" ? <WorkspaceFeedback state="empty">{t(`generationHistory.${state.total > 0 ? "emptyPage" : filtered ? "filteredEmpty" : "empty"}`)}</WorkspaceFeedback> : null}
            <nav aria-label="创作历史分页" className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">{t("generationHistory.total", { total: state.total })}</p>
                <ul className="flex flex-wrap items-center gap-1">
                    <li><Button variant="outline" size="icon" className="size-11" aria-label="上一页" disabled={loading || blocked || page <= 1} onClick={() => onRead({ ...query, pageNumber: page - 1 })}><ChevronLeft aria-hidden="true" /></Button></li>
                    {pages.map((number, index) => <li key={number} className="flex items-center gap-1">
                        {index > 0 && number - pages[index - 1]! > 1 ? <span aria-hidden="true" className="px-1 text-muted-foreground">…</span> : null}
                        <Button variant={number === page ? "secondary" : "ghost"} className="min-h-11 min-w-11 px-2" aria-label={`第 ${number} 页`} aria-current={number === page ? "page" : undefined} disabled={loading || blocked || number === page} onClick={() => onRead({ ...query, pageNumber: number })}>{number}</Button>
                    </li>)}
                    <li><Button variant="outline" size="icon" className="size-11" aria-label="下一页" disabled={loading || blocked || page >= lastPage} onClick={() => onRead({ ...query, pageNumber: page + 1 })}><ChevronRight aria-hidden="true" /></Button></li>
                </ul>
            </nav>
        </> : null}</TabsContent>)}
        {state.detail ? <Dialog open onOpenChange={(open) => { if (!open) onCloseDetail?.(); }}><DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden p-4 sm:max-w-2xl sm:p-6">
            <DialogHeader><DialogTitle>创作记录详情</DialogTitle><DialogDescription>只读核对原任务。参数缺失时显示未记录，不会重新生成或扣费。</DialogDescription></DialogHeader>
            <Button variant="ghost" className="h-11 w-fit shrink-0 px-0" onClick={() => onCloseDetail?.()}><ChevronLeft aria-hidden="true" className="size-4" />返回历史列表</Button>
            <div className="min-h-0 overflow-y-auto">
            {state.detail.status === "loading" ? <p role="status">正在读取原任务…</p> : state.detail.status === "error" ? <div role="alert" className="space-y-3"><p>详情读取未完成，请手动重试核对。</p><Button variant="outline" onClick={() => onDetail?.(state.detail!.taskId)}>重试读取详情</Button></div>
                : state.detail.value ? <HistoryDetailBody detail={state.detail.value} row={state.items.find(row => row.taskId === state.detail?.taskId)} preview={state.previews[state.detail.taskId]} onPreview={onPreview} onPreviewError={onPreviewError} onOpenWorkbench={onOpenWorkbench} onOpenOrigin={onOpenOrigin} /> : null}
            </div>
        </DialogContent></Dialog> : null}
        {rename && onRename && !blocked ? <Dialog open onOpenChange={open => { if (!open && !rename.saving) setRename(undefined); }}><DialogContent showCloseButton={!rename.saving}>
            <DialogHeader><DialogTitle>{t("generationHistory.rename")}</DialogTitle><DialogDescription className="sr-only">{t("generationHistory.recordName")}</DialogDescription></DialogHeader>
            <form className="space-y-4" onSubmit={event => {
                event.preventDefault();
                const parsed = historyTitleSchema.safeParse(rename.title);
                if (rename.saving || !parsed.success) return;
                setRename({ ...rename, saving: true, failed: false });
                void onRename(rename.row.taskId, parsed.data).then(saved => setRename(saved ? undefined : { ...rename, saving: false, failed: true }));
            }}>
                <label className="grid gap-2">{t("generationHistory.recordName")}<Input autoFocus className="h-11" value={rename.title} placeholder={rename.row.displayModel}
                    disabled={rename.saving} onChange={event => setRename({ ...rename, title: event.target.value, failed: false })} /></label>
                {rename.title && !historyTitleSchema.safeParse(rename.title).success ? <p role="alert" className="text-destructive">{t("generationHistory.invalidName")}</p> : null}
                {rename.failed ? <p role="alert" className="text-destructive">{t("generationHistory.renameFailed")}</p> : null}
                <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" disabled={rename.saving} onClick={() => setRename(undefined)}>{t("generationHistory.cancel")}</Button>
                    <Button type="submit" disabled={rename.saving || !historyTitleSchema.safeParse(rename.title).success}>{t(`generationHistory.${rename.saving ? "savingName" : "saveName"}`)}</Button>
                </div>
            </form>
        </DialogContent></Dialog> : null}
    </Tabs>;
}

function HistoryRecordName({ row, disabled, onDetail, onRename }: { row: GenerationHistoryItem; disabled: boolean; onDetail?: (id: string) => void; onRename?: (row: GenerationHistoryItem) => void }) {
    const { t } = useTranslation(), name = row.title ?? row.displayModel;
    return <div className="flex min-w-0 items-start gap-1">
        <div className="min-w-0 flex-1 break-all">{onDetail ? <Button variant="link" className="h-auto max-w-full whitespace-normal break-all p-0 text-left font-medium" aria-label={`查看记录详情：${name}`} disabled={disabled} onClick={() => onDetail(row.taskId)}>{name}</Button> : name}
            {row.title ? <p className="mt-1 text-xs font-normal text-muted-foreground">{row.displayModel}</p> : null}</div>
        {onRename ? <Button type="button" variant="ghost" size="icon-sm" className="size-11 shrink-0 md:size-8" aria-label={t("generationHistory.rename")} title={t("generationHistory.rename")}
            disabled={disabled} onClick={() => onRename(row)}><Pencil aria-hidden="true" /></Button> : null}
    </div>;
}

function HistoryImagePreview({ row, preview, onPreviewError, large, imageNumber }: {
    row: GenerationHistoryItem; preview: HistoryPreview; onPreviewError: PreviewActions["onPreviewError"]; large?: boolean; imageNumber?: number;
}) {
    const { t } = useTranslation(), url = preview.url;
    if (!url?.startsWith("blob:")) return null;
    const name = (row.title ?? row.displayModel).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "-").replace(/[. ]+$/, "");
    const filename = `${name || "image"}-${row.taskId.slice(0, 8)}${imageNumber ? `-${imageNumber}` : ""}.${preview.imageExtension}`;
    return <div className="space-y-1">
        <img src={url} alt={t("generationHistory.previewAlt", { model: row.title ?? row.displayModel })}
            className={large ? "max-h-72 max-w-full rounded-lg object-contain" : "size-14 rounded-lg object-cover"} onError={() => onPreviewError(row.taskId, url)} />
        {preview.imageExtension ? <div className="flex flex-wrap gap-x-2">
            <Button asChild variant="ghost" size="sm" className="h-9 px-1 text-xs"><a href={url} target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" />{t("generationHistory.openOriginal")}</a></Button>
            <Button asChild variant="ghost" size="sm" className="h-9 px-1 text-xs"><a href={url} download={filename}><Download aria-hidden="true" />{t("generationHistory.saveImage")}</a></Button>
        </div> : null}
    </div>;
}

function HistoryMobileRow({ row, state, loading, blocked, onPreview, onPreviewError, onDetail, onRename, onOpenWorkbench }: PreviewActions & {
    row: GenerationHistoryItem; state: HistoryState; loading: boolean; blocked: boolean;
    onRename?: (row: GenerationHistoryItem) => void;
    onDetail?: (taskId: string) => void; onOpenWorkbench?: (item: GenerationHistoryItem) => void;
}) {
    const { t } = useTranslation();
    const type = row.type ?? "unknown", Icon = icons[type], presentation = generationTrackingPresentation(row), preview = state.previews[row.taskId];
    const StatusIcon = presentation.level === "success" ? CircleCheck : presentation.level === "warning" ? TriangleAlert : presentation.level === "error" ? CircleAlert : Clock3;
    const tone = presentation.level === "success" ? "border-[var(--ant-color-success-border)] bg-[var(--ant-color-success-bg)] text-[var(--ant-color-success-text)]"
        : presentation.level === "warning" ? "border-[var(--ant-color-warning-border)] bg-[var(--ant-color-warning-bg)] text-[var(--ant-color-warning-text)]" : "";
    return <article data-mobile-row-key={row.taskId} className="rounded-xl border border-border bg-card p-4 text-sm shadow-sm">
        <div className="flex items-start justify-between gap-3 text-xs text-muted-foreground">
            <span className="inline-flex min-w-0 items-center gap-2"><Icon aria-hidden="true" className="size-4 shrink-0" /><span>{t(`generationHistory.types.${type}`)} · <time dateTime={row.createdAt}>{dayjs(row.createdAt).format("MM-DD HH:mm")}</time></span></span>
            <span className="max-w-[45%] break-all text-right tabular-nums">{row.credits === null ? t("generationHistory.unverified") : t("generationHistory.creditsValue", { credits: row.credits })}</span>
        </div>
        <div className="mt-3 min-w-0">
            <HistoryRecordName row={row} disabled={state.phase !== "ready" || blocked} onDetail={onDetail} onRename={onRename} />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
            <Badge variant={presentation.level === "error" ? "destructive" : "outline"} data-status-level={presentation.level} title={presentation.description} className={`h-auto min-h-6 gap-1.5 whitespace-normal ${tone}`}><StatusIcon aria-hidden="true" />{presentation.title}</Badge>
            <span className="text-xs text-muted-foreground">{t(`generationHistory.execution.${row.executionStatus}`)}</span>
            <span aria-hidden="true" className="text-muted-foreground">·</span>
            <span className="text-xs text-muted-foreground">{t(`generationHistory.delivery.${row.deliveryStatus}`)}</span>
            <span aria-hidden="true" className="text-muted-foreground">·</span>
            <span className="text-xs text-muted-foreground">{t(`generationHistory.billing.${row.billingStatus}`)}</span>
        </div>
        {row.result ? <div className="mt-3">
            {row.type === "image" && preview?.status === "ready" && preview.url?.startsWith("blob:")
                ? <HistoryImagePreview row={row} preview={preview} onPreviewError={onPreviewError} />
                : row.type === "image" ? <Button variant="ghost" className="h-11 px-0 text-xs" disabled={loading || preview?.status === "loading"} aria-busy={preview?.status === "loading"} onClick={() => onPreview(row.taskId)}>{preview?.status === "loading" ? <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" /> : null}{t(`generationHistory.${preview?.status === "error" ? "retryPreview" : preview?.status === "loading" ? "previewLoading" : "preview"}`)}</Button>
                : <span className="text-xs text-muted-foreground">{t("generationHistory.savedResult")}</span>}
        </div> : <p className="mt-3 text-xs text-muted-foreground">{t("generationHistory.noResult")}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
            {onDetail ? <Button variant="outline" className="h-11" disabled={loading || blocked} onClick={() => onDetail(row.taskId)}>查看详情</Button> : null}
            {onOpenWorkbench && historyCreationTarget(row.type) ? <Button variant="ghost" className="h-11 px-2" onClick={() => onOpenWorkbench(row)}>返回{t(`generationHistory.types.${row.type}`)}创作</Button> : null}
        </div>
    </article>;
}

export function HistoryDetailBody({ detail, row, preview, onPreview, onPreviewError, onOpenWorkbench, onOpenOrigin }: PreviewActions & {
    detail: HistoryDetail; row?: GenerationHistoryItem; preview?: HistoryState["previews"][string];
    onOpenWorkbench?: (item: GenerationHistoryItem) => void; onOpenOrigin?: (detail: HistoryDetail) => void;
}) {
    const { t } = useTranslation(), canvas = useCanvasStore(), task = detail.task;
    const target = canvas.hydrated ? historyOriginTarget(detail, canvas.projects.map(project => project.id)) : null;
    const origin = target?.startsWith("/canvas/") ? target : null;
    const image = task.imageSpecSnapshot, audio = task.audioSnapshot;
    const native = task.geminiImage;
    const parameters = task.video?.parameters ?? (native ? { imageSize: native.parameters.imageSize, aspectRatio: native.parameters.aspectRatio } : image?.status === "recorded" ? image.parameters : audio?.status === "recorded" ? audio.parameters : null);
    const delivered = task.executionStatus === "succeeded" && ["saved", "visible"].includes(task.deliveryStatus) && detail.result?.status === "succeeded";
    const imageIds = historyImageIds(row, detail);
    const labels: Record<string, string> = { size: "尺寸", imageSize: "清晰度", quality: "质量", n: "张数", background: "背景", outputFormat: "输出格式", aspectRatio: "画幅比例", resolution: "分辨率", voice: "音色", format: "格式", style: "风格", language: "语言", mode: "生成方式", durationSeconds: "时长（秒）", generateAudio: "声音" };
    const parameterValue = (key: string, value: unknown) => task.video && key === "mode" ? value === "text" ? "文生视频" : "单张首帧"
        : task.video && key === "generateAudio" ? value ? "带声音" : "无声音" : String(value);
    const field = (label: string, value: string) => <div key={label} className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 break-all whitespace-pre-wrap">{value}</dd></div>;
    return <div className="min-w-0 space-y-5">
        <dl className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2">
            {row?.title ? field(t("generationHistory.recordName"), row.title) : null}
            {field("模型", task.modelId)}{field("任务编号", task.id)}
            {field("任务执行", t(`generationHistory.execution.${task.executionStatus}`))}{field("结果交付", t(`generationHistory.delivery.${task.deliveryStatus}`))}
            {field("计费状态", t(`generationHistory.billing.${task.billingStatus}`))}{field("价格版本", task.priceVersion === null ? "未记录" : String(task.priceVersion))}
            {field("正式报价（非实扣）", task.quotedUnits === null ? "未记录" : `${task.quotedUnits} 积分`)}
            {field("文本预算上限（非实扣）", task.textQuoteSnapshot ? `${task.textQuoteSnapshot.budgetCredits} 积分` : "未记录")}
            {field("实扣积分（历史已核实）", row?.credits == null ? "待核实" : `${row.credits} 积分`)}
            {native ? <>{field("每张单价", `${native.creditsPerImage} 积分`)}{field("原费用上限", `${native.parameters.budgetCredits} 积分`)}
                {field("已交付张数", detail.result?.resultSnapshot.media ? String(detail.result.consumedUnits) : "未确认")}
                {task.billing ? <>{field("原预留积分", task.billing.reservedCredits)}{field("原任务实扣", task.billing.capturedCredits)}{field("已退回积分", task.billing.releasedCredits)}</> : null}</> : null}
            {field("原项目", task.projectId ?? "未记录")}{field("原节点", task.nodeId ?? "未记录")}
        </dl>
        <section className="space-y-2"><h3 className="font-medium">生成参数</h3>{parameters ? <dl className="grid grid-cols-2 gap-3">{Object.entries(parameters).map(([key, value]) => field(labels[key] ?? key, parameterValue(key, value)))}</dl> : <p className="text-sm text-muted-foreground">未记录{image?.status === "invalid" || audio?.status === "invalid" ? "（原快照无法核实）" : ""}</p>}
            <p className="text-xs text-muted-foreground">提示词 / 语音文本</p><p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-sm">{audio?.status === "recorded" ? audio.input.text : "未记录"}</p>
        </section>
        <section className="space-y-3"><h3 className="font-medium">生成结果</h3>
            {row && imageIds.length > 1 ? <div className="flex flex-wrap gap-2" role="group" aria-label={t("generationHistory.resultImages")}>
                {imageIds.map((id, index) => <Button key={id} variant="outline" size="sm" aria-pressed={preview?.imageId === id}
                    onClick={() => onPreview(row.taskId, id)}>{t("generationHistory.imageNumber", { number: index + 1 })}</Button>)}
            </div> : null}
            {delivered && detail.result?.resultSnapshot.kind === "text" && detail.result.resultSnapshot.text !== undefined
                ? <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border p-3 font-sans text-sm">{detail.result.resultSnapshot.text}</pre>
                : delivered && row?.result && detail.result?.resultSnapshot.kind === row.type ? preview?.status === "ready" && preview.url?.startsWith("blob:") ? row.type === "audio" ? <audio controls className="w-full" src={preview.url} onError={() => onPreviewError(row.taskId, preview.url)} /> : row.type === "video" ? <video controls className="max-h-72 w-full" src={preview.url} onError={() => onPreviewError(row.taskId, preview.url)} /> : <HistoryImagePreview row={row} preview={preview} onPreviewError={onPreviewError} large imageNumber={imageIds.length > 1 ? imageIds.indexOf(preview.imageId ?? "") + 1 : undefined} />
                    : <Button variant="outline" disabled={preview?.status === "loading"} onClick={() => onPreview(row.taskId, preview?.imageId)}>{preview?.status === "loading" ? "正在读取结果…" : preview?.status === "error" ? "重试读取结果" : "查看结果"}</Button>
                    : <p className="text-sm text-muted-foreground">暂无可读取结果；结果或三态有变化时，请关闭详情并刷新历史核对。</p>}
        </section>
        <p className="text-xs leading-relaxed text-muted-foreground">报价与预算不代表已扣费；执行成功、结果交付和计费分别核对。详情为本次读取状态，实扣按历史列表最近一次核实值展示。</p>
        <div className="flex flex-wrap gap-2">{origin && onOpenOrigin ? <Button onClick={() => onOpenOrigin(detail)}>回到原画布</Button> : <p className="w-full text-xs text-muted-foreground">{task.projectId === "__image_workbench__" ? "此任务来自图片工作台，未记录原画布位置。" : task.projectId ? "原画布不在当前浏览器本机列表，无法定位。" : "未记录原画布位置。"}</p>}
            {row && historyCreationTarget(row.type) && onOpenWorkbench ? <Button variant="outline" onClick={() => onOpenWorkbench(row)}>返回{t(`generationHistory.types.${row.type}`)}创作</Button> : null}
        </div>
    </div>;
}
