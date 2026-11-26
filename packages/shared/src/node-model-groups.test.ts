import { expect, test } from "bun:test";
import { parseNodeModelGroups, parseNodeModelGroupsWrite } from "./node-model-groups";

test("groups preserve order and require distinct stable IDs and visible names", () => {
    const first = { id: crypto.randomUUID(), name: "GPT" }, second = { id: crypto.randomUUID(), name: "DeepSeek" };
    const write = { capability: "text", expectedVersion: 0, groups: [second, first] };
    expect(parseNodeModelGroupsWrite(write)?.groups).toEqual([second, first]);
    expect(parseNodeModelGroupsWrite({ ...write, groups: [first, { ...second, name: "gpt" }] })).toBeNull();
    expect(parseNodeModelGroupsWrite({ ...write, groups: [first, { ...second, id: first.id.toUpperCase() }] })).toBeNull();
    expect(parseNodeModelGroupsWrite({ ...write, groups: [{ ...first, name: " GPT " }] })).toBeNull();
    expect(parseNodeModelGroupsWrite({ ...write, capability: "music" })).toBeNull();
    expect(parseNodeModelGroupsWrite({ ...write, groups: [{ ...first, secret: "unexpected" }] })).toBeNull();
});

test("CATALOG-03 audio groups retain their order and capability as data", () => {
    const groups = [{ id: crypto.randomUUID(), name: "语音合成" }, { id: crypto.randomUUID(), name: "其他音频" }];
    expect(parseNodeModelGroupsWrite({ capability: "audio", expectedVersion: 0, groups })).toEqual({ capability: "audio", expectedVersion: 0, groups });
    expect(parseNodeModelGroups({ capability: "audio", version: 1, groups })).toEqual({ capability: "audio", version: 1, groups });
    expect(parseNodeModelGroupsWrite({ capability: ["audio"], expectedVersion: 0, groups })).toBeNull();
});

test("empty group sets are explicit and read versions never become write permissions", () => {
    expect(parseNodeModelGroupsWrite({ capability: "image", expectedVersion: 0, groups: [] })).toEqual({ capability: "image", expectedVersion: 0, groups: [] });
    expect(parseNodeModelGroups({ capability: "video", version: 2_147_483_647, groups: [] })?.version).toBe(2_147_483_647);
    expect(parseNodeModelGroupsWrite({ capability: "video", expectedVersion: 2_147_483_647, groups: [] })).toBeNull();
    expect(parseNodeModelGroups({ capability: "video", version: -1, groups: [] })).toBeNull();
});
