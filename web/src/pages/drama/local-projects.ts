import localforage from "localforage";

import { accountScopedStoreName } from "@/services/saas/account-local-scope";
import type { DraftAccountScope } from "@/services/saas/drafts";
import { useAccountStore } from "@/stores/use-account-store";

export type DramaProject = { schemaVersion: 1; id: string; name: string; createdAt: number };
export const sameDramaScope = (a: DraftAccountScope | null, b: DraftAccountScope | null) => !!a && !!b && a.accountId === b.accountId && a.epoch === b.epoch;

/** Pin both the account and its store before any asynchronous local operation. */
export function captureDramaProjects(isActive = () => true) {
    const scope = useAccountStore.getState().getDraftScope();
    if (!scope) throw new Error("请先确认当前账户。");
    const store = localforage.createInstance({ name: "infinite-canvas", storeName: accountScopedStoreName("drama_projects", scope) });
    const isCurrent = () => sameDramaScope(scope, useAccountStore.getState().getDraftScope());
    const assertCurrent = () => { if (!isActive() || !isCurrent()) throw new Error("项目页面或账户已变化，请重新打开短剧项目。"); };
    const read = async () => {
        assertCurrent();
        const projects: DramaProject[] = [];
        for (const key of await store.keys()) {
            const value = await store.getItem<unknown>(key);
            assertCurrent();
            const project = value as DramaProject | null;
            if (!project || project.schemaVersion !== 1 || typeof project.id !== "string" || !project.id || key !== `project:${project.id}` || typeof project.name !== "string" || !project.name.trim() || !Number.isSafeInteger(project.createdAt) || project.createdAt < 0) {
                throw new Error("本机短剧项目数据无法读取，原数据已保留。请勿清理浏览器数据。");
            }
            projects.push(project);
        }
        assertCurrent();
        return projects.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
    };
    return {
        scope, isCurrent, read,
        async create(name: string) {
            if (!name.trim()) throw new Error("请输入项目名称。");
            // Recheck storage before a write; corruption is never treated as empty.
            const projects = await read();
            const project: DramaProject = { schemaVersion: 1, id: crypto.randomUUID(), name: name.trim(), createdAt: Date.now() };
            const key = `project:${project.id}`;
            if (await store.getItem(key) !== null) throw new Error("项目标识冲突，请重新读取项目。");
            assertCurrent();
            // Each creation writes one new key, never replacing an existing list.
            await store.setItem(key, project);
            assertCurrent();
            return { project, projects: [project, ...projects] };
        },
    };
}
