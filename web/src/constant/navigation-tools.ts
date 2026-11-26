import { AudioLines, Images, Lightbulb, Maximize2, Sparkles, Video } from "lucide-react";

export const navigationTools = [
    {
        slug: "creation",
        path: "/create",
        icon: Sparkles,
    },
    {
        slug: "music",
        icon: AudioLines,
    },
    {
        slug: "drama",
        icon: Video,
    },
    {
        slug: "canvas",
        icon: Maximize2,
    },
    {
        slug: "assets",
        icon: Images,
    },
    {
        slug: "inspiration",
        path: "/inspiration",
        icon: Lightbulb,
    },
] as const;

export type NavigationToolSlug = (typeof navigationTools)[number]["slug"];

export const navigationToolPath = (tool: { slug: string; path?: string }) => tool.path ?? `/${tool.slug}`;
