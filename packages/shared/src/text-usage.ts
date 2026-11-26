/** Provider-reported evidence, not independently verified usage or a billing policy. */
export type TextUsageEvidence = {
    schemaVersion: 1;
    source: "chat_completions" | "responses";
    status: "complete" | "missing" | "invalid";
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    totalSource: "reported" | "derived" | null;
    /** Subset of inputTokens; never add it to the parent count. */
    cachedInputTokens: number | null;
    /** Explicit provider-reported writes. Absence stays unknown, never zero. */
    cacheWriteTokens?: number;
    /** Subset of outputTokens; never add it to the parent count. */
    reasoningOutputTokens: number | null;
    reason: "missing_usage" | "missing_counts" | "invalid_counts" | "conflicting_counts" | "inconsistent_total" | "invalid_details" | null;
};

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const empty = (source: TextUsageEvidence["source"], status: "missing" | "invalid", reason: TextUsageEvidence["reason"]): TextUsageEvidence => ({
    schemaVersion: 1, source, status, reason,
    inputTokens: null, outputTokens: null, totalTokens: null, totalSource: null,
    cachedInputTokens: null, reasoningOutputTokens: null,
});
type CountRead = { value: number | null; reason: "invalid_counts" | "conflicting_counts" | null };
function readAliases(record: Record<string, unknown>, names: string[]): CountRead {
    const values = names.filter((name) => Object.hasOwn(record, name)).map((name) => record[name]);
    if (values.some((value) => !count(value))) return { value: null, reason: "invalid_counts" };
    if (values.some((value) => value !== values[0])) return { value: null, reason: "conflicting_counts" };
    return { value: values.length ? values[0] as number : null, reason: null };
}
function readDetail(record: Record<string, unknown>, names: string[], key: string, parent: number | null): CountRead {
    const details: Record<string, unknown> = {};
    for (const name of names) {
        if (!Object.hasOwn(record, name)) continue;
        const value = record[name];
        if (!object(value)) return { value: null, reason: "invalid_counts" };
        if (Object.hasOwn(value, key)) details[name] = value[key];
    }
    const result = readAliases(details, names);
    if (result.value !== null && (parent === null || result.value > parent)) return { value: null, reason: "invalid_counts" };
    return result;
}

function normalizeUsage(value: unknown, source: TextUsageEvidence["source"]): TextUsageEvidence {
    if (value === undefined) return empty(source, "missing", "missing_usage");
    if (!object(value)) return empty(source, "invalid", "invalid_counts");
    const responses = source === "responses";
    const input = readAliases(value, responses ? ["input_tokens"] : ["prompt_tokens", "input_tokens"]);
    const output = readAliases(value, responses ? ["output_tokens"] : ["completion_tokens", "output_tokens"]);
    const total = readAliases(value, ["total_tokens"]);
    const error = input.reason ?? output.reason ?? total.reason;
    if (error) return empty(source, "invalid", error);
    let cached = readDetail(value, responses ? ["input_tokens_details"] : ["prompt_tokens_details", "input_tokens_details"], "cached_tokens", input.value);
    if (!responses) {
        // DeepSeek reports the same cache reads at the top level. Misses partition
        // the input total; they are not cache writes and cannot invent a missing hit count.
        const hit = readAliases(value, ["prompt_cache_hit_tokens"]), miss = readAliases(value, ["prompt_cache_miss_tokens"]);
        if (hit.reason || miss.reason || hit.value !== null && (input.value === null || hit.value > input.value ||
            cached.value !== null && cached.value !== hit.value)) return empty(source, "invalid", "invalid_details");
        if (hit.value !== null) cached = { value: hit.value, reason: cached.reason };
        if (miss.value !== null && (input.value === null || miss.value > input.value ||
            cached.value !== null && cached.value !== input.value - miss.value)) return empty(source, "invalid", "invalid_details");
    }
    const detailNames = responses ? ["input_tokens_details"] : ["prompt_tokens_details", "input_tokens_details"];
    const writes = readDetail(value, detailNames, "cache_write_tokens", input.value);
    const reasoning = readDetail(value, responses ? ["output_tokens_details"] : ["completion_tokens_details", "output_tokens_details"], "reasoning_tokens", output.value);
    if (cached.reason || writes.reason || reasoning.reason || (writes.value !== null && cached.value !== null && writes.value + cached.value > input.value!)) return empty(source, "invalid", "invalid_details");
    // Writes are not an extra charge on top of ordinary input. Retain their
    // total so a read-only-cache tariff can refuse unsupported write usage.
    for (const name of detailNames) {
        const detail = value[name];
        if (!object(detail) || !Object.hasOwn(detail, "cache_write_tokens_details")) continue;
        const lifetimes = detail.cache_write_tokens_details;
        if (!object(lifetimes) || Object.keys(lifetimes).length !== 2 || !count(lifetimes.ttl_30m_tokens) || !count(lifetimes.ttl_12h_tokens) ||
            !count(detail.cache_write_tokens) || lifetimes.ttl_30m_tokens + lifetimes.ttl_12h_tokens !== detail.cache_write_tokens) return empty(source, "invalid", "invalid_details");
    }
    const sum = input.value !== null && output.value !== null ? input.value + output.value : null;
    if ((sum !== null && !count(sum)) || (total.value !== null && (
        (sum !== null && total.value !== sum) ||
        (input.value !== null && total.value < input.value) || (output.value !== null && total.value < output.value)
    ))) return empty(source, "invalid", "inconsistent_total");
    return {
        schemaVersion: 1, source, status: sum === null ? "missing" : "complete",
        inputTokens: input.value, outputTokens: output.value, totalTokens: total.value ?? sum,
        totalSource: total.value !== null ? "reported" : sum !== null ? "derived" : null,
        cachedInputTokens: cached.value, reasoningOutputTokens: reasoning.value,
        ...(writes.value !== null ? { cacheWriteTokens: writes.value } : {}),
        reason: sum === null ? "missing_counts" : null,
    };
}

