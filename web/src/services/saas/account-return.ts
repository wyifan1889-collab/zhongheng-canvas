export type AccountReturn = { resetToken: string | null; invalidLink: boolean };

export const isAccountReturnPath = (path: string) => path === "/login" || path === "/reset-password";

export function parseAccountReturn(url: URL): AccountReturn {
    const tokens = url.searchParams.getAll("token");
    const resetToken = url.pathname === "/reset-password" && tokens.length === 1 && tokens[0] ? tokens[0] : null;
    return { resetToken, invalidLink: url.searchParams.has("error") || (url.pathname === "/reset-password" && !resetToken) };
}

// Runs before the router and analytics start. No token-bearing URL in history or persistent storage.
let accountReturn: AccountReturn = { resetToken: null, invalidLink: false };
if (typeof window !== "undefined" && isAccountReturnPath(window.location.pathname)) {
    accountReturn = parseAccountReturn(new URL(window.location.href));
    window.history.replaceState(window.history.state, "", window.location.pathname);
}
export const readAccountReturn = () => ({ ...accountReturn });
export function clearAccountReturn() { accountReturn = { resetToken: null, invalidLink: false }; }
