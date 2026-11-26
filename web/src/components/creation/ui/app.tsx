import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type Key, type ReactNode } from "react";
import { App as AntApp, type ModalFuncProps } from "antd";
import type { MessageInstance } from "antd/es/message/interface";
import type { ArgsProps, NotificationInstance } from "antd/es/notification/interface";
import { toast } from "sonner";
import { CircleAlert, CircleCheck, Info, OctagonAlert } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { useAccountStore } from "@/stores/use-account-store";
import { CreationUiContext, isOwnedUiRoute, useCreationUi } from "./context";
import { Modal } from "./overlays";

const currentScopeKey = () => { const scope = useAccountStore.getState().getDraftScope(); return scope ? `${scope.accountId}:${scope.epoch}` : null; };
type ConfirmEntry = { id: number; options: ModalFuncProps; scope: string | null; presentationKey: string };
type ConfirmHandle = { destroy: () => void; update: (patch: ModalFuncProps) => void };
const ConfirmContext = createContext<((options: ModalFuncProps) => ConfirmHandle) | null>(null);
const antModalHandles = new Set<ConfirmHandle>();
const antMessageHandles = new Set<() => void>();
const antNotificationKeys = new Map<NotificationInstance, Set<Key>>();
let confirmationId = 0;
const messageIds = new Set<string | number>();

function invokeAntMessage(instance: MessageInstance, method: PropertyKey, args: unknown[]) {
    const result = Reflect.get(instance, method).apply(instance, args);
    if (typeof result === "function") {
        antMessageHandles.add(result);
        result.then?.(() => antMessageHandles.delete(result));
    }
    return result;
}

function clearAntPresentation() {
    for (const close of antMessageHandles) close();
    antMessageHandles.clear();
    for (const [instance, keys] of antNotificationKeys) for (const key of keys) instance.destroy(key);
    antNotificationKeys.clear();
    for (const handle of antModalHandles) handle.destroy();
    antModalHandles.clear();
}

function showMessage(level: "success" | "error" | "info" | "warning" | "loading", value: ReactNode | { content: ReactNode; key?: string | number; duration?: number }, duration?: number) {
    const options = value && typeof value === "object" && "content" in value ? value : { content: value as ReactNode, duration };
    const id = toast[level](options.content, { id: options.key, duration: options.duration === 0 ? Infinity : (options.duration ?? 4) * 1000 });
    messageIds.add(id);
    const close = () => { toast.dismiss(id); messageIds.delete(id); };
    return Object.assign(close, { then: (resolve: () => void) => Promise.resolve().then(resolve) });
}
export const creationMessage = {
    success: (value: Parameters<typeof showMessage>[1], duration?: number) => showMessage("success", value, duration),
    error: (value: Parameters<typeof showMessage>[1], duration?: number) => showMessage("error", value, duration),
    info: (value: Parameters<typeof showMessage>[1], duration?: number) => showMessage("info", value, duration),
    warning: (value: Parameters<typeof showMessage>[1], duration?: number) => showMessage("warning", value, duration),
    loading: (value: Parameters<typeof showMessage>[1], duration?: number) => showMessage("loading", value, duration),
    destroy: (key?: string | number) => { if (key !== undefined) { toast.dismiss(key); messageIds.delete(key); } else { for (const id of messageIds) toast.dismiss(id); messageIds.clear(); } },
} as unknown as MessageInstance;

