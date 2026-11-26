import type { PublicSiteConfig } from "@infinite-canvas/shared";

/** Public allowlist, not a serialization of environment variables or admin config. */
export const siteConfig: PublicSiteConfig = {
    schemaVersion: 1,
    brand: { name: "无限画布", tagline: "在一张画布里完成创作", logoPath: null },
    theme: {
        light: { accent: "#171717", background: "#fafaf9", surface: "#ffffff", text: "#171717" },
        dark: { accent: "#fafafa", background: "#171717", surface: "#1c1917", text: "#fafafa" },
    },
    features: {
        registration: false,
        cloudCanvas: false,
        cloudMedia: false,
        recharge: false,
        generation: { text: false, image: false, video: false, audio: false },
    },
};
