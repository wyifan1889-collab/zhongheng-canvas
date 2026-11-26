import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { App, Empty, Input, Modal, Pagination, Spin, Tabs, Tag } from "@/components/creation/ui";
import { Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/image-utils";
import { getImagePreviewRevision, subscribeImagePreviews } from "@/services/image-storage";
import { CloudMediaError, createMediaClient, type CloudMedia } from "@/services/api/media";
import { assetCoverUrl, useAssetStore, type Asset } from "@/stores/use-asset-store";
import { useAccountStore } from "@/stores/use-account-store";
import { readCloudAssetData, type AssetInsertGuard } from "@/services/saas/canvas-asset-insert";
import type { DraftAccountScope } from "@/services/saas/drafts";

export type InsertAssetPayload =
    | { kind: "text"; content: string; title: string }
    | { kind: "image"; dataUrl: string; title: string; storageKey?: string; cloudMediaId?: string; width?: number; height?: number; bytes?: number; mimeType?: string }
    | { kind: "video"; url: string; title: string; storageKey?: string; cloudMediaId?: string; width?: number; height?: number; bytes?: number; mimeType?: string; durationMs?: number }
    | { kind: "audio"; url: string; title: string; cloudMediaId?: string; bytes?: number; mimeType?: string; durationMs?: number };

type Props = {
    open: boolean;
    defaultTab?: string;
    includeCloudMedia?: boolean;
    onInsert: (payload: InsertAssetPayload, isCurrent?: AssetInsertGuard) => void | Promise<void>;
    onClose: () => void;
};

export function AssetPickerModal({ open, defaultTab = "my-assets", includeCloudMedia = false, onInsert, onClose }: Props) {
    const { t } = useTranslation();
    const account = useAccountStore(), scope = account.getDraftScope();
    const lifetime = useMemo(() => ({ active: open }), [open]);
    const currentLifetime = useRef(lifetime);
    currentLifetime.current = lifetime;
    useLayoutEffect(() => {
        lifetime.active = open;
        return () => { lifetime.active = false; };
    }, [lifetime, open]);
    const isViewCurrent = useCallback(() => lifetime.active && currentLifetime.current === lifetime, [lifetime]);
    const close = () => { lifetime.active = false; onClose(); };
    const [activeTab, setActiveTab] = useState(defaultTab === "cloud-media" && includeCloudMedia ? "cloud-media" : "my-assets");
    const tabEpoch = useRef(0), capturedTabEpoch = tabEpoch.current;
    const isCloudViewCurrent = useCallback(() => isViewCurrent() && activeTab === "cloud-media" &&
        tabEpoch.current === capturedTabEpoch, [activeTab, capturedTabEpoch, isViewCurrent]);
    useEffect(() => {
        if (open) setActiveTab(defaultTab === "cloud-media" && includeCloudMedia ? "cloud-media" : "my-assets");
    }, [defaultTab, includeCloudMedia, open]);
    const myAssets = <MyAssetsTab onInsert={onInsert} />;
    const content = includeCloudMedia ? (
        <Tabs
            activeKey={activeTab}
            onChange={(tab) => { tabEpoch.current += 1; setActiveTab(tab); }}
            items={[
                { key: "my-assets", label: t("canvas.assetPicker.myAssets"), children: myAssets },
                { key: "cloud-media", label: t("canvas.assetPicker.cloudMedia"), children: activeTab === "cloud-media" ? <CloudMediaTab
                    key={`${scope?.accountId}:${scope?.epoch}:${open}:${capturedTabEpoch}`} scope={scope} isViewCurrent={isCloudViewCurrent} onInsert={onInsert} /> : null },
            ]}
        />
    ) : myAssets;
    return (
        <Modal title={t("canvas.assetPicker.title")} open={open} onCancel={close} footer={null} width={860} destroyOnHidden styles={{ body: { padding: "0 24px 24px", minHeight: 480 } }}>
            {content}
        </Modal>
    );
}

const PAGE_SIZE = 8;

const kindOptions = ["all", "text", "image", "video"];

function PickerCard({ title, kind, cover, onClick, disabled = false, loading = false }: { title: string; kind: string; cover: string; onClick: () => void; disabled?: boolean; loading?: boolean }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            disabled={disabled}
            className="group relative cursor-pointer overflow-hidden rounded-lg border border-stone-200 bg-white text-left transition hover:border-stone-400 hover:shadow-md disabled:cursor-wait disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:hover:border-stone-500"
            onClick={onClick}
        >
            {cover ? (
                <img src={cover} alt={title} className="aspect-[4/3] w-full object-cover" />
            ) : (
                <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 p-3 text-center text-xs leading-5 text-stone-500 dark:bg-stone-800 dark:text-stone-400">{title}</div>
            )}
            <div className="p-2.5">
                <div className="flex items-center justify-between gap-2">
                    <span className="line-clamp-1 text-xs font-medium text-stone-800 dark:text-stone-200">{title}</span>
                    <Tag className="m-0 shrink-0 text-[10px]">{t(`assets.kinds.${kind}`)}</Tag>
                </div>
            </div>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-stone-950/0 text-sm font-medium text-white opacity-0 transition group-hover:bg-stone-950/55 group-hover:opacity-100">{loading ? t("canvas.assetPicker.loading") : t("canvas.assetPicker.insert")}</div>
        </button>
    );
}

