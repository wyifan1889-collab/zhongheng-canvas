import { useAccountStore } from "@/stores/use-account-store";

export type PersonalConfigContext = { guard: () => boolean; invalidate: () => void; dispose: () => void };

export function createPersonalConfigContext(): PersonalConfigContext | null {
    const initial = useAccountStore.getState();
    if (initial.status !== "ready" || initial.busy || initial.user || !initial.site || initial.site.captcha) return null;
    const site = initial.site;
    let valid = true;
    const unsubscribe = useAccountStore.subscribe((current) => {
        if (current.status !== "ready" || current.busy || current.user || current.site !== site || current.site.captcha) valid = false;
    });
    const dispose = () => { valid = false; unsubscribe(); };
    const invalidate = () => { dispose(); };
    return { guard: () => valid && (() => { const current = useAccountStore.getState(); return current.status === "ready" && !current.busy && !current.user && current.site === site && !current.site.captcha; })(), invalidate, dispose };
}
