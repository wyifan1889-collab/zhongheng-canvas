import { expect, test } from "bun:test";
import { parseReferenceLabelTokens, referenceLabelPattern } from "./reference-label-tokens";

test.each(["图片", "Image "])("the chip parser leaves unknown longer numbers as text for %s", prefix => {
    const value = `包装写‘${prefix}10’和‘${prefix}12’；${prefix}100。`;
    expect(parseReferenceLabelTokens(value, [`${prefix}1`, `${prefix}2`])).toEqual([{ type: "text", value }]);
});

test.each(["图片", "Image "])("the chip parser recognizes whole known labels while retaining unmatched text for %s", prefix => {
    expect(parseReferenceLabelTokens(`${prefix}10与${prefix}1，印${prefix}100`, [`${prefix}1`, `${prefix}10`])).toEqual([
        { type: "reference", label: `${prefix}10` }, { type: "text", value: "与" },
        { type: "reference", label: `${prefix}1` }, { type: "text", value: `，印${prefix}100` },
    ]);
});

test("literal label punctuation and non-numbered labels retain their original semantics", () => {
    expect(parseReferenceLabelTokens("图(1)1 图(1)10 场景+A", ["图(1)1", "场景+A"])).toEqual([
        { type: "reference", label: "图(1)1" }, { type: "text", value: " 图(1)10 " }, { type: "reference", label: "场景+A" },
    ]);
    expect(referenceLabelPattern([])).toBeNull();
    expect(parseReferenceLabelTokens("原文", [])).toEqual([{ type: "text", value: "原文" }]);
    expect(parseReferenceLabelTokens("", [])).toEqual([]);
});
