import { useEffect, useState } from "react";
import { AlertCircle, ArrowUpRight, AudioLines, BookOpen, Image, LoaderCircle, RefreshCw, Sparkles, Video } from "lucide-react";
import { Link } from "react-router-dom";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { buildInspirationHref } from "@/pages/home/inspiration-draft-handoff";
import { fetchPublicInspirations, type InspirationItem } from "@/services/saas/inspiration";

type InspirationFilter = "all" | InspirationItem["type"];
const typeLabels = { image: "图片", video: "视频", audio: "音频" };
const typeIcons = { image: Image, video: Video, audio: AudioLines };
const filters = [{ value: "all", label: "全部" }, { value: "image", label: "图片" }, { value: "video", label: "视频" }, { value: "audio", label: "音频" }] as const;

export default function InspirationPage() {
    const [filter, setFilter] = useState<InspirationFilter>("all");
    const [reload, setReload] = useState(0);
    const [catalog, setCatalog] = useState<{ phase: "loading" | "ready" | "error"; items: InspirationItem[]; error: string }>({ phase: "loading", items: [], error: "" });

    useEffect(() => {
        const controller = new AbortController();
        setCatalog({ phase: "loading", items: [], error: "" });
        void fetchPublicInspirations(controller.signal).then(items => {
            if (!controller.signal.aborted) setCatalog({ phase: "ready", items, error: "" });
        }).catch(error => {
            if (!controller.signal.aborted) setCatalog({ phase: "error", items: [], error: error instanceof Error ? error.message : "读取未完成，请稍后重试。" });
        });
        return () => controller.abort();
    }, [reload]);

    const items = filter === "all" ? catalog.items : catalog.items.filter(item => item.type === filter);
    return <main aria-label="灵感广场" className="h-full min-w-0 overflow-y-auto bg-background text-foreground">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-8 sm:py-10">
            <header className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
                <div><h1 className="text-2xl font-semibold tracking-tight sm:text-[28px]">灵感广场</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">精选灵感，带着提示词开始创作。</p><p className="mt-1 text-xs leading-5 text-muted-foreground">示意封面，非真实生成作品。</p></div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <Button asChild variant="outline" className="min-h-11"><Link to="/prompts"><BookOpen aria-hidden="true" />提示词库</Link></Button>
                    <Button asChild variant="ghost" className="min-h-11 text-muted-foreground"><Link to="/">返回创作<ArrowUpRight aria-hidden="true" /></Link></Button>
                </div>
            </header>

            <div className="mb-6 mt-8 flex flex-wrap items-center justify-between gap-3">
                <div role="group" aria-label="灵感类型" className="flex max-w-full flex-wrap gap-2">
                    {filters.map(item => <Button key={item.value} type="button" variant={filter === item.value ? "secondary" : "ghost"} className="min-h-11 min-w-16 px-5" aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</Button>)}
                </div>
                <Button type="button" variant="ghost" className="min-h-11 text-muted-foreground" disabled={catalog.phase === "loading"} onClick={() => setReload(value => value + 1)}><RefreshCw aria-hidden="true" />刷新灵感</Button>
            </div>

            {catalog.phase === "loading" ? <div role="status" className="flex min-h-64 items-center justify-center gap-3 text-sm text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />正在读取公开灵感…</div> : catalog.phase === "error" ? <Alert variant="destructive" className="p-4">
                <AlertCircle aria-hidden="true" />
                <AlertTitle>灵感暂时无法读取</AlertTitle>
                <AlertDescription className="min-w-0">
                    <p className="break-words">{catalog.error}</p>
                    <Button type="button" variant="outline" className="min-h-11 text-foreground" onClick={() => setReload(value => value + 1)}>重试</Button>
                </AlertDescription>
            </Alert> : items.length ? <>
                <p role="status" className="mb-4 text-xs text-muted-foreground">{filter === "all" ? "全部" : typeLabels[filter]} · {items.length} 个灵感</p>
                <div className="grid grid-cols-1 items-start gap-5 md:grid-cols-2 xl:grid-cols-3">
                    {items.map(item => <InspirationCard key={`${item.id}:${item.imageUrl}`} item={item} />)}
                </div>
                <p className="mt-5 text-xs leading-5 text-muted-foreground">使用后确认替换提示词，不会自动生成</p>
            </> : <div role="status" className="flex min-h-64 flex-col items-center justify-center gap-3 py-16 text-center text-muted-foreground">
                <Sparkles aria-hidden="true" className="size-8" strokeWidth={1.25} />
                <p className="text-sm leading-6">{filter === "all" ? "暂时还没有公开灵感" : `暂无${typeLabels[filter]}灵感，试试其他类型吧`}</p>
            </div>}
        </div>
    </main>;
}

function InspirationCard({ item }: { item: InspirationItem }) {
    const [imageFailed, setImageFailed] = useState(false);
    const Icon = typeIcons[item.type];
    return <article aria-label={`灵感：${item.title}`} className="min-w-0 overflow-hidden rounded-xl border border-border bg-card text-card-foreground transition-colors hover:border-primary/50">
        <div className="relative mx-4 mt-4 aspect-video overflow-hidden rounded-lg bg-muted/40">
            {item.imageUrl && !imageFailed ? <img src={item.imageUrl} alt={`${item.title}预览图`} loading="lazy" referrerPolicy="no-referrer" className="size-full object-cover" onError={() => setImageFailed(true)} /> : <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground"><Icon aria-hidden="true" className="size-8" strokeWidth={1.25} /><span className="text-xs">{imageFailed ? "预览图加载失败" : "暂无预览图"}</span></div>}
        </div>
        <div className="p-4">
            <p className="mb-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground"><Icon aria-hidden="true" className="size-3.5" />{typeLabels[item.type]}</p>
            <h2 className="break-words text-base font-semibold leading-6">{item.title}</h2>
            <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">{item.prompt}</p>
            <Accordion type="single" collapsible className="mt-2">
                <AccordionItem value="prompt">
                    <AccordionTrigger className="min-h-11 gap-2 text-xs text-muted-foreground" aria-label={`查看完整提示词：${item.title}`}>查看完整提示词</AccordionTrigger>
                    <AccordionContent>
                        <p tabIndex={0} aria-label={`${item.title}完整提示词`} className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded-sm text-sm leading-6 text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">{item.prompt}</p>
                    </AccordionContent>
                </AccordionItem>
            </Accordion>
            {item.tags.length ? <p className="mt-3 break-words text-xs leading-5 text-muted-foreground">{item.tags.join(" · ")}</p> : null}
            <Button asChild className="mt-4 min-h-11 w-full">
                <Link to={buildInspirationHref(item.type, item.prompt)} style={{ color: "var(--primary-foreground)", background: "var(--primary)" }} aria-label={`使用灵感：${item.title}`}>使用灵感<ArrowUpRight aria-hidden="true" /></Link>
            </Button>
        </div>
    </article>;
}