function MyAssetsTab({ onInsert }: { onInsert: (payload: InsertAssetPayload) => void }) {
    const { t } = useTranslation();
    useSyncExternalStore(subscribeImagePreviews, getImagePreviewRevision);
    const assets = useAssetStore((state) => state.assets);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState("all");
    const [page, setPage] = useState(1);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((a) => a.kind === "text" || a.kind === "image" || a.kind === "video")
            .filter((a) => kindFilter === "all" || a.kind === kindFilter)
            .filter((a) => !query || [a.title, ...(a.tags || [])].join(" ").toLowerCase().includes(query));
    }, [assets, keyword, kindFilter]);

    const visible = useMemo(() => filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), [filtered, page]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
        setPage((v) => Math.min(v, maxPage));
    }, [filtered.length]);

    const handleInsert = (asset: Asset) => {
        if (asset.kind === "text") {
            onInsert({ kind: "text", content: asset.data.content, title: asset.title });
        } else {
            onInsert(asset.kind === "video" ? { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height } : { kind: "image", dataUrl: asset.data.dataUrl, storageKey: asset.data.storageKey, title: asset.title });
        }
    };

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-3">
                <Input
                    className="w-56"
                    size="small"
                    prefix={<Search className="size-3.5 text-stone-400" />}
                    placeholder={t("canvas.assetPicker.search")}
                    value={keyword}
                    allowClear
                    onChange={(e) => {
                        setPage(1);
                        setKeyword(e.target.value);
                    }}
                />
                <div className="flex gap-1.5">
                    {kindOptions.map((option) => (
                        <Tag.CheckableTag
                            key={option}
                            checked={kindFilter === option}
                            className={cn("prompt-filter-tag", kindFilter === option && "is-active")}
                            onChange={() => {
                                setPage(1);
                                setKindFilter(option);
                            }}
                        >
                            {option === "all" ? t("common.all") : t(`assets.kinds.${option}`)}
                        </Tag.CheckableTag>
                    ))}
                </div>
            </div>

            {visible.length ? (
                <div className="grid grid-cols-4 gap-3">
                    {visible.map((asset) => (
                        <PickerCard key={asset.id} title={asset.title} kind={asset.kind} cover={assetCoverUrl(asset)} onClick={() => handleInsert(asset)} />
                    ))}
                </div>
            ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.assetPicker.empty")} className="py-12" />
            )}

            {filtered.length > PAGE_SIZE && (
                <div className="flex justify-center">
                    <Pagination size="small" current={page} pageSize={PAGE_SIZE} total={filtered.length} onChange={setPage} showSizeChanger={false} />
                </div>
            )}
        </div>
    );
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("media_read_failed"));
        reader.readAsDataURL(blob);
    });
}

function cloudMediaTitle(item: CloudMedia, t: (key: string) => string) {
    return `${t(`assets.kinds.${item.kind}`)} · ${item.id.slice(0, 8)}`;
}

