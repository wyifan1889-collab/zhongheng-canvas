/** Development-only native IndexedDB gate. No application imports or automatic writes. */
const databaseName = "infinite-canvas", storeName = "app_state", storeKey = "infinite-canvas:canvas_store";
const suffix = "（挂载前恢复副本）";
type Project = Record<string, unknown> & { id: string; title: string };
type Snapshot = { projects: Project[] };
export type GatePhase = "idle" | "arming" | "armed" | "checking" | "pending" | "releasing" | "aborting" | "committed" | "aborted" | "bypassed" | "disposed";
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function snapshot(value: unknown): Snapshot | null {
    try {
        if (typeof value !== "string") return null;
        const envelope: unknown = JSON.parse(value);
        if (!record(envelope) || envelope.version !== 0 || !record(envelope.state) || !Array.isArray(envelope.state.projects)) return null;
        const projects = envelope.state.projects;
        if (projects.some((project) => !record(project) || typeof project.id !== "string" || !project.id || typeof project.title !== "string") ||
            new Set(projects.map((project) => project.id)).size !== projects.length) return null;
        return { projects: projects as Project[] };
    } catch { return null; }
}
// The product's import preserves these fields; only id, title and updatedAt change.
function content(project: Project) {
    return JSON.stringify([project.createdAt, project.nodes, project.connections, project.chatSessions,
        project.activeChatId, project.backgroundMode, project.showImageInfo, project.viewport]);
}

export function createMountPersistenceGate(onState: (phase: GatePhase) => void = () => {}) {
    const prototype = IDBObjectStore.prototype, nativePut = prototype.put, nativeGet = prototype.get;
    let phase: GatePhase = "idle", armed: Snapshot | null = null, target: Project | undefined;
    let transaction: IDBTransaction | null = null, cleanupEvents = () => {}, disposed = false;
    const currentPhase = () => phase;
    const state = (next: GatePhase) => { phase = next; try { onState(next); } catch { /* UI must not change transaction semantics. */ } };
    const restore = () => { if (prototype.put === intercept) prototype.put = nativePut; };
    function intercept(this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        const next = phase === "armed" && key === storeKey && this.name === storeName &&
            this.transaction.mode === "readwrite" && this.transaction.db.name === databaseName ? snapshot(value) : null;
        const added = next && armed ? next.projects.filter((project) => !armed!.projects.some((old) => old.id === project.id)) : [];
        const candidate = added.length === 1 ? added[0] : undefined;
        if (!next || !armed || !target || next.projects.length !== armed.projects.length + 1 || !candidate ||
            candidate.title !== target.title + suffix || content(candidate) !== content(target) ||
            !armed.projects.every((old) => next.projects.some((project) => project.id === old.id))) {
            return arguments.length === 1 ? nativePut.call(this, value) : nativePut.call(this, value, key);
        }
        // Read before the put in the SAME native transaction. Another tab's merged copy must not be captured.
        const before = nativeGet.call(this, storeKey), tx = this.transaction;
        const request = arguments.length === 1 ? nativePut.call(this, value) : nativePut.call(this, value, key);
        transaction = tx;
        state("checking");
        restore(); // one shot; subsequent puts retain native semantics even while this transaction waits
        const finish = (event: Event) => {
            cleanupEvents(); transaction = null;
            if (!disposed && phase !== "bypassed") state(event.type === "complete" ? "committed" : "aborted");
        };
        cleanupEvents = () => { tx.removeEventListener("complete", finish); tx.removeEventListener("abort", finish); };
        tx.addEventListener("complete", finish); tx.addEventListener("abort", finish);
        const keepAlive = () => {
            if (phase !== "pending" || disposed) return;
            // Queue synchronously from a native success callback, never from a timer or an awaited Promise.
            const read = nativeGet.call(this, storeKey);
            read.addEventListener("success", keepAlive, { once: true });
        };
        before.addEventListener("success", () => {
            if (disposed || phase !== "checking") return;
            const previous = snapshot(before.result), original = previous?.projects.find((project) => project.id === target!.id);
            if (!previous || previous.projects.length !== armed!.projects.length ||
                !previous.projects.every((project) => armed!.projects.some((old) => old.id === project.id)) ||
                !original || original.title !== target!.title || content(original) !== content(target!) ||
                next.projects.find((project) => project.id === target!.id)?.title !== original.title ||
                content(next.projects.find((project) => project.id === target!.id)!) !== content(original)) {
                state("bypassed"); return;
            }
            state("pending"); keepAlive();
        }, { once: true });
        return request;
    }
    return {
        get phase() { return phase; },
        async arm(projectId: string) {
            if (currentPhase() !== "idle" || prototype.put !== nativePut) throw new Error("门控只允许本页一次启用；请关闭其他故障控制并刷新独立测试页。");
            state("arming");
            let db: IDBDatabase | undefined;
            try {
                const opened = indexedDB.open(databaseName);
                db = await new Promise<IDBDatabase>((resolve, reject) => {
                    opened.onupgradeneeded = () => { opened.transaction?.abort(); };
                    opened.onerror = () => reject(new Error("请先创建并保存合成测试画布。"));
                    opened.onblocked = () => reject(new Error("数据库被其他标签阻塞；尚未启用门控。"));
                    opened.onsuccess = () => { if (disposed || phase !== "arming") { opened.result.close(); reject(new Error("门控已关闭。")); } else resolve(opened.result); };
                });
                armed = await new Promise<Snapshot>((resolve, reject) => {
                    const tx = db!.transaction(storeName, "readonly"), read = tx.objectStore(storeName).get(storeKey);
                    tx.onabort = tx.onerror = () => reject(new Error("无法读取已保存的画布快照。"));
                    tx.oncomplete = () => { const value = snapshot(read.result); value ? resolve(value) : reject(new Error("画布快照格式不符。")); };
                });
                if (disposed || phase !== "arming") throw new Error("门控已关闭。");
                target = armed.projects.find((project) => project.id === projectId);
                if (!target || !Array.isArray(target.nodes) || !Array.isArray(target.connections)) throw new Error("请在已保存的合成测试画布内启用。");
                if (prototype.put !== nativePut) throw new Error("检测到其他 IndexedDB 包装器，拒绝覆盖。");
                prototype.put = intercept;
                state("armed");
            } catch (error) { if (!disposed) state("bypassed"); throw error; }
            finally { db?.close(); }
        },
        release() { if (phase !== "pending") return false; state("releasing"); return true; },
        abort() {
            if (phase !== "pending" || !transaction) return false;
            state("aborting"); transaction.abort(); return true;
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            const tx = transaction;
            cleanupEvents(); transaction = null;
            state("disposed");
            try { tx?.abort(); } catch { /* A completed transaction needs no abort. */ }
            restore();
        },
    };
}

