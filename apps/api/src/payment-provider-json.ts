import { visit } from "jsonc-parser";

// Unicode-mode matching excludes valid surrogate pairs and detects lone UTF-16 units.
const loneSurrogate = /[\uD800-\uDFFF]/u;

/** Validates the original text only; callers must pass that same text to the query parser. */
export function validatePaymentJson(raw: string):
    | { ok: true; jsonMemberUniqueness: "checked_unique" }
    | { ok: false; code: "invalid_json" | "duplicate_json_member" } {
    try {
        if (typeof raw !== "string" || loneSurrogate.test(raw)) return { ok: false, code: "invalid_json" };
        // Strict grammar check only. Never return this payload or use its rounded numbers.
        JSON.parse(raw);
        const objects: Set<string>[] = [];
        let duplicate = false;
        let invalid = false;
        visit(raw, {
            onObjectBegin() { objects.push(new Set<string>()); },
            onObjectProperty(property) {
                const object = objects[objects.length - 1];
                if (!object || loneSurrogate.test(property)) invalid = true;
                else if (object.has(property)) duplicate = true;
                else object.add(property);
            },
            onObjectEnd() { objects.pop(); },
            onLiteralValue(value) {
                if (typeof value === "string" && loneSurrogate.test(value)) invalid = true;
            },
            onError() { invalid = true; },
        }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
        if (invalid) return { ok: false, code: "invalid_json" };
        if (duplicate) return { ok: false, code: "duplicate_json_member" };
        return { ok: true, jsonMemberUniqueness: "checked_unique" };
    } catch { return { ok: false, code: "invalid_json" }; }
}
