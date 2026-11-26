import type { ReactNode } from "react";
import { useEffect } from "react";

import { useAccountStore } from "@/stores/use-account-store";
import { accountGateAllowsWorkspace } from "@/services/saas/account-navigation";
import { AccountAuth } from "./account-auth";

/** Keeps the creative workspaces behind the confirmed account session. */
export function RequireAccount({ children }: { children: ReactNode }) {
    const { status, user, initialize } = useAccountStore();

    useEffect(() => { void initialize(); }, [initialize]);

    if (!accountGateAllowsWorkspace(status, Boolean(user))) {
        return <main aria-label="登录工作区" className="h-full min-w-0 overflow-y-auto bg-background text-foreground">
            <div className="flex min-h-full items-center justify-center px-6 py-10 sm:py-14"><AccountAuth /></div>
        </main>;
    }
    return <>{children}</>;
}
