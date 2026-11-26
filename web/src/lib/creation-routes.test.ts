import { expect, test } from "bun:test";
import {
    creationModeFromSearch, creationModeTarget, creationPath, historyCreationTarget,
    isAgentCreationOrigin, isCreationMediaTarget, legacyCreationTarget,
} from "./creation-routes";

const mediaModes = ["image", "video", "audio"] as const;

for (const mode of mediaModes) test(`legacy ${mode} canonicalization selects its real mode while preserving other query entries and hash`, () => {
    const location = { search: "?mode=agent&receipt=original%2Breceipt&mode=video&filter=one&filter=two&empty=", hash: "#original-receipt" };
    const before = { ...location }, target = legacyCreationTarget(location, mode), query = new URLSearchParams(target.search);
    expect(target.pathname).toBe("/create");
    expect(target.hash).toBe(location.hash);
    expect(query.getAll("mode")).toEqual([mode]);
    expect(query.get("receipt")).toBe("original+receipt");
    expect(query.getAll("filter")).toEqual(["one", "two"]);
    expect(query.get("empty")).toBe("");
    expect(location).toEqual(before);
});

test("root canonicalization uses one supported query mode, with image as the display fallback", () => {
    for (const mode of ["image", "video", "audio", "agent"] as const) {
        const query = `?mode=${mode}&receipt=kept`;
        expect(creationModeFromSearch(query)).toBe(mode);
        expect(legacyCreationTarget({ search: query, hash: "#kept" })).toEqual({ pathname: "/create", search: query, hash: "#kept" });
    }
    for (const search of ["", "?unrelated=kept", "?mode=", "?mode=unknown", "?mode=AGENT", "?mode=image&mode=image", "?mode=audio&mode=agent"]) {
        expect(creationModeFromSearch(search)).toBe("image");
        const target = legacyCreationTarget({ search, hash: "#kept" });
        const original = new URLSearchParams(search);
        expect(new URLSearchParams(target.search).getAll("mode")).toEqual(original.has("mode") ? original.getAll("mode") : ["image"]);
        expect(target.hash).toBe("#kept");
    }
});

test("mode changes preserve encoded prompt characters, repeated unrelated keys and the existing fragment", () => {
    const prompt = "A+B & # /? @图片14\n下一行", query = new URLSearchParams({ mode: "image", prompt });
    query.append("tag", "one"); query.append("tag", "two");
    const target = creationModeTarget("audio", { search: `?${query}`, hash: "#draft-section" });
    const next = new URLSearchParams(target.search);
    expect(target.pathname).toBe("/create"); expect(target.hash).toBe("#draft-section");
    expect(next.getAll("mode")).toEqual(["audio"]); expect(next.get("prompt")).toBe(prompt);
    expect(next.getAll("tag")).toEqual(["one", "two"]);
    expect(creationPath("agent")).toBe("/create?mode=agent");
});

for (const kind of mediaModes) test(`a staged ${kind} handoff accepts its legacy bridge and exactly its current creation mode`, () => {
    expect(isCreationMediaTarget(`/${kind}`, "?mode=conflicting", kind)).toBe(true);
    expect(isCreationMediaTarget("/create", `?mode=${kind}&receipt=kept`, kind)).toBe(true);
    for (const other of ["image", "video", "audio", "agent"] as const) {
        if (other !== kind) expect(isCreationMediaTarget("/create", `?mode=${other}`, kind)).toBe(false);
    }
    expect(isCreationMediaTarget("/create", "", kind)).toBe(kind === "image");
});

test("ambiguous creation modes cannot take a pending launch even when display falls back to image", () => {
    for (const search of ["?mode=", "?mode=unknown", "?mode=image&mode=image", "?mode=image&mode=audio"]) {
        expect(creationModeFromSearch(search)).toBe("image");
        for (const kind of mediaModes) expect(isCreationMediaTarget("/create", search, kind)).toBe(false);
    }
});

test("music and unrelated pages never consume a staged media handoff", () => {
    for (const pathname of ["/", "/music", "/drama", "/generation/history", "/create/", "/create/other", "/canvas/real-canvas", "//outside.invalid/create"]) {
        for (const kind of mediaModes) expect(isCreationMediaTarget(pathname, `?mode=${kind}`, kind)).toBe(false);
    }
});

test("Agent origin accepts the legacy root and only an explicit unambiguous create Agent mode", () => {
    expect(isAgentCreationOrigin("/")).toBe(true);
    expect(isAgentCreationOrigin("/", "?mode=video")).toBe(true);
    expect(isAgentCreationOrigin("/create", "?mode=agent&receipt=kept")).toBe(true);
    for (const search of ["", "?mode=", "?mode=image", "?mode=audio", "?mode=unknown", "?mode=agent&mode=agent", "?mode=agent&mode=image"]) {
        expect(isAgentCreationOrigin("/create", search)).toBe(false);
    }
    for (const pathname of ["/create/", "/create/agent", "/music", "/canvas/real-canvas", "//outside.invalid/create"]) {
        expect(isAgentCreationOrigin(pathname, "?mode=agent")).toBe(false);
    }
});

test("history rows map only known media types and never invent an original canvas route", () => {
    for (const kind of mediaModes) expect(historyCreationTarget(kind)).toBe(`/create?mode=${kind}`);
    for (const type of ["text", "unknown", "agent", "", null, undefined, "image?task=untrusted", "/canvas/guessed"]) {
        expect(historyCreationTarget(type)).toBeNull();
    }
});
