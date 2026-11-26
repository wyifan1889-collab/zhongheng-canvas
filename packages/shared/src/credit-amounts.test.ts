import { describe, expect, test } from "bun:test";
import { normalizeCreditAmount, addCreditAmounts, subtractCreditAmounts, compareCreditAmounts } from "./credit-amounts";

describe("exact credit amounts", () => {
    test("canonical decimal strings preserve tiny amounts and safe old integer inputs", () => {
        expect(normalizeCreditAmount("0.004000")).toBe("0.004");
        expect(normalizeCreditAmount("-0.000")).toBe("0");
        expect(normalizeCreditAmount(7)).toBe("7");
        expect(normalizeCreditAmount("9007199254740993.0000000000000001")).toBe("9007199254740993.0000000000000001");
        for (const value of [0.004, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "1e-3", "+1", " 1", "01", "-Infinity", "NaN", null]) {
            expect(normalizeCreditAmount(value)).toBeNull();
        }
    });
    test("decimal addition, subtraction and ordering never round through binary floats", () => {
        expect(addCreditAmounts("0.1", "0.2")).toBe("0.3");
        expect(subtractCreditAmounts("1", "0.004")).toBe("0.996");
        expect(addCreditAmounts("0.004", "-0.004")).toBe("0");
        expect(addCreditAmounts("-0.01", "0.004")).toBe("-0.006");
        expect(subtractCreditAmounts("0", "-0.01")).toBe("0.01");
        expect(compareCreditAmounts("0.999999999999999999", "1")).toBe(-1);
        expect(compareCreditAmounts("-0.004", "-0.005")).toBe(1);
        expect(compareCreditAmounts("1.000", "1")).toBe(0);
        expect(addCreditAmounts("9007199254740993", "0.0000000000000001")).toBe("9007199254740993.0000000000000001");
    });
    test("storage limits are checked rather than silently rounded", () => {
        const smallest = `0.${"0".repeat(16382)}1`;
        expect(addCreditAmounts("0", smallest)).toBe(smallest);
        expect(normalizeCreditAmount(`0.${"0".repeat(16383)}1`)).toBeNull();
        expect(() => addCreditAmounts("9".repeat(131072), "1")).toThrow(RangeError);
        expect(() => subtractCreditAmounts("NaN", "1")).toThrow(RangeError);
    });
});
