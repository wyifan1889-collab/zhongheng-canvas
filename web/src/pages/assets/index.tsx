import { Copy, Download, FileText, Image as ImageIcon, PencilLine, Plus, RefreshCw, Search, Trash2, Upload, Video, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { App, Button, Drawer, Image, Input, Modal, Tag, Typography } from "@/components/creation/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button as WorkspaceButton } from "@/components/ui/button";
import { Input as WorkspaceInput } from "@/components/ui/input";
import { WorkspaceFeedback, WorkspaceHeading, workspaceAction } from "@/components/creation/workspace-feedback";
import { AssetPagination, AssetTagsInput } from "./asset-fields";
import { saveAs } from "file-saver";
import { useTranslation } from "react-i18next";

import { useCopyText } from "@/hooks/use-copy-text";
import { formatBytes, readFileAsDataUrl } from "@/lib/image-utils";
import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob, getImagePreviewRevision, subscribeImagePreviews, uploadImage } from "@/services/image-storage";
import { CloudMediaError, createMediaClient, type CloudMedia } from "@/services/api/media";
import { assetCoverUrl, useAssetStore, type Asset, type AssetKind, type ImageAsset } from "@/stores/use-asset-store";
import { useAccountStore } from "@/stores/use-account-store";
import { importLegacyAssetFiles, readLegacyAssetCatalog } from "@/services/saas/legacy-asset-import";
import type { DraftAccountScope } from "@/services/saas/drafts";
import { exportAssets, readAssetPackage } from "./asset-transfer";
import { createCloudAssetReader, initialCloudAssetState } from "./cloud-media-reader";

type AssetFormValues = {
    kind: AssetKind;
    title: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    content?: string;
};

type ImageDraft = ImageAsset["data"] | null;

const kindOptions = ["all", "text", "image", "video"] as const;

export default function AssetsPage() {
    const { t } = useTranslation();
    const account = useAccountStore();
    const scope = account.getDraftScope();
    // The key removes old data and portals in the render that changes ownership.
    const checking = account.busy || account.status === "idle" || account.status === "loading";
    return scope ? <ScopedAssetsPage key={JSON.stringify([scope.accountId, scope.epoch])} scope={scope} /> : <main className="h-full overflow-y-auto px-4 py-4 md:px-6 md:py-6">
        <div className="mx-auto max-w-[1076px] space-y-4">
            <WorkspaceHeading id="asset-workspace-title" title={t("assets.title")} />
            <WorkspaceFeedback state={checking ? "loading" : account.status === "ready" ? "empty" : "error"}>
                {checking ? t("generationHistory.accountLoading") : account.status === "ready" ? t("assets.signInRequired") : t("generationHistory.accountUnavailable")}
            </WorkspaceFeedback>
        </div>
    </main>;
}

