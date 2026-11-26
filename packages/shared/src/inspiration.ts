/** Curated platform content: publishing is an explicit administrator operation. */
export type InspirationItem = {
    id: string;
    type: "image" | "video" | "audio";
    title: string;
    prompt: string;
    imageUrl: string;
    tags: string[];
};
export type InspirationCatalog = { revision: number; items: InspirationItem[] };
export type InspirationWrite = { expectedRevision: number; items: InspirationItem[] };
