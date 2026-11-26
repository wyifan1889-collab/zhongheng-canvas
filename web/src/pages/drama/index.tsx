import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { ArrowLeft, Film, LoaderCircle, Plus, Search, TriangleAlert } from "lucide-react";

import { RequireAccount } from "@/components/account/require-account";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useLocalDramaProjects } from "./use-local-projects";
import { searchLocalDramaProjects } from "./local-search";

const stages = [
    ["outline", "大纲", "暂无故事大纲", "整理故事设定、核心冲突与整体走向。"],
    ["story", "故事", "暂无故事内容", "展开剧情与对白。"],
    ["shots", "镜头", "暂无镜头", "拆解场景、动作与镜头顺序。"],
    ["references", "参考", "暂无参考素材", "整理角色、场景与风格参考。"],
    ["frames", "首帧", "暂无首帧", "查看与确认各镜头首帧。"],
    ["videos", "视频", "暂无视频片段", "管理各镜头的视频候选。"],
    ["audio", "声音", "暂无声音内容", "整理对白、配音与背景声音。"],
    ["timeline", "时间线", "暂无时间线", "编排镜头与声音。"],
    ["export", "导出", "暂无可导出的成片", "导出完成的短剧。"],
] as const;

export default function DramaPage() {
    const local = useLocalDramaProjects();
    const location = useLocation();
    const [params, setParams] = useSearchParams();
    const [createOpen, setCreateOpen] = useState(false);
    const [name, setName] = useState("");
    const [search, setSearch] = useState({ scopeKey: local.scopeKey, value: "" });
    const query = search.scopeKey === local.scopeKey ? search.value : "";
    const matchedProjects = searchLocalDramaProjects(local.projects, query);
    const inputId = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const projectId = params.get("project");
    const project = local.projects.find(item => item.id === projectId);
    const stageIndex = Math.max(0, stages.findIndex(item => item[0] === params.get("stage")));
    const stage = stages[stageIndex];

    useEffect(() => { setCreateOpen(false); setName(""); }, [local.scopeKey]);
    const openProject = (id: string) => setParams({ project: id, stage: "outline" });
    const create = () => local.create(name, created => {
        // Browser back/forward can change the project without unmounting this page.
        if ((window.history.state?.key ?? "default") !== location.key) return;
        setCreateOpen(false); setName(""); openProject(created.id);
    });
    const failure = local.error && <Alert className="p-4">
        <TriangleAlert aria-hidden="true" />
        <AlertDescription className="min-w-0 leading-6">
            <p>{local.error}</p>
            <Button type="button" variant="outline" className="mt-3 min-h-11 whitespace-normal" onClick={local.reload} disabled={local.saving}>重新读取本机项目</Button>
        </AlertDescription>
    </Alert>;

    return <RequireAccount><Dialog open={createOpen} onOpenChange={open => { if (!local.saving) setCreateOpen(open); }}>
        <main className="h-full min-w-0 overflow-y-auto bg-background text-foreground" aria-label="短剧工作台">
            <div className="mx-auto flex min-h-full w-full max-w-[1080px] flex-col p-4 sm:p-8">
                {local.loading ? <div role="status" className="flex flex-1 items-center justify-center gap-3 py-16 text-sm text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />正在读取本机项目…</div> : <>
                    {failure}
                    {projectId && local.ready ? project ? <>
                        <header className="mb-6 flex min-w-0 flex-wrap items-center gap-4 border-b border-border pb-5">
                            <Button type="button" variant="ghost" className="min-h-11" onClick={() => setParams({})}><ArrowLeft className="size-4" />返回项目列表</Button>
                            <h1 className="min-w-0 flex-1 break-all text-lg font-semibold">{project.name}</h1>
                        </header>
                        <div className="flex min-h-0 flex-1 flex-col gap-7">
                            <nav aria-label="短剧制作阶段" className="min-w-0 overflow-x-auto">
                                <div className="flex min-w-max gap-2 lg:min-w-0">
                                    {stages.map(([key, label]) => <Button key={key} type="button" aria-label={label} aria-current={stage[0] === key ? "step" : undefined}
                                        variant={stage[0] === key ? "default" : "outline"}
                                        style={{ color: stage[0] === key ? "var(--primary-foreground)" : "var(--foreground)" }}
                                        className="min-h-11 min-w-[80px] shrink-0 justify-center px-4 font-normal lg:min-w-0 lg:flex-1"
                                        onClick={() => setParams({ project: project.id, stage: key })}>{label}</Button>)}
                                </div>
                            </nav>
                            <section aria-labelledby="drama-stage-title" className="min-w-0 flex-1">
                                <p className="text-xs text-muted-foreground">第 {stageIndex + 1} 步 / 9 步</p>
                                <h2 id="drama-stage-title" className="mt-2 text-2xl font-semibold">{stage[2]}</h2>
                                <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground">{stage[3]}</p>
                                <p className="mt-3 text-sm leading-7 text-muted-foreground">{stage[1]}编辑与生成尚未开放。</p>
                                {stage[0] === "outline" ? <div className="mt-4 flex flex-wrap gap-2">
                                    <Button type="button" variant="outline" disabled className="min-h-11 min-w-40">生成大纲</Button>
                                    <Button type="button" variant="outline" disabled className="min-h-11 min-w-40">导出成片</Button>
                                </div> : null}
                            </section>
                        </div>
                    </> : <div className="py-16 text-center"><h1 className="text-xl font-semibold">未找到当前本机项目</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">请确认当前账号与浏览器，或返回列表查看已保存项目。</p><Button type="button" variant="outline" className="mt-6 min-h-11" onClick={() => setParams({})}>返回项目列表</Button></div> : !projectId && <>
                        <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
                            <div><h1 className="text-2xl font-semibold sm:text-[28px]">短剧</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">本机项目 · 功能建设中</p></div>
                            <DialogTrigger asChild><Button type="button" className="min-h-11" style={{ color: "var(--primary-foreground)" }} disabled={!local.ready}><Plus className="size-4" />新建项目</Button></DialogTrigger>
                        </header>
                        <section aria-label="本机短剧项目搜索" className="mb-6 flex min-w-0 flex-wrap items-center justify-between gap-3">
                            <div className="w-full sm:max-w-sm">
                                <div className="relative">
                                    <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" />
                                    <Input aria-label="搜索本机短剧项目名称" aria-describedby="drama-search-scope" placeholder="搜索本机短剧项目名称" className="min-h-11 pl-9" value={query} onChange={event => setSearch({ scopeKey: local.scopeKey, value: event.target.value })} disabled={!local.ready} />
                                </div>
                                <p id="drama-search-scope" className="mt-2 text-xs leading-6 text-muted-foreground">仅搜索当前账号在此浏览器保存的本机项目名称，不查询云端。</p>
                            </div>
                            {local.ready && <p role="status" className="sr-only">显示 {matchedProjects.length} / {local.projects.length} 个本机项目</p>}
                        </section>
                        {local.ready && (local.projects.length && !matchedProjects.length ? <div className="flex min-h-80 flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-border px-5 py-12 text-center">
                            <h2 className="text-lg font-medium">未找到匹配的本机项目</h2>
                            <p className="mt-3 text-sm leading-7 text-muted-foreground">试试其他名称，或清除搜索查看当前账号的全部本机项目。</p>
                            <Button type="button" variant="outline" className="mt-6 min-h-11" onClick={() => setSearch({ scopeKey: local.scopeKey, value: "" })}>清除搜索</Button>
                        </div> : local.projects.length ? <div className="grid gap-3">
                            {matchedProjects.map(item => <Button key={item.id} type="button" variant="outline" onClick={() => openProject(item.id)} aria-label={`打开项目：${item.name}`} className="h-auto min-w-0 items-center justify-between gap-4 whitespace-normal rounded-xl bg-card px-5 py-5 text-left font-normal hover:border-primary">
                                <span className="min-w-0"><span role="heading" aria-level={2} className="block break-all text-base font-medium">{item.name}</span><span className="mt-2 block text-xs leading-6 text-muted-foreground">仅保存在本机 · 当前项目</span></span>
                                <span className="shrink-0 rounded-lg border border-border px-4 py-2 text-xs text-muted-foreground">项目</span>
                            </Button>)}
                        </div> : <div className="flex min-h-80 flex-1 flex-col items-center justify-center rounded-xl border border-dashed border-border px-5 py-12 text-center">
                            <Film className="mb-5 size-10 text-primary" strokeWidth={1.5} />
                            <h2 className="text-lg font-medium">还没有短剧项目</h2>
                            <p className="mt-3 max-w-md text-sm leading-7 text-muted-foreground">创建第一个项目，开始整理你的短剧计划。当前仅保存项目名称，九个制作阶段均为建设中的空状态。</p>
                        </div>)}
                    </>}
                </>}
                <p className="mt-8 text-xs leading-6 text-muted-foreground">项目名称仅保存在当前账号的本机浏览器中，清理浏览器数据会丢失。短剧生成、扣费、云保存与导出尚未接入。</p>
            </div>
        </main>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md [&>[data-slot=dialog-close]]:size-11" showCloseButton={!local.saving}
            onOpenAutoFocus={event => { event.preventDefault(); inputRef.current?.focus(); }}>
            <DialogHeader className="pr-10">
                <DialogTitle>新建短剧项目</DialogTitle>
                <DialogDescription className="leading-6">只需填写项目名称。项目仅保存在本机，制作功能仍在建设中。</DialogDescription>
            </DialogHeader>
            <form className="grid gap-4" aria-busy={local.saving} onSubmit={event => { event.preventDefault(); void create(); }}>
                <div>
                    <label htmlFor={inputId} className="mb-2 block text-sm">项目名称</label>
                    <Input ref={inputRef} id={inputId} className="min-h-11" placeholder="输入短剧项目名称" value={name} disabled={local.saving} onChange={event => setName(event.target.value)}
                        onKeyDown={event => { if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault(); }} />
                </div>
                {failure}
                <DialogFooter>
                    <Button type="button" variant="outline" className="min-h-11" disabled={local.saving} onClick={() => setCreateOpen(false)}>取消</Button>
                    <Button type="submit" className="min-h-11" style={{ color: "var(--primary-foreground)" }} disabled={local.saving || !name.trim() || !local.ready}>
                        {local.saving && <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />}创建并进入
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    </Dialog>
    </RequireAccount>;
}
