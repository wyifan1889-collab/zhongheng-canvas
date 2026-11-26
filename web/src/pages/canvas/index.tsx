import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Input } from "antd";
import { Download, FileUp, Plus, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { readZip } from "@/lib/zip";
import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasCreateProjectDialog } from "@/components/canvas/canvas-create-project-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useCanvasUiStore } from "@/stores/canvas/use-canvas-ui-store";
import { exportCanvasProjects, parseCanvasExportFile, validateCanvasExportArchive } from "@/lib/canvas/canvas-export";
import { hasAgentUrlBootstrap } from "@/lib/agent/agent-url-bootstrap";
import { searchLocalCanvases } from "./local-search";

export default function CanvasPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [query, setQuery] = useState("");
    const hydrated = useCanvasStore((state) => state.hydrated);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const selectedIds = useCanvasUiStore((state) => state.selectedProjectIds);
    const setDeleteIds = useCanvasUiStore((state) => state.setDeleteProjectIds);
    const matchedProjects = searchLocalCanvases(projects, query);

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const agentQuery = agentMode ? `?${searchParams.toString()}` : "";
    const enterProject = (id: string) => {
        const agentHash = hasAgentUrlBootstrap(window.location.hash) ? window.location.hash : "";
        navigate(`/canvas/${id}${agentQuery}${agentHash}`, { replace: Boolean(agentHash) });
    };
    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            if (!projectFile) throw new Error("missing projects.json");
            const data = parseCanvasExportFile(JSON.parse(await projectFile.text()));
            validateCanvasExportArchive(data, zip);
            await Promise.all(
                data.projects.flatMap((project) =>
                    project.files.map(async (item) => {
                        const blob = zip.get(item.path);
                        if (!blob) throw new Error("missing media entry");
                        const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
                        await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
                    }),
                ),
            );
            data.projects.forEach((item) => importProject(item.project));
            message.success(t("canvas.imported", { count: data.projects.length }));
        } catch {
            message.error(t("canvas.importFailed"));
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };

    useEffect(() => {
        if (!hydrated || autoOpenRef.current || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = true;
        enterProject(mode === "new" ? createProject(t("canvas.defaultTitle", { count: projects.length + 1 })) : projects[0]?.id || createProject(t("canvas.defaultTitle", { count: projects.length + 1 })));
    }, [createProject, hydrated, mode, projects, t]);

    if (hydrated && (mode === "new" || mode === "recent")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">{t("canvas.opening")}</main>;

    return (
        <main className="h-full min-w-0 overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full min-w-0 max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">{t("canvas.library")}</p>
                        <h1 className="mt-3 text-3xl font-semibold">{t("canvas.title")}</h1>
                    </div>
                    <div className="flex min-w-0 flex-wrap items-center gap-2 max-sm:[&>button]:min-h-11">
                        {selectedIds.length ? (
                            <>
                                <Button disabled={!hydrated} icon={<Download className="size-4" />} onClick={() => void exportCanvasProjects(projects.filter((project) => selectedIds.includes(project.id)), `${t("canvas.title")}-${selectedIds.length}`)}>
                                    {t("canvas.exportSelected")}
                                </Button>
                                <Button disabled={!hydrated} onClick={() => setDeleteIds(selectedIds)}>
                                    {t("canvas.deleteSelected")}
                                </Button>
                            </>
                        ) : null}
                        {projects.length ? (
                            <Button disabled={!hydrated} onClick={() => setDeleteIds(projects.map((project) => project.id))}>
                                {t("canvas.deleteAll")}
                            </Button>
                        ) : null}
                        <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            {t("canvas.import")}
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
                            {t("canvas.create")}
                        </Button>
                    </div>
                </header>

                <section aria-label="本机画布搜索" className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                    <div className="w-full sm:max-w-sm">
                        <Input aria-label="搜索本机画布名称" aria-describedby="canvas-search-scope" placeholder="搜索本机画布名称" className="min-h-11" prefix={<Search aria-hidden="true" className="size-4" />} allowClear value={query} onChange={event => setQuery(event.target.value)} disabled={!hydrated} />
                        <p id="canvas-search-scope" className="mt-2 text-xs leading-6 text-muted-foreground">仅搜索当前浏览器已保存的本机画布名称，不查询云端。</p>
                    </div>
                    {hydrated && <p role="status" className="text-xs text-muted-foreground">显示 {matchedProjects.length} / {projects.length} 个本机画布</p>}
                </section>

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">{t("canvas.loading")}</section>
                ) : projects.length && !matchedProjects.length ? (
                    <section className="flex min-h-[360px] flex-col items-center justify-center text-center">
                        <h2 className="text-xl font-medium">未找到匹配的本机画布</h2>
                        <p className="mt-3 text-sm text-muted-foreground">试试其他名称，或清除搜索查看全部本机画布。</p>
                        <Button className="mt-6 min-h-11" onClick={() => setQuery("")}>清除搜索</Button>
                    </section>
                ) : projects.length ? (
                    <div className="grid min-w-0 grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
                        {matchedProjects.map((project) => (
                            <CanvasProjectCard key={project.id} project={project} />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <h2 className="text-xl font-medium">{t("canvas.empty")}</h2>
                        <p className="mt-3 text-sm text-stone-500">{t("canvas.emptyDescription")}</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
                            {t("canvas.create")}
                        </Button>
                    </section>
                )}
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
            {createOpen ? <CanvasCreateProjectDialog onCancel={() => setCreateOpen(false)} onCreated={(id) => { setCreateOpen(false); enterProject(id); }} /> : null}
        </main>
    );
}
