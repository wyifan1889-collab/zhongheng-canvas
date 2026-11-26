export type ReferenceLabelToken = { type: "text"; value: string } | { type: "reference"; label: string };

export function referenceLabelPattern(labels: string[]): RegExp | null {
    if (!labels.length) return null;
    const alternatives = Array.from(new Set(labels)).sort((a, b) => b.length - a.length).map(label => {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // A numbered label must not consume the prefix of a different number.
        return `${escaped}${/\d$/.test(label) ? "(?!\\d)" : ""}`;
    });
    return new RegExp(alternatives.join("|"), "g");
}

export function parseReferenceLabelTokens(value: string, labels: string[]): ReferenceLabelToken[] {
    const pattern = referenceLabelPattern(labels);
    if (!pattern) return value ? [{ type: "text", value }] : [];
    const tokens: ReferenceLabelToken[] = [];
    let lastIndex = 0;
    for (const match of value.matchAll(pattern)) {
        if (match.index === undefined) continue;
        if (match.index > lastIndex) tokens.push({ type: "text", value: value.slice(lastIndex, match.index) });
        tokens.push({ type: "reference", label: match[0] });
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < value.length) tokens.push({ type: "text", value: value.slice(lastIndex) });
    return tokens;
}