function ScopedAssetsPage({ scope }: { scope: DraftAccountScope }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const copyText = useCopyText();
    const [form, setForm] = useState<AssetFormValues>({ kind: "text", title: "", coverUrl: "", tags: [] });
    const formRef = useRef<HTMLFormElement>(null);
    const coverInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const assetInputRef = useRef<HTMLInputElement>(null);
    const cloudInputRef = useRef<HTMLInputElement>(null);
    const mountedRef = useRef(true);
    const cloudDeleteBusyRef = useRef(false);
    const isCurrent = useCallback(() => {
        const current = useAccountStore.getState().getDraftScope();
        return mountedRef.current && current?.accountId === scope.accountId && current.epoch === scope.epoch;
    }, [scope.accountId, scope.epoch]);
    const isCloudCurrent = useCallback(() => isCurrent() && useAccountStore.getState().site?.cloudMedia === true, [isCurrent]);
    const cloudMediaClient = useMemo(() => createMediaClient(() => scope.accountId, fetch, { isCurrent: isCloudCurrent }), [scope.accountId, isCloudCurrent]);
    useLayoutEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);
    const assets = useAssetStore((state) => state.assets);
    const localReady = useAssetStore((state) => state.hydrated);
    const addAsset = useAssetStore((state) => state.addAsset);
    const updateAsset = useAssetStore((state) => state.updateAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
    const hasLocalFilter = Boolean(keyword.trim()) || kindFilter !== "all";
    const clearLocalFilters = () => { setPage(1); setKeyword(""); setKindFilter("all"); };
    const localSearch = useRef<HTMLInputElement>(null);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [editingAsset, setEditingAsset] = useState<Asset | null>(null);
    const [isAssetOpen, setIsAssetOpen] = useState(false);
    const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
    const [deletingAsset, setDeletingAsset] = useState<Asset | null>(null);
    const [formKind, setFormKind] = useState<AssetKind>("text");
    const [imageDraft, setImageDraft] = useState<ImageDraft>(null);
    const [legacyImport, setLegacyImport] = useState<{ open: boolean; loading: boolean; assets: Asset[] }>({ open: false, loading: false, assets: [] });
    const cloudEnabled = useAccountStore((state) => state.site?.cloudMedia === true && !!state.user);
    const [cloud, setCloud] = useState(initialCloudAssetState);
    const cloudReaderRef = useRef<ReturnType<typeof createCloudAssetReader> | null>(null);
    const cloudMedia = cloud.items, cloudQuota = cloud.quota, cloudLoading = cloud.loading || cloud.uploading, cloudLoadError = cloud.error;
    const [deletingCloudMedia, setDeletingCloudMedia] = useState<CloudMedia | null>(null);
    const [cloudDeleting, setCloudDeleting] = useState(false);
    const legacyImportRequestRef = useRef(0);
    const assetImportRequestRef = useRef(0);
    const { coverUrl, title, tags, content } = form;
    const validAssets = useMemo(() => assets.filter((asset) => asset.kind === "text" || asset.kind === "image" || asset.kind === "video"), [assets]);

    const filteredAssets = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return validAssets.filter((asset) => {
            if (kindFilter !== "all" && asset.kind !== kindFilter) return false;
            if (!query) return true;
            return assetSearchText(asset).includes(query);
        });
    }, [validAssets, keyword, kindFilter]);

    const visibleAssets = useMemo(() => {
        const start = (page - 1) * pageSize;
        return filteredAssets.slice(start, start + pageSize);
    }, [filteredAssets, page, pageSize]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filteredAssets.length / pageSize));
        setPage((value) => Math.min(value, maxPage));
    }, [filteredAssets.length, pageSize]);

    useEffect(() => {
        cloudDeleteBusyRef.current = false;
        setCloudDeleting(false);
        setDeletingCloudMedia(null);
        if (!cloudEnabled) {
            setCloud(initialCloudAssetState());
            return;
        }
        const reader = createCloudAssetReader({ client: cloudMediaClient, isCurrent: isCloudCurrent, onState: setCloud, loadFailed: t("assets.cloudLoadFailed") });
        cloudReaderRef.current = reader;
        void reader.read();
        return () => {
            reader.dispose();
            if (cloudReaderRef.current === reader) cloudReaderRef.current = null;
        };
    }, [cloudEnabled, cloudMediaClient, isCloudCurrent, t]);

    const retryCloudMedia = () => {
        void cloudReaderRef.current?.read();
    };

    const uploadCloudMedia = async (file?: File) => {
        if (!file || !isCloudCurrent()) return;
        const reader = cloudReaderRef.current;
        if (!reader) return;
        try {
            const saved = await reader.upload(file);
            if (!saved || !isCloudCurrent() || cloudReaderRef.current !== reader) return;
            message.success(t("assets.cloudUploadSuccess"));
        } catch (error) {
            if (isCloudCurrent() && cloudReaderRef.current === reader) message.error(error instanceof CloudMediaError ? error.message : t("assets.cloudUploadFailed"));
        } finally {
            if (isCloudCurrent() && cloudReaderRef.current === reader) {
                if (cloudInputRef.current) cloudInputRef.current.value = "";
            }
        }
    };

    const deleteCloudMedia = (item: CloudMedia) => {
        if (isCloudCurrent() && !cloudDeleteBusyRef.current) setDeletingCloudMedia(item);
    };

    const confirmDeleteCloudMedia = async () => {
        if (!deletingCloudMedia || !isCloudCurrent() || cloudDeleteBusyRef.current) return;
        const reader = cloudReaderRef.current;
        if (!reader) return;
        cloudDeleteBusyRef.current = true;
        setCloudDeleting(true);
        try {
            const removed = await reader.remove(deletingCloudMedia.id);
            if (!removed || !isCloudCurrent() || cloudReaderRef.current !== reader) return;
            setDeletingCloudMedia(null);
            message.success(t("assets.cloudDeleted"));
        } catch (error) {
            if (isCloudCurrent() && cloudReaderRef.current === reader) message.error(error instanceof CloudMediaError ? error.message : t("assets.cloudDeleteFailed"));
        } finally {
            if (isCloudCurrent() && cloudReaderRef.current === reader) { cloudDeleteBusyRef.current = false; setCloudDeleting(false); }
        }
    };

    const openCreate = () => {
        if (!isCurrent()) return;
        setEditingAsset(null);
        setImageDraft(null);
        setFormKind("text");
        setForm({ kind: "text", title: "", coverUrl: "", tags: [], source: t("assets.manual"), note: "", content: "" });
        setIsAssetOpen(true);
    };

    const openEdit = (asset: Asset) => {
        if (!isCurrent()) return;
        setEditingAsset(asset);
        setFormKind(asset.kind);
        setImageDraft(asset.kind === "image" ? asset.data : null);
        setForm({
            kind: asset.kind,
            title: asset.title,
            coverUrl: asset.coverUrl || "",
            tags: asset.tags || [],
            source: asset.source,
            note: asset.note,
            content: asset.kind === "text" ? asset.data.content : "",
        });
        setIsAssetOpen(true);
    };

    const saveAsset = async () => {
        if (!isCurrent()) return;
        if (!formRef.current?.reportValidity()) return;
        const values = form;
        if (!isCurrent()) return;
        const base = {
            title: values.title.trim(),
            coverUrl: values.coverUrl?.trim() || (values.kind === "image" && imageDraft ? imageDraft.dataUrl : ""),
            tags: values.tags || [],
            source: values.source?.trim(),
            note: values.note?.trim(),
            metadata: editingAsset?.metadata || { source: "manual" },
        };

        if (values.kind === "text") {
            const asset = { ...base, kind: "text" as const, data: { content: (values.content || "").trim() } };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        } else {
            if (!imageDraft) {
                message.error(t("assets.selectImage"));
                return;
            }
            const asset = { ...base, kind: "image" as const, data: imageDraft };
            editingAsset ? updateAsset(editingAsset.id, asset) : addAsset(asset);
        }

        message.success(editingAsset ? t("assets.updated") : t("assets.saved"));
        setIsAssetOpen(false);
    };

    const readCoverFile = async (file?: File) => {
        if (!file || !isCurrent()) return;
        try {
            const dataUrl = await readFileAsDataUrl(file);
            if (isCurrent()) setForm((value) => ({ ...value, coverUrl: dataUrl }));
        } catch (error) { if (isCurrent()) throw error; }
    };

    const readImageFile = async (file?: File) => {
        if (!file || !file.type.startsWith("image/") || !isCurrent()) return;
        let image: Awaited<ReturnType<typeof uploadImage>>;
        try { image = await uploadImage(file); } catch (error) { if (isCurrent()) throw error; return; }
        if (!isCurrent()) return;
        const draft = { dataUrl: image.url, storageKey: image.storageKey, width: image.width, height: image.height, bytes: image.bytes, mimeType: image.mimeType };
        setImageDraft(draft);
        setForm((value) => ({ ...value, coverUrl: value.coverUrl || draft.dataUrl, title: value.title || file.name }));
    };

    const copyAssetText = async (asset: Asset) => {
        if (asset.kind !== "text" || !isCurrent()) return;
        copyText(asset.data.content, t("assets.textCopied"));
    };

    const downloadImage = async (asset: Asset) => {
        if (!isCurrent() || (asset.kind !== "image" && asset.kind !== "video")) return;
        try {
            const blob = await readAssetMediaBlob(asset);
            if (!isCurrent()) return;
            if (!blob) {
                message.error(t("assets.downloadFailed"));
                return;
            }
            const ext = asset.data.mimeType?.split("/")[1]?.split("+")[0] || (asset.kind === "video" ? "mp4" : "png");
            saveAs(blob, `${asset.title || "asset"}.${ext}`);
        } catch {
            if (isCurrent()) message.error(t("assets.downloadFailed"));
        }
    };

    const exportAllAssets = async () => {
        if (!isCurrent()) return;
        if (!validAssets.length) {
            message.warning(t("assets.noneToExport"));
            return;
        }
        await exportAssets(validAssets, t("assets.packageName"));
    };

    const importAssetZip = async (file?: File) => {
        if (!file || !isCurrent()) return;
        const requestId = ++assetImportRequestRef.current;
        const canApply = () => isCurrent() && requestId === assetImportRequestRef.current;
        try {
            const importedAssets = await readAssetPackage(file, canApply);
            if (!canApply()) return;
            importedAssets.forEach((asset) => {
                const payload = { ...asset } as Record<string, unknown>;
                delete payload.id;
                delete payload.createdAt;
                delete payload.updatedAt;
                addAsset(payload as Parameters<typeof addAsset>[0]);
            });
            message.success(t("assets.imported", { count: importedAssets.length }));
        } catch {
            if (canApply()) message.error(t("assets.importFailed"));
        } finally {
            if (canApply() && assetInputRef.current) assetInputRef.current.value = "";
        }
    };

    const openLegacyImport = async () => {
        if (!isCurrent()) return;
        const requestId = ++legacyImportRequestRef.current;
        setLegacyImport({ open: true, loading: true, assets: [] });
        try {
            const oldAssets = await readLegacyAssetCatalog();
            if (!isCurrent() || requestId !== legacyImportRequestRef.current) return;
            setLegacyImport({ open: true, loading: false, assets: oldAssets });
        } catch {
            if (!isCurrent() || requestId !== legacyImportRequestRef.current) return;
            setLegacyImport({ open: true, loading: false, assets: [] });
            message.error(t("assets.legacyImportFailed"));
        }
    };

    const confirmLegacyImport = async () => {
        if (!legacyImport.assets.length || !isCurrent()) return;
        const requestId = ++legacyImportRequestRef.current;
        const canApply = () => isCurrent() && requestId === legacyImportRequestRef.current;
        setLegacyImport((state) => ({ ...state, loading: true }));
        try {
            const result = await importLegacyAssetFiles(legacyImport.assets, canApply);
            if (!canApply()) return;
            const existingLegacyIds = new Set(assets.map((asset) => typeof asset.metadata?.legacyId === "string" ? asset.metadata.legacyId : ""));
            let added = 0;
            result.assets.forEach((asset) => {
                if (existingLegacyIds.has(asset.id)) return;
                const payload = { ...asset, metadata: { ...asset.metadata, source: "legacy-import", legacyId: asset.id } } as Record<string, unknown>;
                delete payload.id;
                delete payload.createdAt;
                delete payload.updatedAt;
                addAsset(payload as Parameters<typeof addAsset>[0]);
                existingLegacyIds.add(asset.id);
                added += 1;
            });
            message.success(t("assets.legacyImported", { count: added }));
            if (result.missingMedia) message.warning(t("assets.legacyMissingMedia", { count: result.missingMedia }));
            setLegacyImport({ open: false, loading: false, assets: [] });
        } catch {
            if (!canApply()) return;
            setLegacyImport((state) => ({ ...state, loading: false }));
            message.error(t("assets.legacyImportFailed"));
        }
    };

    const confirmDelete = () => {
        if (!deletingAsset || !isCurrent()) return;
        removeAsset(deletingAsset.id);
        message.success(t("assets.deleted"));
        setDeletingAsset(null);
    };

    return (
        <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
            <main aria-labelledby="asset-workspace-title" className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4 md:px-6 md:py-6">
                <div className="mx-auto max-w-[1076px] space-y-6">
                <WorkspaceHeading id="asset-workspace-title" title={t("assets.title")} action={
                    <WorkspaceButton type="button" variant="outline" className={workspaceAction} onClick={openCreate}><Plus aria-hidden="true" />{t("assets.add")}</WorkspaceButton>
                } />
                <section aria-labelledby="local-assets-title" className="space-y-4">
                    <h2 id="local-assets-title" className="text-lg font-semibold">{t("assets.localMaterials")}</h2>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div role="search" aria-label={t("assets.localSearch")} className="relative w-full min-w-0 sm:max-w-md">
                            <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-3.5 size-4 text-muted-foreground" />
                            <WorkspaceInput ref={localSearch} type="search" aria-label={t("assets.localSearch")} placeholder={t("assets.localSearch")}
                                className="h-11 pl-9 pr-12 [&::-webkit-search-cancel-button]:hidden" value={keyword}
                                onChange={event => { setPage(1); setKeyword(event.target.value); }} />
                            {keyword ? <WorkspaceButton type="button" variant="ghost" size="icon" className="absolute inset-y-0 right-0 size-11"
                                aria-label={t("generationHistory.clearSearch")} onClick={() => { setPage(1); setKeyword(""); localSearch.current?.focus(); }}><X aria-hidden="true" /></WorkspaceButton> : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <WorkspaceButton type="button" variant="outline" className={workspaceAction} onClick={() => assetInputRef.current?.click()}><Upload aria-hidden="true" />{t("assets.import")}</WorkspaceButton>
                            <WorkspaceButton type="button" variant="outline" className={workspaceAction} onClick={() => void exportAllAssets()}><Download aria-hidden="true" />{t("assets.export")}</WorkspaceButton>
                            <WorkspaceButton type="button" variant="ghost" className={workspaceAction} onClick={() => void openLegacyImport()}>{t("assets.legacyImport")}</WorkspaceButton>
                        </div>
                    </div>
                    <div role="group" aria-label={t("assets.type")} className="flex flex-wrap gap-2">
                        {kindOptions.map(option => <WorkspaceButton key={option} type="button" variant={kindFilter === option ? "secondary" : "outline"}
                            className={workspaceAction} aria-pressed={kindFilter === option} onClick={() => { setPage(1); setKindFilter(option); }}>
                            {option === "all" ? t("common.all") : t(`assets.kinds.${option}`)}
                        </WorkspaceButton>)}
                    </div>
                    <div className="grid items-start gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {visibleAssets.map((asset) => (
                            <AssetCard key={asset.id} asset={asset} onOpen={() => setPreviewAsset(asset)} onEdit={() => openEdit(asset)} onCopy={copyAssetText} onDownload={downloadImage} onDelete={() => setDeletingAsset(asset)} />
                        ))}
                    </div>

                    {!localReady ? <WorkspaceFeedback state="loading">{t("assets.localLoading")}</WorkspaceFeedback> : !filteredAssets.length ? <WorkspaceFeedback state="empty" action={hasLocalFilter ? <WorkspaceButton type="button" variant="outline" className={workspaceAction}
                        onClick={() => { clearLocalFilters(); localSearch.current?.focus(); }}>{t("assets.clearFilters")}</WorkspaceButton> : null}>
                        {t(hasLocalFilter ? "assets.filteredEmpty" : "assets.localEmpty")}
                    </WorkspaceFeedback> : null}

                    <div className="flex justify-center">
                        <AssetPagination
                            current={page}
                            pageSize={pageSize}
                            total={filteredAssets.length}
                            onChange={(nextPage, nextPageSize) => {
                                setPage(nextPage);
                                setPageSize(nextPageSize);
                            }}
                        />
                    </div>
                </section>

                {cloudEnabled ? (
                    <section aria-labelledby="cloud-assets-title" className="border-t border-border pt-5">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                                <h2 id="cloud-assets-title" className="text-lg font-semibold text-foreground">{t("assets.cloudStorage")}</h2>
                                <p className="mt-1 text-sm text-muted-foreground">{t("assets.cloudStorageDescription")}</p>
                                {cloudQuota ? <p className="mt-2 text-xs text-muted-foreground">{t("assets.cloudQuota", { used: cloudQuota.usedBytes === 0 ? "0 B" : formatBytes(cloudQuota.usedBytes), quota: formatBytes(cloudQuota.quotaBytes) })}</p> : null}
                            </div>
                            <WorkspaceButton type="button" variant="outline" className={`${workspaceAction} self-start`} disabled={cloudLoading || cloudDeleting} aria-busy={cloud.uploading} onClick={() => cloudInputRef.current?.click()}>
                                <Upload aria-hidden="true" />{t(cloud.uploading ? "assets.cloudUploading" : "assets.cloudUpload")}
                            </WorkspaceButton>
                        </div>
                        {cloudLoadError ? (
                            <div className="mt-4"><WorkspaceFeedback state="error" description={cloudMedia.length ? t("assets.cloudRetained") : undefined}
                                action={<WorkspaceButton type="button" variant="outline" className={workspaceAction} disabled={cloudLoading || cloudDeleting} onClick={retryCloudMedia}>
                                    <RefreshCw aria-hidden="true" />{t("generationHistory.retry")}
                                </WorkspaceButton>}>{cloudLoadError}</WorkspaceFeedback></div>
                        ) : null}
                        {cloud.loading ? <div className="mt-4"><WorkspaceFeedback state="loading">{t("assets.cloudLoading")}</WorkspaceFeedback></div> : null}
                        {cloudMedia.length ? (
                            <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                                {cloudMedia.map((item) => { const preview = cloud.previews[item.id]; return (
                                    <div key={item.id} className="overflow-hidden rounded-xl border border-border">
                                        {preview?.url ? item.kind === "image" ? <img src={preview.url} onError={() => cloudReaderRef.current?.previewFailed(item.id)} alt="" className="aspect-[4/3] w-full object-cover" /> : item.kind === "video" ? <video src={preview.url} onError={() => cloudReaderRef.current?.previewFailed(item.id)} controls className="aspect-[4/3] w-full bg-muted object-contain" /> : <audio src={preview.url} onError={() => cloudReaderRef.current?.previewFailed(item.id)} controls className="w-full p-3" /> : preview?.status === "error" ? <div className="flex aspect-[4/3] flex-col items-center justify-center gap-2 p-3 text-center text-xs text-muted-foreground"><span>{t("assets.cloudPreviewFailed", { defaultValue: "预览读取失败" })}</span><Button type="text" size="small" icon={<RefreshCw className="size-3.5" />} onClick={() => void cloudReaderRef.current?.preview(item.id)}>{t("assets.retry", { defaultValue: "手动重试" })}</Button></div> : <div className="flex aspect-[4/3] items-center justify-center text-xs text-muted-foreground">{t("assets.cloudLoading")}</div>}
                                        <div className="flex items-center justify-between gap-2 p-3 text-xs text-muted-foreground">
                                            <span className="min-w-0 break-words">{formatBytes(item.sizeBytes)} · {item.contentType}</span>
                                            <Button type="text" danger size="small" disabled={cloud.uploading || cloudDeleting} onClick={() => deleteCloudMedia(item)}>{t("common.delete")}</Button>
                                        </div>
                                    </div>
                                ); })}
                            </div>
                        ) : !cloudLoadError && !cloudLoading && cloudQuota ? <div className="mt-4"><WorkspaceFeedback state="empty">{t("assets.cloudEmpty")}</WorkspaceFeedback></div> : null}
                    </section>
                ) : <section aria-labelledby="cloud-assets-title" className="space-y-3 border-t border-border pt-5"><h2 id="cloud-assets-title" className="text-lg font-semibold">{t("assets.cloudStorage")}</h2><WorkspaceFeedback state="empty">{t("assets.cloudUnavailable")}</WorkspaceFeedback></section>}
                </div>

            </main>

            <Modal title={editingAsset ? t("assets.edit") : t("assets.add")} open={isAssetOpen} width={980} onCancel={() => setIsAssetOpen(false)} onOk={() => void saveAsset()} okText={t("common.save")} cancelText={t("common.cancel")} destroyOnHidden>
                <div className="grid gap-6 pt-1 lg:grid-cols-[minmax(0,1fr)_320px]">
                    <form ref={formRef} className="min-w-0 space-y-4" onSubmit={(event) => event.preventDefault()}>
                        <div className="space-y-2">
                            <label htmlFor="asset-kind" className="block text-sm font-medium">{t("assets.type")}</label>
                            <Select value={form.kind} onValueChange={(value) => { if (value !== "text" && value !== "image") return; setFormKind(value); setForm((state) => ({ ...state, kind: value })); }}>
                                <SelectTrigger id="asset-kind" className="h-10 w-full"><SelectValue /></SelectTrigger>
                                <SelectContent position="popper" className="z-[1300]"><SelectItem value="text">{t("assets.kinds.text")}</SelectItem><SelectItem value="image">{t("assets.kinds.image")}</SelectItem></SelectContent>
                            </Select>
                        </div>
                        <div className="space-y-2">
                            <label htmlFor="asset-title" className="block text-sm font-medium">{t("assets.fields.title")}</label>
                            <Input id="asset-title" required size="large" value={form.title} onChange={(event) => setForm((state) => ({ ...state, title: event.target.value }))} placeholder={t("assets.fields.titlePlaceholder")} />
                        </div>
                        <div className="space-y-2">
                            <label htmlFor="asset-cover" className="block text-sm font-medium">{t("assets.fields.coverUrl")}</label>
                            <div className="flex gap-2">
                                <Input id="asset-cover" value={form.coverUrl} onChange={(event) => setForm((state) => ({ ...state, coverUrl: event.target.value }))} placeholder={t("assets.fields.coverPlaceholder")} />
                                <Button icon={<Upload className="size-3.5" />} onClick={() => coverInputRef.current?.click()}>
                                    {t("common.upload")}
                                </Button>
                            </div>
                        </div>
                        <div className="space-y-2">
                            <label htmlFor="asset-tags" className="block text-sm font-medium">{t("assets.fields.tags")}</label>
                            <AssetTagsInput id="asset-tags" value={form.tags} onChange={(tags) => setForm((state) => ({ ...state, tags }))} placeholder={t("assets.fields.tagsPlaceholder")} />
                        </div>
                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2"><label htmlFor="asset-source" className="block text-sm font-medium">{t("assets.fields.source")}</label>
                                <Input id="asset-source" value={form.source || ""} onChange={(event) => setForm((state) => ({ ...state, source: event.target.value }))} placeholder={t("assets.fields.sourcePlaceholder")} />
                            </div>
                            <div className="space-y-2"><label htmlFor="asset-note" className="block text-sm font-medium">{t("assets.fields.note")}</label>
                                <Input id="asset-note" value={form.note || ""} onChange={(event) => setForm((state) => ({ ...state, note: event.target.value }))} placeholder={t("assets.fields.optional")} />
                            </div>
                        </div>
                        {formKind === "text" ? (
                            <div className="space-y-2"><label htmlFor="asset-content" className="block text-sm font-medium">{t("assets.fields.textContent")}</label>
                                <Input.TextArea id="asset-content" required value={form.content || ""} onChange={(event) => setForm((state) => ({ ...state, content: event.target.value }))} rows={8} placeholder={t("assets.fields.textPlaceholder")} />
                            </div>
                        ) : (
                            <div className="space-y-2"><span className="block text-sm font-medium">{t("assets.fields.imageContent")}</span>
                                <div className="rounded-lg border border-dashed border-border p-4">
                                    <Button icon={<Upload className="size-4" />} onClick={() => imageInputRef.current?.click()}>
                                        {t("assets.selectImageFile")}
                                    </Button>
                                    {imageDraft ? (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {imageDraft.width}x{imageDraft.height} · {formatBytes(imageDraft.bytes)}
                                        </Typography.Text>
                                    ) : (
                                        <Typography.Text type="secondary" className="ml-3 text-xs">
                                            {t("assets.noImageSelected")}
                                        </Typography.Text>
                                    )}
                                </div>
                            </div>
                        )}
                    </form>
                    <div className="rounded-xl border border-border bg-muted/50 p-4">
                        <Typography.Text strong>{t("assets.preview")}</Typography.Text>
                        <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background">
                            {coverUrl || imageDraft?.dataUrl ? (
                                <img src={coverUrl || imageDraft?.dataUrl} alt="" className="aspect-[4/3] w-full object-cover" />
                            ) : (
                                <div className="flex aspect-[4/3] items-center justify-center bg-muted p-5 text-center text-sm text-muted-foreground">{content || t("assets.noCover")}</div>
                            )}
                            <div className="p-4">
                                <Typography.Text strong className="block truncate">
                                    {title || t("assets.untitled")}
                                </Typography.Text>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                    {tags.length ? (
                                        tags.map((tag) => (
                                            <Tag key={tag} className="m-0 max-w-full truncate">
                                                {tag}
                                            </Tag>
                                        ))
                                    ) : (
                                        <Tag className="m-0 max-w-full truncate">{t("assets.untagged")}</Tag>
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                <input
                    ref={coverInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readCoverFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
                <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void readImageFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
            </Modal>

            <AssetDrawer asset={previewAsset} onClose={() => setPreviewAsset(null)} onCopy={copyAssetText} onDownload={downloadImage} />

            <input ref={assetInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importAssetZip(event.target.files?.[0])} />
            <input ref={cloudInputRef} type="file" accept="image/*,video/*,audio/*" className="hidden" onChange={(event) => void uploadCloudMedia(event.target.files?.[0])} />

            <Modal title={t("assets.cloudDelete")} open={Boolean(deletingCloudMedia)} closable={false} maskClosable={false} confirmLoading={cloudDeleting} onCancel={() => setDeletingCloudMedia(null)} onOk={() => void confirmDeleteCloudMedia()} okText={t("common.delete")} okButtonProps={{ danger: true, disabled: cloud.uploading }} cancelText={t("common.cancel")}>
                {t("assets.cloudDeleteConfirm")}
            </Modal>

            <Modal
                title={t("assets.legacyImportTitle")}
                open={legacyImport.open}
                confirmLoading={legacyImport.loading}
                onCancel={() => {
                    ++legacyImportRequestRef.current;
                    setLegacyImport({ open: false, loading: false, assets: [] });
                }}
                onOk={() => void confirmLegacyImport()}
                okText={t("assets.legacyImportConfirm")}
                cancelText={t("common.cancel")}
                okButtonProps={{ disabled: legacyImport.loading || !legacyImport.assets.length, loading: legacyImport.loading }}
            >
                {legacyImport.loading ? (
                    <Typography.Text>{t("assets.legacyImportLoading")}</Typography.Text>
                ) : legacyImport.assets.length ? (
                    <Typography.Paragraph className="!mb-0">
                        {t("assets.legacyImportDescription", { count: legacyImport.assets.length })}
                    </Typography.Paragraph>
                ) : (
                    <Typography.Paragraph className="!mb-0">{t("assets.legacyImportEmpty")}</Typography.Paragraph>
                )}
            </Modal>

            <Modal title={t("assets.deleteTitle")} open={Boolean(deletingAsset)} onCancel={() => setDeletingAsset(null)} onOk={confirmDelete} okText={t("common.delete")} okButtonProps={{ danger: true }} cancelText={t("common.cancel")}>
                {t("assets.deleteConfirm", { name: deletingAsset?.title })}
            </Modal>
        </div>
    );
}

function AssetCard({ asset, onOpen, onEdit, onCopy, onDownload, onDelete }: { asset: Asset; onOpen: () => void; onEdit: () => void; onCopy: (asset: Asset) => void; onDownload: (asset: Asset) => void; onDelete: () => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const cover = assetCoverUrl(asset);
    const summary = assetSummary(asset);
    return (
        <article className="min-w-0 overflow-hidden rounded-xl border border-border bg-card text-card-foreground">
            <button type="button" aria-label={`${t("common.view")} ${asset.title}`} className="block w-full p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" onClick={onOpen}>
                <span className="mb-3 flex items-center gap-2 text-xs text-muted-foreground">
                    {asset.kind === "text" ? <FileText aria-hidden className="size-4" /> : asset.kind === "image" ? <ImageIcon aria-hidden className="size-4" /> : <Video aria-hidden className="size-4" />}
                    {t(`assets.kinds.${asset.kind}`)} · {asset.source || t("assets.unknownSource")}
                </span>
                {asset.kind !== "text" || cover ? cover ? <img src={cover} alt={asset.title} className="mb-3 aspect-video w-full rounded-lg object-cover" /> : <span className="mb-3 flex aspect-video items-center justify-center rounded-lg bg-muted p-4 text-sm text-muted-foreground">{t("assets.noCover")}</span> : null}
                <h3 className="break-words text-base font-semibold leading-6">{asset.title}</h3>
                <p className="mt-2 line-clamp-3 break-words text-sm leading-6 text-muted-foreground">{summary}</p>
                <p className="mt-3 break-words text-xs leading-5 text-muted-foreground">{asset.tags?.length ? asset.tags.join(" · ") : t("assets.noTags")}</p>
            </button>
            <div className="flex flex-wrap items-center gap-2 px-4 pb-4 [&_button]:min-h-9">
                <Button size="small" onClick={onOpen}>
                    {t("common.view")}
                </Button>
                {asset.kind !== "video" ? (
                    <Button size="small" icon={<PencilLine className="size-3.5" />} onClick={onEdit}>
                        {t("common.edit")}
                    </Button>
                ) : null}
                {asset.kind === "text" ? (
                    <Button size="small" icon={<Copy className="size-3.5" />} onClick={() => void onCopy(asset)}>
                        {t("common.copy")}
                    </Button>
                ) : null}
                {asset.kind === "image" || asset.kind === "video" ? (
                    <Button size="small" icon={<Download className="size-3.5" />} onClick={() => onDownload(asset)}>
                        {t("common.download")}
                    </Button>
                ) : null}
                <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={onDelete}>
                    {t("common.delete")}
                </Button>
            </div>
        </article>
    );
}

function AssetDrawer({ asset, onClose, onCopy, onDownload }: { asset: Asset | null; onClose: () => void; onCopy: (asset: Asset) => void; onDownload: (asset: Asset) => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const cover = asset ? asset.coverUrl || (asset.kind === "image" ? asset.data.dataUrl : "") : "";
    return (
        <Drawer title={t("assets.details")} open={Boolean(asset)} size="large" onClose={onClose}>
            {asset ? (
                <div className="space-y-5">
                    {cover ? (
                        <Image src={assetCoverUrl(asset)} preview={{ src: cover }} alt={asset.title} className="rounded-lg" />
                    ) : (
                        <div className="rounded-lg border border-border bg-muted/50 p-5 text-sm leading-6 text-muted-foreground">{asset.kind === "text" ? asset.data.content : t("assets.noCover")}</div>
                    )}
                    <div>
                        <h2 className="mb-2 text-lg font-semibold break-words">
                            {asset.title}
                        </h2>
                        <div className="flex flex-wrap gap-1">
                            <Tag>{t(`assets.kinds.${asset.kind}`)}</Tag>
                            {(asset.tags || []).map((tag) => (
                                <Tag key={tag}>{tag}</Tag>
                            ))}
                        </div>
                    </div>
                    <div className="rounded-lg border border-border p-4">
                        <Typography.Text type="secondary" className="block text-xs">
                            {t("assets.fields.textContent")}
                        </Typography.Text>
                        {asset.kind === "text" ? (
                            <Typography.Paragraph className="mt-2 whitespace-pre-wrap">{asset.data.content}</Typography.Paragraph>
                        ) : asset.kind === "video" ? (
                            <video src={asset.data.url} controls className="mt-2 aspect-video w-full rounded-lg bg-muted" />
                        ) : (
                            <Typography.Text className="mt-2 block">
                                {asset.data.width}x{asset.data.height} · {formatBytes(asset.data.bytes)} · {asset.data.mimeType}
                            </Typography.Text>
                        )}
                    </div>
                    {asset.note ? (
                        <div>
                            <Typography.Text type="secondary">{t("assets.fields.note")}</Typography.Text>
                            <Typography.Paragraph className="mt-1">{asset.note}</Typography.Paragraph>
                        </div>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                        {asset.kind === "text" ? (
                            <Button type="primary" icon={<Copy className="size-4" />} onClick={() => onCopy(asset)}>
                                {t("assets.copyText")}
                            </Button>
                        ) : null}
                        {asset.kind === "image" || asset.kind === "video" ? (
                            <Button type="primary" icon={<Download className="size-4" />} onClick={() => onDownload(asset)}>
                                {asset.kind === "video" ? t("assets.downloadVideo") : t("assets.downloadImage")}
                            </Button>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </Drawer>
    );
}

async function readAssetMediaBlob(asset: Extract<Asset, { kind: "image" | "video" }>) {
    const storageKey = asset.data.storageKey;
    if (storageKey) {
        const stored = asset.kind === "image" ? await getImageBlob(storageKey) : await getMediaBlob(storageKey);
        if (stored) return stored;
    }
    const url = asset.kind === "video" ? asset.data.url : asset.data.dataUrl || asset.coverUrl;
    if (!url) return null;
    const response = await fetch(url);
    return response.ok ? response.blob() : null;
}

function assetSummary(asset: Asset) {
    if (asset.kind === "text") return asset.data.content;
    return `${asset.data.width}x${asset.data.height} · ${formatBytes(asset.data.bytes)} · ${asset.data.mimeType}`;
}

function assetSearchText(asset: Asset) {
    return [asset.title, asset.source || "", asset.note || "", (asset.tags || []).join(" "), asset.kind === "text" ? asset.data.content : asset.data.mimeType].join(" ").toLowerCase();
}