const notificationIds = new Set<string | number>();
function showNotification(options: ArgsProps) {
    const id = options.key === undefined ? `owned-notification-${++confirmationId}` : String(options.key);
    const Icon = options.type === "error" ? OctagonAlert : options.type === "warning" ? CircleAlert : options.type === "success" ? CircleCheck : Info;
    notificationIds.add(id);
    toast.custom(() => <section role={options.role ?? "status"} onClick={options.onClick}
        className="w-[min(360px,calc(100vw-32px))] space-y-2 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg">
        <h2 className="flex items-center gap-2 text-sm font-semibold">{options.icon ?? <Icon className={options.type === "error" ? "size-4 shrink-0 text-destructive" : "size-4 shrink-0 text-primary"} />}{options.title ?? options.message}</h2>
        <div className="text-sm text-muted-foreground">{options.description}</div>
        {options.actions ?? options.btn}
    </section>, { id, closeButton: options.closable !== false, duration: options.duration === 0 || options.duration === false ? Infinity : (options.duration ?? 4.5) * 1000,
        onDismiss: () => { notificationIds.delete(id); options.onClose?.(); },
        onAutoClose: () => { notificationIds.delete(id); options.onClose?.(); } });
}
const creationNotification = {
    open: showNotification,
    success: (options: ArgsProps) => showNotification({ ...options, type: "success" }),
    info: (options: ArgsProps) => showNotification({ ...options, type: "info" }),
    warning: (options: ArgsProps) => showNotification({ ...options, type: "warning" }),
    error: (options: ArgsProps) => showNotification({ ...options, type: "error" }),
    destroy: (key?: Key) => { if (key !== undefined) { toast.dismiss(String(key)); notificationIds.delete(String(key)); } else { for (const id of notificationIds) toast.dismiss(id); notificationIds.clear(); } },
} as NotificationInstance;

/** The tracker lives above routes. Only presentation changes when this value changes. */
let creationPresentation = false;
let presentationRoute = "";
const presentationListeners = new Set<() => void>();
const ownedThemeOwners = new Set<symbol>();
export const isCreationPresentation = () => typeof window === "undefined" ? creationPresentation : isOwnedUiRoute(window.location.pathname);
export const subscribeCreationPresentation = (listener: () => void) => { presentationListeners.add(listener); return () => { presentationListeners.delete(listener); }; };
function setCreationPresentation(active: boolean, route = "") {
    if (creationPresentation === active && presentationRoute === route) return;
    creationPresentation = active;
    presentationRoute = route;
    for (const listener of presentationListeners) listener();
}

export function CreationUiBoundary({ active, presentationKey = "", children }: { active: boolean; presentationKey?: string; children: ReactNode }) {
    useLayoutEffect(() => {
        if (!active) return;
        const owner = Symbol();
        ownedThemeOwners.add(owner);
        document.body.dataset.ownedUi = "true";
        return () => {
            ownedThemeOwners.delete(owner);
            if (!ownedThemeOwners.size) delete document.body.dataset.ownedUi;
        };
    }, [active]);
    const [entries, setEntries] = useState<ConfirmEntry[]>([]), [busy, setBusy] = useState<number | null>(null);
    const mounted = useRef(true);
    const activeRef = useRef(active); activeRef.current = active;
    const routeRef = useRef(presentationKey); routeRef.current = presentationKey;
    const scope = useAccountStore(state => { const value = state.getDraftScope(); return value ? `${value.accountId}:${value.epoch}` : null; });
    const confirm = useCallback((options: ModalFuncProps): ConfirmHandle => {
        const id = ++confirmationId;
        setEntries(values => [...values, { id, options, scope: currentScopeKey(), presentationKey: routeRef.current }]);
        return { destroy: () => { setEntries(values => values.filter(value => value.id !== id)); setBusy(value => value === id ? null : value); }, update: patch => setEntries(values => values.map(value => value.id === id ? { ...value, options: { ...value.options, ...patch } } : value)) };
    }, []);
    useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    useEffect(() => {
        setEntries([]); setBusy(null); creationMessage.destroy(); creationNotification.destroy();
        if (active) clearAntPresentation();
    }, [active, scope, presentationKey]);
    useEffect(() => {
        setCreationPresentation(active, presentationKey);
        return () => { setCreationPresentation(false); creationMessage.destroy(); creationNotification.destroy(); };
    }, [active, presentationKey]);
    const remove = (id: number) => setEntries(values => values.filter(value => value.id !== id));
    return <CreationUiContext value={active}><ConfirmContext value={confirm}>
        {children}{active ? <Toaster position="top-right" closeButton richColors /> : null}
        {active ? entries.filter(entry => entry.scope === scope && entry.presentationKey === presentationKey).map(({ id, options, scope: owner, presentationKey: route }) => <Modal key={id} {...options} open title={options.title} confirmLoading={busy === id} closable={busy !== id && (options.closable ?? false)} keyboard={busy !== id && options.keyboard !== false} maskClosable={busy !== id && (options.maskClosable ?? (typeof options.mask === "object" ? options.mask.closable : undefined) ?? false)}
            okButtonProps={{ ...options.okButtonProps, danger: options.okType === "danger" }} cancelButtonProps={{ ...options.cancelButtonProps, disabled: busy === id }}
            onCancel={() => { if (busy === id) return; options.onCancel?.(); remove(id); }} onOk={async () => {
                if (busy !== null || !activeRef.current || currentScopeKey() !== owner || routeRef.current !== route) return;
                setBusy(id);
                try { await options.onOk?.(); if (mounted.current) remove(id); }
                catch { /* Existing callers own error feedback; keep the confirmation available for correction. */ }
                finally { if (mounted.current) setBusy(value => value === id ? null : value); }
            }}>{options.content}</Modal>) : null}
    </ConfirmContext></CreationUiContext>;
}