/** Called only by the explicit --media-recovery --mount-persistence HTML injection. */
export function installMountPersistenceControls(panel: HTMLElement) {
    const section = document.createElement("div"), status = document.createElement("div"), row = document.createElement("div");
    section.textContent = "本机恢复写入故障：仅独立合成项目。先等本机保存完成，再启用一次，确认挂载后手动释放或中止。锁只防止另一门控实例；其他普通标签仍可能写入。关闭画布弹窗不会解除故障；离开此页会中止尚未提交的事务。";
    section.style.cssText = "max-width:410px;border-top:1px solid #a16207;margin-top:6px;padding-top:4px";
    row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap";
    status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    section.append(status, row); panel.append(section);
    let releaseLock: (() => void) | undefined, closed = false;
    const labels: Record<GatePhase, string> = { idle: "未启用", arming: "读取已保存快照", armed: "已启用：等待新恢复副本", checking: "核对同事务写前快照",
        pending: "等待中：真实事务尚未提交", releasing: "已释放：等待原生提交", aborting: "中止中：等待原生结果", committed: "原生事务已提交",
        aborted: "原生事务已中止", bypassed: "未捕获：快照不符或启用失败，请重新准备独立测试页", disposed: "已清理" };
    const gate = createMountPersistenceGate((phase) => { status.textContent = labels[phase]; render(); });
    const button = (label: string, action: () => void) => {
        const value = document.createElement("button"); value.type = "button"; value.textContent = label;
        value.style.cssText = "padding:2px 7px;border:1px solid #a16207;border-radius:3px;background:#fff;color:#422006;font:inherit;cursor:pointer";
        value.onclick = action; row.append(value); return value;
    };
    const arm = button("启用一次恢复写入等待", () => {
        const projectId = /^\/canvas\/([A-Za-z0-9_-]+)$/.exec(location.pathname)?.[1];
        if (!projectId) { status.textContent = "请先进入已保存的合成测试画布。"; return; }
        arm.disabled = true;
        void gate.arm(projectId).catch((error) => { status.textContent = error instanceof Error ? error.message : "启用失败。"; });
    });
    const release = button("释放恢复写入", () => { gate.release(); });
    const abort = button("中止恢复写入", () => { gate.abort(); });
    const stop = button("清理本页故障控制", dispose);
    function render() { arm.disabled = !releaseLock || gate.phase !== "idle"; release.disabled = abort.disabled = gate.phase !== "pending"; stop.disabled = closed; }
    function dispose() {
        if (closed) return;
        closed = true; gate.dispose(); releaseLock?.(); releaseLock = undefined;
        window.removeEventListener("pagehide", dispose); render();
    }
    window.addEventListener("pagehide", dispose, { once: true });
    status.textContent = "正在申请本源故障控制独占锁。"; render();
    if (!navigator.locks) { status.textContent = "浏览器没有 Web Locks；拒绝启用故障控制。"; return; }
    void navigator.locks.request("canvas-mount-persistence-test", { mode: "exclusive", ifAvailable: true }, async (lock) => {
        if (closed) return;
        if (!lock) { status.textContent = "另一个标签持有故障控制锁；本页不能启用。"; return; }
        await new Promise<void>((resolve) => { releaseLock = resolve; status.textContent = labels[gate.phase]; render(); });
    }).catch(() => { status.textContent = "故障控制锁申请失败；未启用。"; dispose(); });
}
