import { expect, test } from "bun:test";
import { isCloudMediaId, normalizeCloudMediaId } from "./cloud-media-reference";

test("cloud media references accept uploaded v4 and generated v5 IDs and normalize case", () => {
    for (const id of ["AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA", "AAAAAAAA-AAAA-5AAA-8AAA-AAAAAAAAAAAA"]) {
        expect(isCloudMediaId(id)).toBe(true);
        expect(normalizeCloudMediaId(id)).toBe(id.toLowerCase());
    }
    for (const value of ["", "not-a-uuid", "aaaaaaaa-aaaa-3aaa-8aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa", "aaaaaaaa-aaaa-5aaa-7aaa-aaaaaaaaaaaa", null, 1]) {
        expect(isCloudMediaId(value)).toBe(false);
        expect(normalizeCloudMediaId(value)).toBeNull();
    }
});
