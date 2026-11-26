import type { JsonObject } from "../../../../packages/shared/src/index";
import { createMediaClient } from "../api/media";
import { AccountDraftStorageError, createAccountDraftStore, type AccountDraftRecord } from "./account-draft-store";
import { inspectCanvasDocument } from "./canvas-document";
import { CloudMediaHydrationError, hydrateCanvasCloudMediaDocument, revokeCloudMediaObjectUrls, type CanvasCloudMediaHydrator } from "./cloud-media-hydration";
import { createDraftClient, DraftError, type DraftAccountScope } from "./drafts";

export type AccountDraftContext = DraftAccountScope & { cloudCanvas: boolean };
export type AccountDraftWorkspaceState = {
    phase: "idle" | "loading" | "ready" | "saving" | "conflict" | "error" | "blocked" | "closed";
    draft: AccountDraftRecord | null;
    project: JsonObject | null;
    dirty: boolean;
};
const messages = {
    account_changed: "账户状态已变化，当前账号草稿已隐藏。请重新确认账户后打开工作区。",
    closed: "账号草稿工作区已关闭，本次返回未采用。",
    cloud_unavailable: "云画布尚未开放或已关闭，本次不读取云稿。",
    busy: "草稿读写尚未结束，请等待后再操作。",
    unsaved_changes: "当前内容尚未保存，请先保留当前修改再打开其他草稿。",
    context_changed: "读取期间当前内容已变化，本次结果未替换当前草稿。",
    no_draft: "尚未打开账号草稿，不能保存。",
    not_found: "该账号下没有找到这份本机草稿，现有内容未被替换。",
    invalid_data: "草稿格式或保存记录不正确，现有内容未被替换。",
    conflict: "另一窗口已修改这份账号草稿，当前内容仍保留，保存已暂停。",
    media_unavailable: "云稿中的云端素材未能完整读取，当前云稿保持只读；请稍后重试或保留本机内容。",
    unavailable: "草稿读写未完成，请保留当前内容；未自动重试或覆盖。",
} as const;
type ErrorCode = keyof typeof messages;
export class AccountDraftWorkspaceError extends Error {
    constructor(public readonly code: ErrorCode) { super(messages[code]); this.name = "AccountDraftWorkspaceError"; }
}

type Store = ReturnType<typeof createAccountDraftStore>;
type Client = Pick<ReturnType<typeof createDraftClient>, "get">;
type MediaClient = CanvasCloudMediaHydrator;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/**
 * Account-bound document staging. No global canvas import, generation, cloud writes
 * or automatic I/O. Cloud media are hydrated only during an explicit document
 * open and still require editor validation.
 * Local revision guards local writes; cloud revision records where that exact body began.
 */
