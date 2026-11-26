export type AccountGateStatus = "idle" | "loading" | "ready" | "unavailable";

/** Build the exact in-app location that should be restored after login. */
export function accountReturnPath(pathname: string, search = "", hash = "") {
    return `${pathname}${search}${hash}`;
}

/** Keep workspace content behind a confirmed session; otherwise show inline login. */
export function accountGateAllowsWorkspace(status: AccountGateStatus, hasUser: boolean) {
    return status === "ready" && hasUser;
}

/** Only allow local protected routes as a post-login destination. */
export function safeAccountReturn(value: unknown) {
    return typeof value === "string"
        && value.startsWith("/")
        && !value.startsWith("//")
        && !value.startsWith("/account")
        ? value
        : "/canvas";
}
