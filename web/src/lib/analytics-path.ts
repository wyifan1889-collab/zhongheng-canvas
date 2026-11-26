/** Router paths are case-insensitive and decode percent escapes once. */
export function isCanvasJoinPath(pathname: string) {
    try { pathname = decodeURI(pathname); } catch { /* Match the router's unchanged malformed path. */ }
    return /^\/canvas\/join(?:\/|$)/i.test(pathname);
}

/** Invitation tokens must never enter page-view analytics. */
export function analyticsPath(pathname: string, search = "") {
    return isCanvasJoinPath(pathname) ? "/canvas/join" : `${pathname}${search}`;
}
