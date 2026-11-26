/** Presentation only. Never use this list to infer creation mode or task ownership. */
export function isOwnedUiRoute(pathname: string) {
    return /^\/(?:create|music|assets|inspiration|generation\/history|account|login|reset-password|config|drama)\/?$/.test(pathname);
}
