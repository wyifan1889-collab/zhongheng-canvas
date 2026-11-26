import { normalizeCnyAmount } from "./model-cny-pricing";

/** Exact credits use the existing decimal price representation; no currency conversion or rounding. */
export function normalizeCreditAmount(value: unknown): string | null {
    // Existing integer quotes may enter internally as numbers. Fractional numbers
    // have already crossed a floating-point boundary and must never be accepted.
    if (typeof value === "number") {
        if (!Number.isSafeInteger(value)) return null;
        value = String(value);
    }
    if (typeof value !== "string") return null;
    const negative = value.startsWith("-");
    const magnitude = normalizeCnyAmount(negative ? value.slice(1) : value);
    return magnitude === null ? null : negative && magnitude !== "0" ? `-${magnitude}` : magnitude;
}

function parts(value: string) {
    const normalized = normalizeCreditAmount(value);
    if (normalized === null) throw new RangeError("Invalid credit amount");
    const [whole, fraction = ""] = normalized.split(".");
    return { coefficient: BigInt(whole + fraction), scale: fraction.length };
}

function aligned(a: string, b: string) {
    const left = parts(a), right = parts(b);
    const scale = Math.max(left.scale, right.scale);
    return { left: left.coefficient * BigInt(10) ** BigInt(scale - left.scale),
        right: right.coefficient * BigInt(10) ** BigInt(scale - right.scale), scale };
}

function decimal(coefficient: bigint, scale: number): string {
    const negative = coefficient < BigInt(0);
    const digits = (negative ? -coefficient : coefficient).toString().padStart(scale + 1, "0");
    const magnitude = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
    const result = normalizeCreditAmount(negative ? `-${magnitude}` : magnitude);
    if (result === null) throw new RangeError("Credit amount exceeds numeric storage range");
    return result;
}

export function addCreditAmounts(a: string, b: string): string {
    const values = aligned(a, b);
    return decimal(values.left + values.right, values.scale);
}

export function subtractCreditAmounts(a: string, b: string): string {
    const values = aligned(a, b);
    return decimal(values.left - values.right, values.scale);
}

export function compareCreditAmounts(a: string, b: string): -1 | 0 | 1 {
    const values = aligned(a, b);
    return values.left < values.right ? -1 : values.left > values.right ? 1 : 0;
}
