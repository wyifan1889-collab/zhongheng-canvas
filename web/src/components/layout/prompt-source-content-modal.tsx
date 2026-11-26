import { Space, Table } from "antd";
import { App, Button, Empty, Modal, Pagination, Spin, Tag, useCreationUi } from "@/components/creation/ui";
import { Copy, FolderPlus, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { PromptDetailDialog } from "@/pages/prompts/components/prompt-detail-dialog";
import { useCopyText } from "@/hooks/use-copy-text";
import { useAssetStore } from "@/stores/use-asset-store";
import { fetchSourcePrompts, refreshSource, type Prompt } from "@/services/api/prompts";
import type { PromptSource } from "@/services/api/prompt-source-presets";

export function PromptSourceContentModal({ source, onClose }: { source: PromptSource | null; onClose: () => void }) {
    const { message } = App.useApp();
    const owned = useCreationUi();
    const { t } = useTranslation();
    const [items, setItems] = useState<Prompt[]>([]);
    const [loading, setLoading] = useState(false);
    const [detail, setDetail] = useState<Prompt | null>(null);
    const [page, setPage] = useState(1);
    const copyText = useCopyText();
    const addAsset = useAssetStore((state) => state.addAsset);

    const load = useCallback(
        async (force: boolean) => {
            if (!source) return;
            setLoading(true);
            try {
                setItems(force ? await refreshSourceItems(source.id) : await fetchSourcePrompts(source.id));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("config.promptSources.content.loadFailed"));
            } finally {
                setLoading(false);
            }
        },
        [source, message, t],
    );

    useEffect(() => {
        if (source) void load(false);
        else setItems([]);
    }, [source, load]);
    useEffect(() => setPage(1), [source?.id]);

    const saveAsset = (item: Prompt) => {
        addAsset({ kind: "text", title: item.title, coverUrl: item.coverUrl, tags: item.tags, source: item.category, data: { content: item.prompt }, metadata: { source: "prompt-library", promptId: item.id, githubUrl: item.githubUrl } });
        message.success(t("common.addedToAssets"));
    };

    return (
        <>
            <Modal
                open={Boolean(source)}
                onCancel={onClose}
                width={980}
                footer={null}
                title={
                    <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
                        <div>
                            <div className="text-base font-semibold">{t("config.promptSources.content.title", { name: source?.name || "" })}</div>
                            <div className="mt-0.5 text-xs font-normal text-muted-foreground">{t("config.promptSources.content.count", { count: items.length })}</div>
                        </div>
                        <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void load(true)}>
                            {t("config.promptSources.content.refresh")}
                        </Button>
                    </div>
                }
            >
                {owned ? <div aria-busy={loading}>
                    {loading ? <div className="flex justify-center py-4"><Spin /></div> : null}
                    <ul className="max-h-[56vh] divide-y divide-border overflow-y-auto" aria-label={t("config.promptSources.content.titleColumn")}>
                        {items.slice((Math.min(page, Math.max(1, Math.ceil(items.length / 10))) - 1) * 10, Math.min(page, Math.max(1, Math.ceil(items.length / 10))) * 10).map(item => <li key={item.id} className="flex min-w-0 gap-3 py-3">
                            {item.coverUrl ? <img src={item.coverUrl} alt="" className="size-12 shrink-0 rounded object-cover" /> : <div className="size-12 shrink-0 rounded bg-muted" />}
                            <div className="min-w-0 flex-1">
                                <div className="break-words text-sm font-medium">{item.title}</div>
                                <div className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">{item.prompt}</div>
                                <div className="mt-2 flex flex-wrap gap-1">{item.tags.slice(0, 4).map(tag => <Tag key={tag}>{tag}</Tag>)}</div>
                                <div className="mt-2 flex flex-wrap gap-1">
                                    <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => copyText(item.prompt, t("common.promptCopied"))}>{t("common.copy")}</Button>
                                    <Button size="small" type="text" onClick={() => setDetail(item)}>{t("common.details")}</Button>
                                    <Button size="small" type="text" icon={<FolderPlus className="size-3.5" />} onClick={() => saveAsset(item)}>{t("common.addToAssets")}</Button>
                                </div>
                            </div>
                        </li>)}
                    </ul>
                    {!items.length && !loading ? <Empty description={t("config.promptSources.content.empty")} /> : null}
                    {items.length > 10 ? <Pagination current={Math.min(page, Math.ceil(items.length / 10))} pageSize={10} total={items.length} onChange={setPage} className="mt-3" /> : null}
                </div> : <Table<Prompt>
                    rowKey="id"
                    size="small"
                    loading={loading}
                    dataSource={items}
                    pagination={{ pageSize: 10, showSizeChanger: false, size: "small" }}
                    scroll={{ y: "56vh" }}
                    locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("config.promptSources.content.empty")} /> }}
                    columns={[
                        {
                            title: t("config.promptSources.content.cover"),
                            dataIndex: "coverUrl",
                            width: 72,
                            render: (coverUrl: string) => (coverUrl ? <img src={coverUrl} alt="" className="size-12 rounded object-cover" /> : <div className="size-12 rounded bg-muted" />),
                        },
                        {
                            title: t("config.promptSources.content.titleColumn"),
                            dataIndex: "title",
                            render: (title: string, item) => (
                                <div className="min-w-0">
                                    <div className="truncate font-medium">{title}</div>
                                    <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.prompt}</div>
                                </div>
                            ),
                        },
                        {
                            title: t("config.promptSources.content.tags"),
                            dataIndex: "tags",
                            width: 200,
                            render: (tags: string[]) => (
                                <div className="flex flex-wrap gap-1">
                                    {tags.slice(0, 4).map((tag) => (
                                        <Tag key={tag} className="m-0">
                                            {tag}
                                        </Tag>
                                    ))}
                                </div>
                            ),
                        },
                        {
                            title: t("config.promptSources.content.actions"),
                            width: 210,
                            render: (_, item) => (
                                <Space size={4} wrap>
                                    <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={() => copyText(item.prompt, t("common.promptCopied"))}>
                                        {t("common.copy")}
                                    </Button>
                                    <Button size="small" type="text" onClick={() => setDetail(item)}>
                                        {t("common.details")}
                                    </Button>
                                    <Button size="small" type="text" icon={<FolderPlus className="size-3.5" />} onClick={() => saveAsset(item)}>
                                        {t("common.addToAssets")}
                                    </Button>
                                </Space>
                            ),
                        },
                    ]}
                />}
            </Modal>
            <PromptDetailDialog prompt={detail} onClose={() => setDetail(null)} onCopy={(prompt) => copyText(prompt, t("common.promptCopied"))} onSaveAsset={saveAsset} />
        </>
    );
}

async function refreshSourceItems(sourceId: string) {
    await refreshSource(sourceId);
    return fetchSourcePrompts(sourceId);
}
