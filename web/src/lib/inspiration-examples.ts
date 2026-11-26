import type { InspirationItem } from "@/services/saas/inspiration";

/** Original templates and vector covers. Publish explicitly; never seed a live catalog on import. */
export const inspirationExamples: InspirationItem[] = [
    {
        id: "template-brand-poster", type: "image", title: "暖金香氛品牌海报",
        prompt: "为一款未指定品牌的随身香氛设计商业海报。以一只极简磨砂玻璃香氛瓶为视觉中心，放在暖白色弧形展台上。用柔和侧光表现玻璃与金属瓶盖的材质，背景采用克制的暖金渐变和大面积留白。构图干净、有呼吸感，留出品牌标题与短文案的位置，不添加已有商标，不堆叠小字。",
        imageUrl: "/inspiration-assets/brand-poster.svg", tags: ["产品海报", "暖金", "极简构图"],
    },
    {
        id: "template-morning-film", type: "video", title: "晨光里的产品短片",
        prompt: "拍摄一段安静的香氛产品短片：晨光穿过窗帘，在浅色桌面上形成缓慢移动的光影。镜头从桌面的留白开始，平稳推进到磨砂玻璃瓶，再缓慢掠过金属瓶盖的细节。保持主体清晰、背景柔和，色调温暖自然，动作连贯克制，结尾停留在完整产品构图。不出现人物、已有商标或额外字幕。",
        imageUrl: "/inspiration-assets/morning-film.svg", tags: ["产品短片", "晨光", "缓慢运镜"],
    },
    {
        id: "template-warm-welcome", type: "audio", title: "一句有温度的欢迎语",
        prompt: "欢迎来到忠恒AI。你可以从一段文字、一张画面，或一个还没成形的想法开始。慢慢说，我们一起把灵感变成作品。",
        imageUrl: "/inspiration-assets/warm-welcome.svg", tags: ["欢迎语", "文字转语音", "创作空间"],
    },
];
