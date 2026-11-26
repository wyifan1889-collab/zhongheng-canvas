import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";

dayjs.extend(relativeTime);

export function canvasSavedRelativeTime(savedAt: number | undefined, now = Date.now()): string | null {
    if (savedAt === undefined || !Number.isFinite(savedAt) || savedAt <= 0 || !Number.isFinite(now) || savedAt > now) return null;
    return dayjs(savedAt).locale("zh-cn").from(dayjs(now));
}