export function createAccountDraftWorkspace(
    getContext: () => AccountDraftContext | null,
    store: Store = createAccountDraftStore(),
    clientFactory: (getScope: () => DraftAccountScope | null) => Client = createDraftClient,
    mediaClientFactory: (getScope: () => DraftAccountScope | null) => MediaClient = (getScope) => createMediaClient(() => getScope()?.accountId ?? null),
) {
    function context() { try { return getContext(); } catch { return null; } }
    const initial = context();
    const bound = initial && typeof initial.accountId === "string" && initial.accountId && Number.isSafeInteger(initial.epoch) && initial.epoch >= 0
        ? { accountId: initial.accountId, epoch: initial.epoch } : null;
    let phase: AccountDraftWorkspaceState["phase"] = "idle";
    let draft: AccountDraftRecord | null = null, project: JsonObject | null = null;
    let invalidated = false, disposed = false, busy = false, paused = false, editVersion = 0;
    let cloudMediaObjectUrls: string[] = [];
    let client: Client | undefined;
    let mediaClient: MediaClient | undefined;

    function clearCloudMediaObjectUrls() {
        revokeCloudMediaObjectUrls(cloudMediaObjectUrls);
        cloudMediaObjectUrls = [];
    }

    function invalidate() {
        invalidated = true;
        clearCloudMediaObjectUrls();
        draft = null; project = null; client = undefined;
        mediaClient = undefined;
        phase = disposed ? "closed" : "blocked";
    }
    function assertCurrent(cloud = false) {
        if (disposed) { invalidate(); throw new AccountDraftWorkspaceError("closed"); }
        const current = context();
        if (invalidated || !bound || !current || current.accountId !== bound.accountId || current.epoch !== bound.epoch) {
            invalidate(); throw new AccountDraftWorkspaceError("account_changed");
        }
        if (cloud && current.cloudCanvas !== true) throw new AccountDraftWorkspaceError("cloud_unavailable");
    }
    function scope() {
        try { assertCurrent(); return { ...bound! }; } catch { return null; }
    }
    function dirty() { return project !== null && (draft === null || !same(project, draft.project)); }
    function assertReplaceable() {
        assertCurrent();
        if (busy) throw new AccountDraftWorkspaceError("busy");
        if (paused || dirty()) throw new AccountDraftWorkspaceError("unsaved_changes");
    }
    function snapshot(value: unknown) {
        try {
            const result = inspectCanvasDocument(value).snapshot;
            if (typeof result.id !== "string" || !result.id) throw new Error();
            return result;
        } catch { throw new AccountDraftWorkspaceError("invalid_data"); }
    }
    function assertView(version: number, cloud = false) {
        assertCurrent(cloud);
        if (version !== editVersion) throw new AccountDraftWorkspaceError("context_changed");
    }
    function guard(version?: number, cloud = false) {
        return () => {
            try { if (version === undefined) assertCurrent(cloud); else assertView(version, cloud); return true; }
            catch { return false; }
        };
    }
    function adopt(value: AccountDraftRecord) {
        draft = copy(value); project = copy(value.project); editVersion++;
    }
    async function hydrateCloudProject(value: JsonObject) {
        const current = mediaClient ??= mediaClientFactory(scope);
        return hydrateCanvasCloudMediaDocument(value, current);
    }
    async function run<T>(work: () => Promise<T>, next: "loading" | "saving", cloud = false, apply?: (value: T) => void): Promise<T> {
        assertCurrent(cloud);
        if (busy) throw new AccountDraftWorkspaceError("busy");
        busy = true; phase = next;
        try {
            const result = await work();
            assertCurrent(cloud);
            apply?.(result);
            phase = "ready";
            return result;
        } catch (error) {
            assertCurrent();
            if (error instanceof DraftError && (error.status === 401 || ["unauthorized", "account_changed", "account_context_required"].includes(error.code))) {
                invalidate(); throw new AccountDraftWorkspaceError("account_changed");
            }
            const code: ErrorCode = error instanceof AccountDraftWorkspaceError ? error.code
                : error instanceof AccountDraftStorageError ? error.code
                    : error instanceof CloudMediaHydrationError ? "media_unavailable" : "unavailable";
            if (next === "saving" || code === "conflict") paused = true;
            phase = code === "conflict" ? "conflict" : "error";
            throw new AccountDraftWorkspaceError(code);
        } finally { busy = false; }
    }

    return Object.freeze({
        getState(): AccountDraftWorkspaceState {
            try { assertCurrent(); } catch { /* Account changes must not expose the previous body. */ }
            return { phase, draft: draft ? copy(draft) : null, project: project ? copy(project) : null, dirty: dirty() };
        },
        async listLocal() {
            assertCurrent();
            try {
                const items = await store.list(bound!.accountId);
                assertCurrent();
                return copy(items);
            } catch { assertCurrent(); throw new AccountDraftWorkspaceError("unavailable"); }
        },
        // Creating/editing changes only the account workspace's memory until explicit saveLocal.
        createLocal(value: unknown) {
            assertReplaceable();
            project = snapshot(value); draft = null; editVersion++; phase = "ready";
        },
        edit(value: unknown) {
            assertCurrent();
            if (!project) throw new AccountDraftWorkspaceError("no_draft");
            const next = snapshot(value);
            if (next.id !== project.id) throw new AccountDraftWorkspaceError("invalid_data");
            project = next; editVersion++;
        },
        async openLocal(id: string) {
            assertReplaceable();
            const version = editVersion;
            let createdUrls: readonly string[] = [];
            try {
                const result = await run(async () => {
                    const found = await store.read(bound!.accountId, id);
                    assertView(version);
                    if (!found) throw new AccountDraftWorkspaceError("not_found");
                    // A local-only copy can still contain cloud media. Its stored
                    // preview URLs belong to another view and must not be reused.
                    const requiresCloud = Boolean(found.cloud) || inspectCanvasDocument(found.project).mediaReferences.some((reference) => reference.kind === "cloud-media");
                    if (!requiresCloud) return { record: copy(found), objectUrls: [] as readonly string[], requiresCloud };
                    assertView(version, true);
                    const hydrated = await hydrateCloudProject(found.project);
                    createdUrls = hydrated.objectUrls;
                    assertView(version, true);
                    return { record: { ...found, project: hydrated.document }, objectUrls: hydrated.objectUrls, requiresCloud };
                }, "loading", false, (result) => {
                    assertView(version, result.requiresCloud);
                    clearCloudMediaObjectUrls();
                    cloudMediaObjectUrls = [...result.objectUrls];
                    createdUrls = [];
                    adopt(result.record);
                });
                return copy(result.record);
            } catch (error) {
                revokeCloudMediaObjectUrls(createdUrls);
                throw error;
            }
        },
        async saveLocal() {
            assertCurrent();
            if (paused) throw new AccountDraftWorkspaceError("unsaved_changes");
            if (!project) throw new AccountDraftWorkspaceError("no_draft");
            const proposed = snapshot(project), previous = draft ? copy(draft) : null;
            return run(async () => {
                const saved = await store.write({ accountId: bound!.accountId, localProjectId: previous?.localProjectId ?? proposed.id as string, project: proposed, cloud: previous?.cloud ?? null }, previous?.revision ?? null, guard());
                assertCurrent();
                return copy(saved);
            }, "saving", false, (saved) => {
                // An edit made while saving stays dirty; only the submitted snapshot is confirmed.
                draft = copy(saved);
            });
        },
        async openCloud(id: string, expectedRevision?: number) {
            assertReplaceable(); assertCurrent(true);
            if (!uuid(id)) throw new AccountDraftWorkspaceError("invalid_data");
            if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) {
                throw new AccountDraftWorkspaceError("invalid_data");
            }
            const cloudId = id.toLowerCase(), version = editVersion;
            let createdUrls: readonly string[] = [];
            try {
                const result = await run(async () => {
                    const existing = await store.read(bound!.accountId, cloudId);
                    assertView(version, true);
                    // A directory row carries the server's current revision. Reuse a
                    // cached account draft only when it is known to be that exact
                    // revision; otherwise fetch the current cloud body before staging.
                    // Calls without a directory revision retain the explicit local
                    // reopen behavior used by the account workspace itself.
                    if (existing && (expectedRevision === undefined || existing.cloud?.revision === expectedRevision)) {
                        if (existing.cloud?.id !== cloudId) throw new AccountDraftWorkspaceError("invalid_data");
                        // Cached cloud records are rehydrated on every open because prior
                        // object URLs are tab-local and cannot survive a refresh/device change.
                        const hydrated = await hydrateCloudProject(existing.project);
                        createdUrls = hydrated.objectUrls;
                        assertView(version, true);
                        return { record: { ...existing, project: hydrated.document }, objectUrls: hydrated.objectUrls };
                    }
                    // A local-only record may happen to use the same ID as a cloud
                    // draft. Never replace that unrelated account-local work while
                    // refreshing a directory entry.
                    if (existing && existing.cloud?.id !== cloudId) throw new AccountDraftWorkspaceError("invalid_data");
                    const cachedRevision = existing?.revision ?? null;
                    const currentClient = client ?? clientFactory(scope);
                    assertView(version, true); client = currentClient;
                    const found = await currentClient.get(cloudId);
                    assertView(version, true);
                    if (found.id.toLowerCase() !== cloudId || found.documentVersion !== 1 || !Number.isSafeInteger(found.revision) || found.revision < 1) {
                        throw new AccountDraftWorkspaceError("invalid_data");
                    }
                    const hydrated = await hydrateCloudProject(found.document);
                    createdUrls = hydrated.objectUrls;
                    const downloaded = snapshot(hydrated.document);
                    if (downloaded.title !== found.title) throw new AccountDraftWorkspaceError("invalid_data");
                    // Use the cloud ID as the workspace key, preserving the entire source document.
                    // Two cloud records can legitimately carry the same source device's project ID.
                    let saved: AccountDraftRecord;
                    try {
                        saved = await store.write({ accountId: bound!.accountId, localProjectId: cloudId, project: downloaded, cloud: { id: cloudId, revision: found.revision } }, cachedRevision, guard(version, true));
                    } catch (error) { assertView(version, true); throw error; }
                    assertView(version, true);
                    return { record: saved, objectUrls: hydrated.objectUrls };
                }, "loading", true, (result) => {
                    assertView(version, true);
                    clearCloudMediaObjectUrls();
                    cloudMediaObjectUrls = [...result.objectUrls];
                    createdUrls = [];
                    adopt(result.record);
                });
                return copy(result.record);
            } catch (error) {
                revokeCloudMediaObjectUrls(createdUrls);
                throw error;
            }
        },
        /**
         * Read the session-only previews currently staged for the open cloud
         * document. Callers must not retain ownership unless they also call
         * takeCloudMediaObjectUrls before disposing this workspace.
         */
        getCloudMediaObjectUrls() { return [...cloudMediaObjectUrls]; },
        /**
         * Transfer preview URL ownership to the mounted canvas. The workspace
         * will no longer revoke these URLs when the modal closes or the account
         * scope changes; the recipient must revoke them when the canvas stops
         * using the mounted document.
         */
        takeCloudMediaObjectUrls() {
            const urls = [...cloudMediaObjectUrls];
            cloudMediaObjectUrls = [];
            return urls;
        },
        dispose() { disposed = true; invalidate(); },
    });
}
