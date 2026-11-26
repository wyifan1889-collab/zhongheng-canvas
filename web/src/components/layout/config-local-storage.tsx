import { Alert, Button, Spin } from "@/components/creation/ui";
import { Progress } from "./config-ui";
import { ChevronDown, Database, HardDrive, Layers3, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { readLocalStorageUsage, type LocalStorageUsage } from "@/services/local-storage-usage";
import { useCreationUi } from "@/components/creation/ui/context";

export function ConfigLocalStorage({ active }: { active: boolean }) {
    const { t } = useTranslation();
    const owned = useCreationUi();
    const [usage, setUsage] = useState<LocalStorageUsage | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState("");

    const refresh = useCallback(async () => {
        setLoading(true);
        setError("");
        try {
            setUsage(await readLocalStorageUsage());
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : t("config.localStorage.readFailed"));
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => {
        if (active && !usage) void refresh();
    }, [active, refresh, usage]);

    const indexedDbBytes = usage?.contentBytes ?? 0;
    const percent = usage?.quota ? Math.min(100, (usage.usage / usage.quota) * 100) : 0;

    if (owned) return <section className="space-y-6 py-6" aria-label="本机存储">
        <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
                <h2 className="m-0 text-sm font-semibold">此浏览器的存储空间</h2>
                <p className="mb-0 mt-2 text-sm text-muted-foreground">本机画布与素材保存在当前浏览器，清理网站数据会将它们删除。</p>
            </div>
            <Button type="text" icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>{t("config.localStorage.refresh")}</Button>
        </div>
        {error && <Alert type="error" showIcon title={t("config.localStorage.readFailed")} description={error} />}
        {!usage && loading ? <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Spin size="small" />正在读取存储空间…</div> : usage ? <>
            <div className="space-y-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <p className="m-0 text-sm">已用 <strong className="ml-1 text-xl font-semibold tabular-nums">{formatStorageBytes(usage.usage)}</strong></p>
                    <span className="text-xs text-muted-foreground">{usage.quota ? `浏览器配额 ${formatStorageBytes(usage.quota)}` : "浏览器未提供配额"}</span>
                </div>
                {usage.quota ? <Progress percent={percent} showInfo={false} /> : null}
                <p className="m-0 text-xs text-muted-foreground">包含网站缓存；此处不是账户云空间。</p>
            </div>
            <details className="group border-t border-border pt-4">
                <summary className="flex cursor-pointer list-none items-center justify-between text-sm [&::-webkit-details-marker]:hidden">存储明细<ChevronDown aria-hidden className="size-4 text-muted-foreground transition-transform group-open:rotate-180" /></summary>
                <dl className="mt-4 space-y-3 text-sm">
                    <div className="flex justify-between gap-4"><dt className="text-muted-foreground">作品与素材估算</dt><dd className="m-0 tabular-nums">{formatStorageBytes(indexedDbBytes)}</dd></div>
                    {usage.databases.map(database => <div key={database.name} className="flex justify-between gap-4"><dt className="text-muted-foreground">{t("config.localStorage.mainDatabase")} · v{database.version}</dt><dd className="m-0 tabular-nums">{formatStorageBytes(database.bytes)}</dd></div>)}
                </dl>
            </details>
        </> : null}
    </section>;

    return (
        <div className="space-y-3">
            <section className="rounded-lg border border-border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <div className="flex items-center gap-2 text-sm font-semibold">
                            <Database className="size-4" />
                            {t("config.localStorage.title")}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">{t("config.localStorage.description")}</div>
                    </div>
                    <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void refresh()}>
                        {t("config.localStorage.refresh")}
                    </Button>
                </div>
                {error ? <Alert className="mt-4" type="error" showIcon message={t("config.localStorage.readFailed")} description={error} /> : null}
                {!usage && loading ? (
                    <div className="flex min-h-48 items-center justify-center"><Spin /></div>
                ) : usage ? (
                    <>
                        <div className="mt-4 grid gap-3 sm:grid-cols-3">
                            <StorageMetric icon={<Database className="size-4" />} label={t("config.localStorage.indexedDbUsage")} value={formatStorageBytes(indexedDbBytes)} hint={t("config.localStorage.contentEstimate")} />
                            <StorageMetric icon={<HardDrive className="size-4" />} label={t("config.localStorage.siteUsage")} value={formatStorageBytes(usage.usage)} hint={t("config.localStorage.siteUsageHint")} />
                            <StorageMetric icon={<Layers3 className="size-4" />} label={t("config.localStorage.quota")} value={formatStorageBytes(usage.quota)} hint={usage.quota ? t("config.localStorage.quotaHint") : t("config.localStorage.quotaUnavailable")} />
                        </div>
                        {usage.quota ? (
                            <div className="mt-4">
                                <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                                    <span>{t("config.localStorage.quotaProgress")}</span>
                                    <span className="tabular-nums">{percent.toFixed(2)}%</span>
                                </div>
                                <Progress percent={percent} showInfo={false} />
                            </div>
                        ) : null}
                    </>
                ) : null}
            </section>
            {usage?.databases.map((database) => (
                <section key={database.name} className="overflow-hidden rounded-lg border border-border">
                    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                        <div className="min-w-0">
                            <div className="truncate text-sm font-semibold">{t("config.localStorage.mainDatabase")}</div>
                            <div className="mt-0.5 text-[11px] text-muted-foreground">{t("config.localStorage.siteDataCategory")} · v{database.version}</div>
                        </div>
                        <div className="shrink-0 text-sm font-medium tabular-nums">{formatStorageBytes(database.bytes)}</div>
                    </div>
                </section>
            ))}
        </div>
    );
}

function StorageMetric({ icon, label, value, hint }: { icon: ReactNode; label: string; value: string; hint: string }) {
    return (
        <div className="rounded-lg bg-muted/70 p-3">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">{icon}{label}</div>
            <div className="mt-2 text-xl font-semibold tabular-nums">{value}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{hint}</div>
        </div>
    );
}

function formatStorageBytes(bytes: number | null) {
    if (bytes === null) return "—";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
