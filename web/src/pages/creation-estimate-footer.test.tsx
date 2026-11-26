import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { mappedImageReferencePrice } from "./image/mapped-image-settings";

function nodes(kind: string) {
    const source = ts.createSourceFile(`${kind}/index.tsx`, readFileSync(new URL(`./${kind}/index.tsx`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let span: ts.JsxElement | undefined, estimate: ts.Expression | undefined, reference: ts.Expression | undefined;
    const visit = (node: ts.Node) => {
        if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === "span" && node.children.some(child => ts.isJsxText(child) && child.text.trim().startsWith("预计"))) span = node;
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === "estimateQuote") estimate = node.initializer;
        if (ts.isVariableDeclaration(node) && node.name.getText(source) === "referencePrice") reference = node.initializer;
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (!span) throw new Error(`Missing real ${kind} input estimate`);
    const footer = span;
    const evaluate = (node: ts.Node, environment: Record<string, unknown>) => {
        const code = ts.transpileModule(`return (${node.getText(source)});`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
        return new Function(...Object.keys(environment), code)(...Object.values(environment));
    };
    return (environment: Record<string, unknown>) => {
        const values = { React, mappedImageReferencePrice, platformParameters: {}, scopeCurrent: () => true, ...environment,
            platform: { mappingModels: [], loading: false, error: "", ...(environment.platform as Record<string, unknown> | undefined) } };
        const estimateQuote = estimate ? evaluate(estimate, values) : null;
        const referencePrice = reference ? evaluate(reference, values) : undefined;
        return renderToStaticMarkup(evaluate(footer, { ...values, estimateQuote, referencePrice }));
    };
}

test("the real image input uses only its current ready quote and drops stale or personal values", () => {
    const render = nodes("image");
    for (const state of [null, { phase: "idle", quote: { quotedUnits: 99 } }, { phase: "uncertain", quote: { quotedUnits: 99 } }, { phase: "ready", intentInvalidated: true, quote: { quotedUnits: 99 } }]) expect(render({ platformMode: true, platform: { state } })).toContain("预计 — 积分");
    const ready = { phase: "ready", intentInvalidated: false, quote: { quotedUnits: 3.25 } };
    expect(render({ platformMode: true, platform: { state: ready } })).toContain("3.25");
    expect(render({ platformMode: false, platform: { state: ready } })).toContain("预计 — 积分");
});

test("the real image footer shows only its exact current published specification before review, without requesting a quote", () => {
    const render = nodes("image"), mappingModels = [{ id: "family", combinations: [{ specification: "1K", available: true, nodeModelId: "published", priceVersion: 4, credits: 9,
        execution: { protocol: "openai-image-v1", parameters: { size: "1536x1024", quality: "high" } } }] }];
    const environment = { platformMode: true, platform: { state: null, mappingModels, loading: false, error: "" }, platformSettingsReviewed: false };
    const parameters = { mappingModelId: "family", mappingSpecification: "1K", imageModel: "published", size: "1536x1024", quality: "high" };
    expect(render({ ...environment, platformParameters: parameters })).toContain("预计 9 积分");
    expect(render({ ...environment, platformParameters: { ...parameters, mappingModelId: undefined } })).toContain("预计 — 积分");
    expect(render({ ...environment, platformParameters: { ...parameters, mappingSpecification: "2K" } })).toContain("预计 — 积分");
    expect(render({ ...environment, scopeCurrent: () => false, platformParameters: parameters })).toContain("预计 — 积分");
});

test("the real audio input uses the selected catalog price and otherwise keeps a placeholder", () => {
    const render = nodes("audio");
    expect(render({ selectedModel: undefined })).toContain("预计 — 积分");
    expect(render({ selectedModel: { audioPricing: { creditsPerUnit: 7 } } })).toContain("7");
});

test("the real video input keeps a placeholder without a published band and shows only the selected server catalogue price", () => {
    expect(nodes("video")({ selectedBand: undefined })).toContain("预计 — 积分");
    expect(nodes("video")({ selectedBand: { credits: 3 } })).toContain("预计 3 积分");
});
