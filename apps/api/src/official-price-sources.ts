import { OFFICIAL_PRICE_SOURCES, normalizePriceAmount, parseOfficialPriceEntries, type OfficialPriceEntry, type OfficialPriceSourceId } from "@infinite-canvas/shared";

// These are deliberately narrow document adapters, not a general Markdown parser.
// A changed heading/column/cell must fail the entire source, never silently omit a rate.
function cells(line: string) { return line.trim().slice(1, -1).split("|").map(v => v.trim()); }
function tables(section: string): string[][][] {
    const result: string[][][] = [];
    let table: string[][] | null = null;
    for (const line of section.split(/\r?\n/)) {
        if (!line.trim().startsWith("|")) { table = null; continue; }
        if (!line.trim().endsWith("|")) throw new Error("official_price_format_changed");
        const row = cells(line);
        if (row.every(v => /^:?-+:?$/.test(v))) continue;
        if (!table) { table = []; result.push(table); }
        table.push(row);
    }
    return result;
}
function section(document: string, begin: string, end: string) {
    const start = document.indexOf(begin), stop = document.indexOf(end, start + begin.length);
    const duplicate = document.indexOf(begin, start + begin.length);
    if (start < 0 || stop < 0 || (duplicate !== -1 && duplicate < stop)) throw new Error("official_price_format_changed");
    return document.slice(start + begin.length, stop);
}
function amount(cell: string, anthropic = false): string | null {
    if (cell === "-") return null;
    const match = anthropic ? /^\$(\d+(?:\.\d+)?)\s*\/\s*MTok(?:<sup>[123]<\/sup>)?$/.exec(cell) : /^\$(\d+(?:\.\d+)?)$/.exec(cell);
    const value = match && normalizePriceAmount(match[1]);
    if (value === null || !match) throw new Error("official_price_format_changed");
    return value;
}
const common = "官方直连 Standard 文本标价，USD / 百万 Token；不含 Batch、加速档、地区附加价、工具调用或渠道折扣。仅供对照，完整条件见官方来源。";
export function parseOfficialPriceDocument(source: OfficialPriceSourceId, document: string): OfficialPriceEntry[] {
    const entries: OfficialPriceEntry[] = [];
    if (source === "openai") {
        if (!document.includes("Prices per 1M tokens.")) throw new Error("official_price_format_changed");
        const groups = tables(section(document, "### Standard pricing data", "### Batch pricing data"));
        const shortHeaders = ["Model", "Input", "Output", "Cached input"];
        const longHeaders = ["Model", ...["Short context", "Long context"].flatMap(c => ["input", "output", "cached input", "30m write", "12h write"].map(m => `${c} ${m}`))];
        if (groups.length !== 2 || groups[0]?.[0]?.join("|") !== longHeaders.join("|") || groups[1]?.[0]?.join("|") !== shortHeaders.join("|")) throw new Error("official_price_format_changed");
        const context = /Short context: ≤(\d+)K input tokens\. Long context: >(\d+)K input tokens\./g;
        const thresholds = [...document.matchAll(context)];
        if (thresholds.length !== 1 || thresholds[0]![1] !== thresholds[0]![2]) throw new Error("official_price_context_unknown");
        const threshold = thresholds[0]![1];
        for (const [index, group] of groups.entries()) {
            if (group.length < 2) throw new Error("official_price_empty");
            const labels = index === 0 ? ["短上下文输入", "短上下文输出", "短上下文缓存读取", "短上下文缓存写入（30 分钟）", "短上下文缓存写入（12 小时）",
                "长上下文输入", "长上下文输出", "长上下文缓存读取", "长上下文缓存写入（30 分钟）", "长上下文缓存写入（12 小时）"] : ["输入", "输出", "缓存读取"];
            for (const row of group.slice(1)) {
                if (row.length !== labels.length + 1 || !/^[a-z0-9][a-z0-9.-]*(?: \(<\d+K context length\))?$/.test(row[0]!)) throw new Error("official_price_format_changed");
                const modelName = row[0]!;
                entries.push({ id: `openai:${modelName}`, modelName, context: common + (index === 0 ? ` 短上下文：输入 ≤${threshold}K Token；长上下文：输入 >${threshold}K Token。` : ""),
                    rates: labels.map((label, i) => ({ label, usdPerMillion: amount(row[i + 1]!) })) });
            }
        }
    } else {
        if (!document.includes("All prices are in USD.")) throw new Error("official_price_format_changed");
        const groups = tables(section(document, "## Model pricing", "## Cloud platform pricing"));
        const header = ["Model", "Base input tokens", "5m cache writes", "1h cache writes", "Cache hits and refreshes", "Output tokens"];
        if (groups.length !== 1 || groups[0]?.[0]?.join("|") !== header.join("|") || groups[0].length < 2) throw new Error("official_price_format_changed");
        const tiered = new Map<string, { threshold: string; sides: Set<string> }>();
        for (const row of groups[0].slice(1)) {
            if (row.length !== header.length) throw new Error("official_price_format_changed");
            // Retired entries reference other hosting platforms, outside this first-party scope.
            if (/\(\[retired, except on /.test(row[0]!)) continue;
            let modelName = row[0]!.replace(/ \(\[limited availability\]\(https:\/\/support\.claude\.com\/en\/articles\/\d+\)\)/, "（限量开放）");
            if (!/^Claude [A-Za-z]+ \d+(?:\.\d+)?(?:（限量开放）| \(for prompts (?:up to|over) [\d,]+ tokens\))?$/.test(modelName)) throw new Error("official_price_format_changed");
            const labels = ["普通输入", "缓存写入（5 分钟）", "缓存写入（1 小时）", "缓存读取", "输出"];
            const scope = /for prompts (up to|over) ([\d,]+) tokens/.exec(modelName);
            if (scope) modelName = modelName.replace(/ \(for prompts (?:up to|over) [\d,]+ tokens\)$/, "");
            const id = `anthropic:${modelName}`, existing = entries.find(e => e.id === id);
            const rates = labels.map((label, i) => ({ label: scope ? `提示词${scope[1] === "up to" ? "≤" : ">"}${scope[2]} Token · ${label}` : label, usdPerMillion: amount(row[i + 1]!, true) }));
            if (scope) {
                const prior = tiered.get(id);
                if ((existing && !prior) || (prior && (prior.threshold !== scope[2] || prior.sides.has(scope[1]!)))) throw new Error("official_price_context_unknown");
                const tier = prior ?? { threshold: scope[2]!, sides: new Set<string>() };
                tier.sides.add(scope[1]!); tiered.set(id, tier);
            } else if (existing) throw new Error("official_price_format_changed");
            if (existing) existing.rates.push(...rates);
            else entries.push({ id, modelName, context: common + (scope ? ` 依据完整提示词长度，分别展示 ≤${scope[2]} 与 >${scope[2]} Token 两档。` : ""), rates });
        }
        if ([...tiered.values()].some(t => t.sides.size !== 2)) throw new Error("official_price_context_unknown");
    }
    const parsed = parseOfficialPriceEntries(entries, source);
    if (!parsed?.length) throw new Error("official_price_format_changed");
    return parsed;
}

export async function fetchOfficialPriceEntries(source: OfficialPriceSourceId, options: { fetcher?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<OfficialPriceEntry[]> {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs ?? 15_000)]) : AbortSignal.timeout(options.timeoutMs ?? 15_000);
    const response = await (options.fetcher ?? fetch)(OFFICIAL_PRICE_SOURCES[source].documentUrl, { signal, redirect: "error", credentials: "omit", headers: { accept: "text/markdown" } });
    const limit = 512 * 1024;
    if (!response.ok || !/^text\/(markdown|plain)(?:;|$)/i.test(response.headers.get("content-type") ?? "") ||
        Number(response.headers.get("content-length") ?? 0) > limit || !response.body) {
        await response.body?.cancel(); throw new Error("official_price_source_unavailable");
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const part = await reader.read(); if (part.done) break;
            length += part.value.length;
            if (length > limit) throw new Error("official_price_source_too_large");
            chunks.push(part.value);
        }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return parseOfficialPriceDocument(source, new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
