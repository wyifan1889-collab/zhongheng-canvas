import type { InspirationCatalog, InspirationItem } from "@/services/saas/inspiration";
import type { AdminGenerationScope } from "@/services/saas/platform";

type Client = {
    read: () => Promise<InspirationCatalog>;
    save: (input: { expectedRevision: InspirationCatalog["revision"]; items: InspirationItem[] }) => Promise<InspirationCatalog>;
};
export type InspirationEditorState = {
    phase: "loading" | "ready" | "saving" | "check-required" | "error";
    baseline: InspirationCatalog | null;
    verification: InspirationCatalog | null;
    items: InspirationItem[];
    dirty: boolean;
    notice: string;
};
export const emptyInspirationEditor = (): InspirationEditorState => ({ phase: "loading", baseline: null, verification: null, items: [], dirty: false, notice: "正在读取已保存灵感…" });
const copy = <T,>(value: T): T => structuredClone(value);
const sameItems = (a: InspirationItem[], b: InspirationItem[]) => JSON.stringify(a) === JSON.stringify(b);
const message = (error: unknown) => error instanceof Error ? error.message : "操作未完成，请先读取服务器列表核对。";

/** Editing stays in memory. Reads never replace an unsaved or uncertain draft. */
export function createInspirationEditor(options: { client: Client; getScope: () => AdminGenerationScope | null; onState: (state: InspirationEditorState) => void }) {
    const bound = options.getScope();
    let active = true, busy = false, sequence = 0, state = emptyInspirationEditor();
    const current = () => {
        const next = options.getScope();
        return active && bound?.role === "admin" && next?.role === "admin" && next.accountId === bound.accountId && next.epoch === bound.epoch;
    };
    const publish = (patch: Partial<InspirationEditorState>) => {
        state = { ...state, ...patch };
        if (current()) options.onState(state);
    };
    const adopt = (catalog: InspirationCatalog) => publish({ baseline: copy(catalog), verification: null, items: copy(catalog.items), dirty: false, phase: "ready", notice: "已读取保存版本。编辑后需明确保存，广场才会更新。" });
    return {
        getState: () => state,
        async read() {
            if (!current() || busy) return;
            busy = true;
            const request = ++sequence, preserve = state.dirty || state.phase === "check-required";
            publish({ phase: "loading", verification: null, notice: preserve ? "正在核对服务器列表；当前编辑内容保持。" : "正在读取已保存灵感…" });
            try {
                const catalog = await options.client.read();
                if (!current() || request !== sequence) return;
                if (preserve) publish({ verification: copy(catalog), phase: "check-required", notice: "已读取服务器列表。请比较后选择采用服务器内容，或保留本机编辑继续。" });
                else adopt(catalog);
            } catch (error) {
                if (current() && request === sequence) publish({ phase: preserve ? "check-required" : "error", notice: message(error) });
            } finally { busy = false; }
        },
        edit(items: InspirationItem[]) {
            if (!current() || busy || state.phase !== "ready" || !state.baseline) return;
            publish({ items: copy(items), dirty: !sameItems(items, state.baseline.items), notice: "编辑尚未保存，公开广场保持原版本。" });
        },
        async save() {
            if (!current() || busy || state.phase !== "ready" || !state.baseline || !state.dirty) return;
            busy = true;
            const request = ++sequence, input = { expectedRevision: state.baseline.revision, items: copy(state.items) };
            publish({ phase: "saving", notice: "正在保存公开灵感，请等待服务器确认…" });
            try {
                const catalog = await options.client.save(input);
                if (!current() || request !== sequence) return;
                adopt(catalog);
                publish({ notice: "公开灵感已保存。广场重新读取后会显示此版本。" });
            } catch (error) {
                if (!current() || request !== sequence) return;
                const failure = error as { outcome?: string; status?: number; code?: string };
                const uncertain = failure?.outcome !== "not-sent" && failure?.outcome !== "rejected" || [401, 403, 409].includes(failure?.status ?? 0);
                publish({ phase: uncertain ? "check-required" : "ready", verification: null, notice: message(error) });
            } finally { busy = false; }
        },
        adoptVerified() {
            if (current() && !busy && state.phase === "check-required" && state.verification) adopt(state.verification);
        },
        keepDraft() {
            if (!current() || busy || state.phase !== "check-required" || !state.verification) return;
            const baseline = copy(state.verification);
            publish({ baseline, verification: null, phase: "ready", dirty: !sameItems(state.items, baseline.items), notice: "已保留本机编辑，并采用刚核对的版本作为保存基准。请再次检查后明确保存。" });
        },
        discardDraft() {
            if (current() && !busy && state.phase === "ready" && state.baseline) adopt(state.baseline);
        },
        close() { active = false; sequence++; },
    };
}