/** Normalize the usage member of a non-streaming Chat Completions response. */
export function normalizeChatUsage(value: unknown): TextUsageEvidence {
    return normalizeUsage(value, "chat_completions");
}

/** Normalize Responses usage independently of visible output or response status.
 * Null/absent usage stays missing. An explicit cache-write total is retained as
 * evidence, without inferring a write price or execution support.
 */
export function normalizeResponsesUsage(value: unknown): TextUsageEvidence {
    return normalizeUsage(value === null ? undefined : value, "responses");
}

/** Validate a stored/public evidence DTO without accepting extra provider fields. */
export function parseTextUsageEvidence(value: unknown): TextUsageEvidence | null {
    const fields = ["schemaVersion", "source", "status", "inputTokens", "outputTokens", "totalTokens", "totalSource", "cachedInputTokens", "reasoningOutputTokens", "reason",
        ...(object(value) && Object.hasOwn(value, "cacheWriteTokens") ? ["cacheWriteTokens"] : [])];
    if (!object(value) || Object.keys(value).length !== fields.length || !fields.every((key) => Object.hasOwn(value, key)) ||
        value.schemaVersion !== 1 || (value.source !== "chat_completions" && value.source !== "responses")) return null;
    const numberFields = ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningOutputTokens"] as const;
    if (numberFields.some((key) => value[key] !== null && !count(value[key]))) return null;
    if (Object.hasOwn(value, "cacheWriteTokens") && (!count(value.cacheWriteTokens) ||
        value.status !== "complete" && !(value.status === "missing" && value.reason === "missing_counts"))) return null;
    if (value.status === "invalid") {
        return numberFields.every((key) => value[key] === null) && value.totalSource === null &&
            ["invalid_counts", "conflicting_counts", "inconsistent_total", "invalid_details"].includes(value.reason as string)
            ? empty(value.source, "invalid", value.reason as TextUsageEvidence["reason"]) : null;
    }
    if (value.status === "missing" && value.reason === "missing_usage") {
        return numberFields.every((key) => value[key] === null) && value.totalSource === null ? empty(value.source, "missing", "missing_usage") : null;
    }
    // Reuse the same arithmetic/subset rules, while retaining the reported/derived distinction.
    const usage: Record<string, unknown> = {};
    if (value.inputTokens !== null) usage.input_tokens = value.inputTokens;
    if (value.outputTokens !== null) usage.output_tokens = value.outputTokens;
    if (value.totalSource === "reported") usage.total_tokens = value.totalTokens;
    if (value.cachedInputTokens !== null || Object.hasOwn(value, "cacheWriteTokens")) usage.input_tokens_details = {
        ...(value.cachedInputTokens !== null ? { cached_tokens: value.cachedInputTokens } : {}),
        ...(Object.hasOwn(value, "cacheWriteTokens") ? { cache_write_tokens: value.cacheWriteTokens } : {}),
    };
    if (value.reasoningOutputTokens !== null) usage.output_tokens_details = { reasoning_tokens: value.reasoningOutputTokens };
    const normalized = normalizeUsage(usage, value.source);
    return fields.every((key) => normalized[key as keyof TextUsageEvidence] === value[key]) ? normalized : null;
}
