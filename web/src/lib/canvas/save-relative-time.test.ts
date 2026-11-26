import { expect, test } from "bun:test";
import dayjs from "dayjs";
import { canvasSavedRelativeTime } from "./save-relative-time";

const savedAt = Date.parse("2026-10-25T12:00:00Z");

test("T2 saved time uses local Chinese relative wording", () => {
    expect(canvasSavedRelativeTime(savedAt, savedAt + 180_000)).toBe("3 分钟前");
});

test("T2 saved time advances when the clock ticks without a new save", () => {
    expect(canvasSavedRelativeTime(savedAt, savedAt + 60_000)).toBe("1 分钟前");
    expect(canvasSavedRelativeTime(savedAt, savedAt + 120_000)).toBe("2 分钟前");
});

test("T2 unknown invalid or future save times retain the original status wording", () => {
    for (const value of [undefined, NaN, Infinity, 0, -1, savedAt + 1]) {
        expect(canvasSavedRelativeTime(value, savedAt)).toBeNull();
    }
});

test("T2 Chinese save formatting does not change the application's global locale", () => {
    const locale = dayjs.locale();
    canvasSavedRelativeTime(savedAt, savedAt + 180_000);
    expect(dayjs.locale()).toBe(locale);
});
