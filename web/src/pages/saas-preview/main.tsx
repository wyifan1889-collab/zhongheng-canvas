// Separate dev entry: never imports the production router, analytics, account API or local artwork stores.
if (import.meta.env.DEV && ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) {
    void import("./index").then(({ mountPreview }) => mountPreview());
} else {
    document.getElementById("root")!.textContent = "此流程预览仅在本地开发环境开放。";
}
