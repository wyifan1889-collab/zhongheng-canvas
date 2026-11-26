import type { CSSProperties } from "react";
import type { PublicSiteConfig } from "../../../../packages/shared/src/index";
import { getAntThemeConfig } from "@/lib/app-theme";
import { canvasThemes } from "@/lib/canvas-theme";

// Browser-safe preview fixture, not imported from server configuration. Final brand is not decided.
export const previewBrand: PublicSiteConfig["brand"] = {
    name: "无限画布", tagline: "给想法，一张自由生长的画布。", logoPath: null,
};
export function previewTheme(dark: boolean) {
    const canvas = canvasThemes[dark ? "dark" : "light"];
    const base = getAntThemeConfig(dark);
    return {
        config: { ...base, token: { ...base.token, borderRadius: 10, fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif', colorBgContainer: canvas.node.panel } },
        style: {
            "--preview-bg": canvas.canvas.background, "--preview-surface": canvas.node.panel,
            "--preview-text": canvas.node.text, "--preview-muted": canvas.node.label,
            "--preview-line": canvas.node.stroke, "--preview-dot": canvas.canvas.dot,
            "--preview-hover": canvas.toolbar.itemHover,
            colorScheme: dark ? "dark" : "light",
        } as CSSProperties,
    };
}
