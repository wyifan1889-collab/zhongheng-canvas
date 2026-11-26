import { expect, test } from "bun:test";

import { parseLegacyAssetCatalog } from "./legacy-asset-import";

test("legacy asset import only accepts the old catalog envelope and detached known assets", () => {
    const source = {
        state: {
            assets: [
                { id: "text-1", kind: "text", title: "旧提示", coverUrl: "", tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", data: { content: "保留" } },
                { id: "bad", kind: "image", title: "缺字段", data: {} },
                { id: "video-1", kind: "video", title: "视频", coverUrl: "", tags: [], createdAt: "2026-01-01", updatedAt: "2026-01-01", data: { url: "blob:old", width: 1, height: 1, bytes: 1, mimeType: "video/mp4", storageKey: "video:old" } },
            ],
        },
    };
    const assets = parseLegacyAssetCatalog(source);
    expect(assets).toHaveLength(2);
    expect(assets[0]).not.toBe(source.state.assets[0]);
    expect(assets[0].data).not.toBe(source.state.assets[0].data);
    source.state.assets[0].data.content = "changed";
    expect((assets[0] as { data: { content: string } }).data.content).toBe("保留");
});

test("malformed or missing legacy storage is treated as empty without inventing assets", () => {
    expect(parseLegacyAssetCatalog(null)).toEqual([]);
    expect(parseLegacyAssetCatalog({ state: { assets: "not-an-array" } })).toEqual([]);
    expect(parseLegacyAssetCatalog({ state: { assets: [{ id: "x", kind: "text", title: "", data: { content: 1 } }] } })).toEqual([]);
});