function CloudMediaTab({ scope, isViewCurrent, onInsert }: {
    scope: DraftAccountScope | null;
    isViewCurrent: AssetInsertGuard;
    onInsert: Props["onInsert"];
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const cloudEnabled = useAccountStore((state) => state.site?.cloudMedia === true && !!scope);
    const mounted = useRef(false);
    useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const isCurrent = useCallback(() => {
        const account = useAccountStore.getState(), current = account.getDraftScope();
        return mounted.current && isViewCurrent() && !!scope && account.site?.cloudMedia === true &&
            current?.accountId === scope.accountId && current.epoch === scope.epoch;
    }, [scope?.accountId, scope?.epoch, isViewCurrent]);
    const cloudMediaClient = useMemo(() => createMediaClient(() => isCurrent() ? scope!.accountId : null), [isCurrent]);
    const [items, setItems] = useState<CloudMedia[]>([]);
    const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
    const [loading, setLoading] = useState(false);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [kindFilter, setKindFilter] = useState<"all" | CloudMedia["kind"]>("all");
    const [quotaText, setQuotaText] = useState("");

    useEffect(() => {
        if (!cloudEnabled || !isCurrent()) {
            setItems([]);
            setPreviewUrls({});
            return;
        }
        let active = true;
        setLoading(true);
        void cloudMediaClient.list().then((result) => {
            if (!active || !isCurrent()) return;
            setItems(result.items);
            setQuotaText(`${formatBytes(result.quota.usedBytes) || "0 B"} / ${formatBytes(result.quota.quotaBytes)}`);
        }).catch((error) => {
            if (active && isCurrent()) message.error(error instanceof CloudMediaError ? error.message : t("canvas.assetPicker.cloudLoadFailed"));
        }).finally(() => { if (active && isCurrent()) setLoading(false); });
        return () => { active = false; };
    }, [cloudEnabled, cloudMediaClient, isCurrent, t]);

    useEffect(() => {
        if (!items.length) {
            setPreviewUrls({});
            return;
        }
        let active = true;
        const urls: Record<string, string> = {};
        const release = () => { for (const [id, url] of Object.entries(urls)) { URL.revokeObjectURL(url); delete urls[id]; } };
        void Promise.allSettled(items.map(async (item) => {
            if (!active || !isCurrent()) return;
            const blob = await cloudMediaClient.download(item.id);
            if (!active || !isCurrent()) return;
            urls[item.id] = URL.createObjectURL(blob);
        })).then(() => {
            if (active && isCurrent()) setPreviewUrls({ ...urls });
            else release();
        });
        return () => {
            active = false;
            release();
        };
    }, [items, cloudMediaClient, isCurrent]);

    const filtered = items.filter((item) => kindFilter === "all" || item.kind === kindFilter);
    const insertCloudMedia = async (item: CloudMedia) => {
        if (!isCurrent()) return;
        setBusyId(item.id);
        try {
            const dataUrl = await readCloudAssetData({ mediaId: item.id, download: cloudMediaClient.download,
                toDataUrl: blobToDataUrl, isCurrent });
            if (!isCurrent()) return;
            const title = cloudMediaTitle(item, t);
            if (item.kind === "image") await onInsert({ kind: "image", dataUrl, title, cloudMediaId: item.id, bytes: item.sizeBytes, mimeType: item.contentType }, isCurrent);
            else if (item.kind === "video") await onInsert({ kind: "video", url: dataUrl, title, cloudMediaId: item.id, bytes: item.sizeBytes, mimeType: item.contentType }, isCurrent);
            else await onInsert({ kind: "audio", url: dataUrl, title, cloudMediaId: item.id, bytes: item.sizeBytes, mimeType: item.contentType }, isCurrent);
        } catch (error) {
            if (isCurrent()) message.error(error instanceof CloudMediaError ? error.message : t("canvas.assetPicker.cloudInsertFailed"));
        } finally {
            if (isCurrent()) setBusyId(null);
        }
    };

    if (!cloudEnabled) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.assetPicker.cloudUnavailable")} className="py-12" />;

    return (
        <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex gap-1.5">
                    {(["all", "image", "video", "audio"] as const).map((option) => (
                        <Tag.CheckableTag key={option} checked={kindFilter === option} className={cn("prompt-filter-tag", kindFilter === option && "is-active")} onChange={() => setKindFilter(option)}>
                            {option === "all" ? t("common.all") : t(`assets.kinds.${option}`)}
                        </Tag.CheckableTag>
                    ))}
                </div>
                {quotaText ? <span className="text-xs text-stone-500 dark:text-stone-400">{t("canvas.assetPicker.cloudQuota", { quota: quotaText })}</span> : null}
            </div>
            {loading ? <div className="flex justify-center py-12"><Spin /></div> : filtered.length ? (
                <div className="grid grid-cols-4 gap-3">
                    {filtered.map((item) => {
                        const title = cloudMediaTitle(item, t);
                        return <PickerCard key={item.id} title={title} kind={item.kind} cover={previewUrls[item.id] || ""} onClick={() => void insertCloudMedia(item)} disabled={busyId !== null} loading={busyId === item.id} />;
                    })}
                </div>
            ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.assetPicker.cloudEmpty")} className="py-12" />}
        </div>
    );
}