export function useAppUi() {
    const ant = AntApp.useApp(), owned = useCreationUi(), confirm = useContext(ConfirmContext);
    const latest = useRef({ ant, owned, confirm }); latest.current = { ant, owned, confirm };
    // Runtime effects subscribe to these objects. A presentation route change
    // must never become an SSE/interaction identity change.
    const message = useMemo(() => new Proxy({} as MessageInstance, { get(_target, key) {
        const current = latest.current.owned ? creationMessage : latest.current.ant.message;
        const value = Reflect.get(current, key);
        if (!latest.current.owned && typeof value === "function" && ["open", "success", "error", "info", "warning", "loading"].includes(String(key))) return (...args: unknown[]) => invokeAntMessage(current, key, args);
        return typeof value === "function" ? value.bind(current) : value;
    } }), []);
    const modal = useMemo(() => new Proxy({} as typeof ant.modal, { get(_target, key) {
        const state = latest.current;
        const method = ["confirm", "info", "success", "error", "warning"].includes(String(key));
        if (state.owned && state.confirm && method) return key === "confirm" ? state.confirm : (options: ModalFuncProps) => state.confirm!({
            ...options, cancelButtonProps: { ...options.cancelButtonProps, style: { ...options.cancelButtonProps?.style, display: "none" } },
        });
        const value = Reflect.get(state.ant.modal, key);
        if (!state.owned && typeof value === "function" && method) return (...args: unknown[]) => {
            const handle = value.apply(state.ant.modal, args) as ConfirmHandle;
            antModalHandles.add(handle);
            return handle;
        };
        return typeof value === "function" ? value.bind(state.ant.modal) : value;
    } }), []);
    const notification = useMemo(() => new Proxy({} as NotificationInstance, { get(_target, key) {
        const current = latest.current.owned ? creationNotification : latest.current.ant.notification;
        const value = Reflect.get(current, key);
        if (!latest.current.owned && typeof value === "function" && key !== "destroy") return (options: ArgsProps) => {
            const noticeKey = options.key ?? `owned-ant-notification-${++confirmationId}`;
            const keys = antNotificationKeys.get(current) ?? new Set<Key>();
            keys.add(noticeKey); antNotificationKeys.set(current, keys);
            return value.call(current, { ...options, key: noticeKey, onClose: () => { keys.delete(noticeKey); options.onClose?.(); } });
        };
        return typeof value === "function" ? value.bind(current) : value;
    } }), []);
    return useMemo(() => ({ message, modal, notification }), [message, modal, notification]);
}
export const App = { useApp: useAppUi };

/** ClientRootInit is outside RouterProvider and the creation subtree. */
export function useRootMessage() {
    const { message } = AntApp.useApp();
    return useMemo(() => ({
        success: (...args: Parameters<MessageInstance["success"]>) => isCreationPresentation() ? creationMessage.success(...args) : invokeAntMessage(message, "success", args),
        error: (...args: Parameters<MessageInstance["error"]>) => isCreationPresentation() ? creationMessage.error(...args) : invokeAntMessage(message, "error", args),
    }), [message]);
}
