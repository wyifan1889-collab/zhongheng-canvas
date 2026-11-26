import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { useConfigStore, type AiConfig, type WebdavSyncConfig } from "@/stores/use-config-store";
import { usePromptSourceStore, type PromptSourceSchedule } from "@/stores/use-prompt-source-store";
import type { PromptSource } from "@/services/api/prompt-source-presets";

type AppConfigFile = {
    app: "infinite-canvas";
    version: 1;
    exportedAt: string;
    config: AiConfig;
    webdav: WebdavSyncConfig;
    promptSources: {
        sources: PromptSource[];
        schedule: PromptSourceSchedule;
    };
};

export function stripConfigParams(url: string) {
    const parsed = new URL(url, "http://localhost");
    parsed.searchParams.delete("baseUrl");
    parsed.searchParams.delete("baseurl");
    parsed.searchParams.delete("apiKey");
    parsed.searchParams.delete("apikey");
    return `${parsed.pathname}${parsed.searchParams.size ? `?${parsed.searchParams}` : ""}${parsed.hash}`;
}

export type ConfigImportGuard = () => boolean;

export function exportAppConfig(isStillAuthorized: ConfigImportGuard) {
    if (!isStillAuthorized()) return false;
    const { config, webdav } = useConfigStore.getState();
    const { sources, schedule } = usePromptSourceStore.getState();
    const data: AppConfigFile = { app: "infinite-canvas", version: 1, exportedAt: new Date().toISOString(), config, webdav, promptSources: { sources, schedule } };
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "infinite-canvas-config.json");
    return true;
}

export async function importAppConfig(file: File, isStillAuthorized: ConfigImportGuard) {
    if (!isStillAuthorized()) throw new Error(i18n.t("config.importContextChanged"));
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error(i18n.t("config.invalidFile"));
    }
    if (data.app !== "infinite-canvas" || data.version !== 1 || !data.config || !data.webdav || !data.promptSources) throw new Error(i18n.t("config.invalidFile"));
    if (!isStillAuthorized()) throw new Error(i18n.t("config.importContextChanged"));
    useConfigStore.setState({ config: data.config, webdav: data.webdav });
    usePromptSourceStore.setState(data.promptSources);
}
