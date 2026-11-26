import type { ThemeConfig } from "antd";
import { theme as antdTheme } from "antd";

const brand = {
    light: {
        background: "#fcfbf8",
        sidebar: "#f4f2ec",
        card: "#ffffff",
        border: "#dedbd2",
        foreground: "#25241f",
        muted: "#777269",
        primary: "#b5912a",
        primaryHover: "#cba449",
        primaryText: "#17130b",
        elevatedBg: "#ffffff",
        itemHoverBg: "rgba(181, 145, 42, 0.06)",
        itemSelectedBg: "rgba(181, 145, 42, 0.1)",
        itemSelectedHoverBg: "rgba(181, 145, 42, 0.14)",
        itemText: "#171717",
        tableSelectedBg: "rgba(181, 145, 42, 0.05)",
        tableSelectedHoverBg: "rgba(181, 145, 42, 0.08)",
        ownedBackground: "#fcfbf8",
        ownedSidebar: "#f4f2ec",
        ownedForeground: "#0e0f10",
    },
    dark: {
        background: "#191a1c",
        sidebar: "#151618",
        card: "#222325",
        border: "#373635",
        foreground: "#ede8dc",
        muted: "#aaa59b",
        primary: "#d6b668",
        primaryHover: "#e5c980",
        primaryText: "#17130b",
        elevatedBg: "#222325",
        itemHoverBg: "rgba(214, 182, 104, 0.08)",
        itemSelectedBg: "rgba(214, 182, 104, 0.14)",
        itemSelectedHoverBg: "rgba(214, 182, 104, 0.18)",
        itemText: "#ede8dc",
        tableSelectedBg: "rgba(214, 182, 104, 0.08)",
        tableSelectedHoverBg: "rgba(214, 182, 104, 0.14)",
        ownedBackground: "#0e0f10",
        ownedSidebar: "#0e0f10",
        ownedForeground: "#fcfbf8",
    },
};

/** Shared app palette. The official canvas keeps its own engine theme. */
export function getAppThemeCss() {
    return Object.entries(brand).map(([mode, color]) => {
        const variables = {
            background: color.background, foreground: color.foreground, border: color.border,
            card: color.card, "card-foreground": color.foreground,
            popover: color.elevatedBg, "popover-foreground": color.foreground,
            primary: color.primary, "primary-foreground": color.primaryText,
            "primary-hover": color.primaryHover,
            secondary: color.card, "secondary-foreground": color.foreground,
            muted: color.card, "muted-foreground": color.muted,
            accent: color.itemSelectedBg, "accent-foreground": color.foreground,
            input: color.border, ring: color.primary,
            sidebar: color.sidebar, "sidebar-foreground": color.foreground,
            "sidebar-primary": color.primary, "sidebar-primary-foreground": color.primaryText,
            "sidebar-accent": color.itemSelectedBg, "sidebar-accent-foreground": color.foreground,
            "sidebar-border": color.border, "sidebar-ring": color.primary,
            "gold-1": "#352c1b", "gold-2": "#524126", "gold-3": "#7d6637", "gold-4": "#aa8a48",
            "gold-5": color.primary, "gold-6": color.primaryHover, "gold-7": "#eed9a2", "gold-8": color.itemSelectedBg,
            "brand-shimmer": "linear-gradient(105deg, #aa8a48 0%, #eed9a2 40%, #d6b668 55%, #f2dfaf 70%, #b59858 100%)",
        };
        const owned = {
            background: color.ownedBackground, sidebar: color.ownedSidebar,
            foreground: color.ownedForeground, "sidebar-foreground": color.ownedForeground,
            "card-foreground": color.ownedForeground, "popover-foreground": color.ownedForeground,
        };
        return `${mode === "dark" ? ".dark" : ":root"}{${Object.entries(variables).map(([key, value]) => `--${key}:${value}`).join(";")}}${mode === "dark" ? ".dark" : ":root:not(.dark)"} body[data-owned-ui=true]{${Object.entries(owned).map(([key, value]) => `--${key}:${value}`).join(";")}}`;
    }).join("\n");
}

export function getAntThemeConfig(dark: boolean): ThemeConfig {
    const color = dark ? brand.dark : brand.light;
    const palette = {
        colorBgBase: color.background, colorBgLayout: color.background, colorBgContainer: color.card,
        colorBgElevated: color.elevatedBg, colorBorder: color.border, colorBorderSecondary: color.border,
        colorText: color.foreground, colorTextSecondary: color.muted, colorTextTertiary: color.muted,
    };

    return {
        algorithm: (seed, map) => ({
            ...(dark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm)(seed, map),
            ...palette,
            // Keep the requested brand hex after the dark algorithm derives its palette.
            colorPrimary: color.primary,
            colorPrimaryHover: color.primaryHover,
            colorInfo: color.primary,
            colorLink: color.primary,
            colorLinkHover: color.primaryHover,
            colorLinkActive: color.primary,
        }),
        cssVar: { key: dark ? "infinite-canvas-dark" : "infinite-canvas-light" },
        token: {
            ...palette,
            colorPrimary: color.primary,
            colorInfo: color.primary,
            colorLink: color.primary,
            colorLinkHover: color.primaryHover,
            colorLinkActive: color.primary,
            colorTextLightSolid: color.primaryText,
            borderRadius: 8,
            borderRadiusLG: 12,
            motionDurationFast: "0.15s",
            motionDurationMid: "0.15s",
            motionDurationSlow: "0.15s",
            motionEaseInOut: "ease",
            boxShadow: "0 1px 3px oklch(0 0 0 / 8%)",
            boxShadowSecondary: "0 20px 60px oklch(0 0 0 / 24%)",
            colorBgElevated: color.elevatedBg,
            controlItemBgHover: color.itemHoverBg,
            controlItemBgActive: color.itemSelectedBg,
            controlItemBgActiveHover: color.itemSelectedHoverBg,
        },
        components: {
            Button: {
                primaryShadow: "none",
            },
            Modal: {
                borderRadiusLG: 16,
            },
            Card: {
                boxShadowTertiary: "0 1px 3px oklch(0 0 0 / 8%)",
            },
            Dropdown: {
                colorBgElevated: color.elevatedBg,
                colorText: color.itemText,
                controlItemBgHover: color.itemHoverBg,
                controlItemBgActive: color.itemSelectedBg,
                controlItemBgActiveHover: color.itemSelectedHoverBg,
            },
            Menu: {
                popupBg: color.elevatedBg,
                itemActiveBg: color.itemSelectedBg,
                itemHoverBg: color.itemHoverBg,
                itemSelectedBg: color.itemSelectedBg,
                itemSelectedColor: color.itemText,
                darkPopupBg: brand.dark.elevatedBg,
                darkItemHoverBg: brand.dark.itemHoverBg,
                darkItemSelectedBg: brand.dark.itemSelectedBg,
                darkItemSelectedColor: brand.dark.itemText,
            },
            Select: {
                optionActiveBg: color.itemHoverBg,
                optionSelectedBg: color.itemSelectedBg,
                optionSelectedColor: color.itemText,
            },
            Table: {
                rowSelectedBg: color.tableSelectedBg,
                rowSelectedHoverBg: color.tableSelectedHoverBg,
            },
        },
    };
}
