import { beforeEach, describe, expect, test } from "bun:test";

import { importAppConfig, stripConfigParams } from "./config-file";
import { defaultConfig, defaultWebdavSyncConfig, useConfigStore } from "@/stores/use-config-store";
import { usePromptSourceStore } from "@/stores/use-prompt-source-store";
import { useAccountStore } from "@/stores/use-account-store";
import { createPersonalConfigContext } from "@/components/layout/personal-config-context";

const site = { registration: false, cloudCanvas: false, cloudMedia: false, captcha: null };
const fileData = {
    app: "infinite-canvas",
    version: 1,
    exportedAt: "2026-10-31T00:00:00.000Z",
    config: defaultConfig,
    webdav: defaultWebdavSyncConfig,
    promptSources: { sources: [], schedule: { enabled: false, intervalMinutes: 60, lastFetchedAt: "" } },
};

beforeEach(() => {
    useConfigStore.setState({ config: defaultConfig, webdav: defaultWebdavSyncConfig });
    usePromptSourceStore.setState({ sources: [], schedule: fileData.promptSources.schedule });
    useAccountStore.setState({ status: "ready", site, user: null, error: null, busy: false });
});

describe("US1 config file guards", () => {
    test("removes only credential query parameters and preserves other URL state", () => {
        expect(stripConfigParams("/config?apiKey=synthetic&keep=1&baseUrl=https%3A%2F%2Fexample.test#draft")).toBe("/config?keep=1#draft");
    });

    test("does not write after an account context invalidation during file.text", async () => {
        let resolveText!: (value: string) => void;
        const file = { text: () => new Promise<string>((resolve) => { resolveText = resolve; }) } as File;
        let valid = true;
        const beforeConfig = useConfigStore.getState().config;
        const beforeWebdav = useConfigStore.getState().webdav;
        const beforeSources = usePromptSourceStore.getState().sources;
        const pending = importAppConfig(file, () => valid);
        valid = false;
        resolveText(JSON.stringify(fileData));
        await expect(pending).rejects.toThrow("账户状态已变化");
        expect(useConfigStore.getState().config).toBe(beforeConfig);
        expect(useConfigStore.getState().webdav).toBe(beforeWebdav);
        expect(usePromptSourceStore.getState().sources).toBe(beforeSources);
    });

    test("writes once when the guarded personal context remains valid", async () => {
        const file = { text: async () => JSON.stringify(fileData) } as File;
        let checks = 0;
        let configWrites = 0;
        let promptWrites = 0;
        const originalConfigSetState = useConfigStore.setState;
        const originalPromptSetState = usePromptSourceStore.setState;
        useConfigStore.setState = ((...args: Parameters<typeof originalConfigSetState>) => { configWrites += 1; return originalConfigSetState(...args); }) as typeof originalConfigSetState;
        usePromptSourceStore.setState = ((...args: Parameters<typeof originalPromptSetState>) => { promptWrites += 1; return originalPromptSetState(...args); }) as typeof originalPromptSetState;
        try {
            await importAppConfig(file, () => { checks += 1; return true; });
        } finally {
            useConfigStore.setState = originalConfigSetState;
            usePromptSourceStore.setState = originalPromptSetState;
        }
        expect(checks).toBe(2);
        expect(configWrites).toBe(1);
        expect(promptWrites).toBe(1);
        expect(useConfigStore.getState().config).toEqual(defaultConfig);
        expect(usePromptSourceStore.getState().sources).toEqual([]);
    });

    test("invalidates an old store-bound import when a newer file selection starts", async () => {
        const context = () => createPersonalConfigContext()!;
        let resolveA!: (value: string) => void;
        const fileA = { text: () => new Promise<string>((resolve) => { resolveA = resolve; }) } as File;
        const a = context();
        const pendingA = importAppConfig(fileA, a.guard).then(() => null, (error) => error);
        a.dispose();
        let resolveB!: (value: string) => void;
        const fileB = { text: () => new Promise<string>((resolve) => { resolveB = resolve; }) } as File;
        const b = context();
        const pendingB = importAppConfig(fileB, b.guard).then(() => null, (error) => error);
        useAccountStore.setState({ status: "loading", site: null, user: null, error: null, busy: false });
        useAccountStore.setState({ status: "ready", site, user: null, error: null, busy: false });
        resolveA(JSON.stringify(fileData));
        resolveB(JSON.stringify(fileData));
        const [errorA, errorB] = await Promise.all([pendingA, pendingB]);
        expect(errorA?.message).toContain("账户状态已变化");
        expect(errorB?.message).toContain("账户状态已变化");
        expect(usePromptSourceStore.getState().sources).toEqual([]);
        b.dispose();
    });

    test("does not let an old channel callback write after the store leaves personal mode", () => {
        const expectedSite = useAccountStore.getState().site;
        const context = createPersonalConfigContext()!;
        const before = useConfigStore.getState().config;
        useAccountStore.setState({ status: "loading", site: null, user: null, error: null, busy: false });
        useAccountStore.setState({ status: "ready", site: expectedSite, user: null, error: null, busy: false });
        if (context.guard() && useAccountStore.getState().status === "ready") useConfigStore.getState().updateConfig("apiKey", "synthetic");
        expect(useConfigStore.getState().config).toEqual(before);
        context.dispose();
    });
});
