import { expect, test } from "bun:test";
import { searchLocalCanvases } from "./local-search";
import { searchLocalDramaProjects } from "../drama/local-search";

const projects = [
    { id: "hidden-keyword", title: "雨夜 Plan [A]", name: "雨夜 Plan [A]", updatedAt: "later" },
    { id: "second", title: "另一部作品", name: "另一部作品", updatedAt: "earlier" },
    { id: "third", title: "Plan 结尾", name: "Plan 结尾", updatedAt: "latest" },
];

const searches: [string, (items: typeof projects, query: string) => typeof projects][] = [
    ["canvas", searchLocalCanvases], ["drama", searchLocalDramaProjects],
];
for (const [label, search] of searches) {
    test(`${label} local search trims whitespace, matches Chinese and ignores letter case`, () => {
        expect(search(projects, "  pLaN \n").map(item => item.id)).toEqual(["hidden-keyword", "third"]);
        expect(search(projects, "雨夜")).toEqual([projects[0]]);
    });

    test(`${label} searches visible names literally rather than IDs or regular expressions`, () => {
        expect(search(projects, "[A]")).toEqual([projects[0]]);
        expect(search(projects, "hidden-keyword")).toEqual([]);
        expect(search(projects, ".*")).toEqual([]);
    });

    test(`${label} keeps source identity and order; clearing restores the original local list`, () => {
        const snapshot = structuredClone(projects);
        const matches = search(projects, "plan");
        expect(matches[0]).toBe(projects[0]);
        expect(matches[1]).toBe(projects[2]);
        expect(projects).toEqual(snapshot);
        expect(search(projects, " \t ")).toBe(projects);
        expect(search([], "plan")).toEqual([]);
    });
}
