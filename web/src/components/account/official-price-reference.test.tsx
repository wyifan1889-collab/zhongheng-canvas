import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OfficialPriceReference, OfficialPriceSourceUpdates } from "./official-price-reference";

test("official reference displays source, context, exact USD prices and separate cache TTL lines without conversion", () => {
    const html = renderToStaticMarkup(<OfficialPriceReference sourceId="anthropic" version={2} checkedAt="2026-10-23T00:00:00Z" changedAt="2026-10-22T00:00:00Z" stale changed
        entry={{ id: "anthropic:synthetic", modelName: "Synthetic Model", context: "Standard · 输入上下文不超过 200K · 仅合成",
            rates: [{ label: "输入", usdPerMillion: "2.5" }, { label: "缓存读取", usdPerMillion: "0.000001" }, { label: "缓存写入（5 分钟）", usdPerMillion: "3.125" }, { label: "缓存写入（1 小时）", usdPerMillion: null }, { label: "输出", usdPerMillion: "10" }] }} />);
    for (const text of ["Anthropic", "Synthetic Model", "200K", "2.5 USD / 百万 Token", "0.000001 USD / 百万 Token", "缓存写入（5 分钟）", "缓存写入（1 小时）", "官方未提供 / 不适用", "旧参考价", "此条目有更新", "参考版本 2", "最近成功核对", "来源最近变更", "不计算折扣", "不会改动平台售价", "不与包含它们的输入量重复相加"]) expect(html).toContain(text);
    expect(html).toContain("https://platform.claude.com/docs/en/about-claude/pricing"); expect(html).not.toContain("配置成本"); expect(html).not.toContain("% off");
});

test("an explicitly free official rate is shown as zero, not confused with missing price", () => {
    const html = renderToStaticMarkup(<OfficialPriceReference sourceId="openai" version={1} checkedAt="2026-10-23T00:00:00Z" changedAt={null} stale={false}
        entry={{ id: "openai:synthetic", modelName: "Synthetic", context: "Standard · synthetic only", rates: [{ label: "输入", usdPerMillion: "0" }] }} />);
    expect(html).toContain("0 USD / 百万 Token"); expect(html).not.toContain("旧参考价"); expect(html).not.toContain("官方未提供");
});

test("source updates are visible before choosing an entry and do not claim a platform price update", () => {
    const source = { id: "openai" as const, version: 2, checkedAt: "2026-10-23T00:00:00Z", attemptedAt: "2026-10-23T00:00:00Z", changedAt: "2026-10-22T00:00:00Z", status: "ready" as const,
        entries: [], changedEntryIds: ["openai:changed", "openai:removed"] };
    const html = renderToStaticMarkup(<OfficialPriceSourceUpdates sources={[source]} />);
    expect(html).toContain('role="status"'); expect(html).toContain("OpenAI：2 项参考条目有变化"); expect(html).toContain("平台售价未随之修改");
    expect(html).toContain(new Date(source.changedAt).toLocaleString());
    expect(renderToStaticMarkup(<OfficialPriceSourceUpdates sources={[{ ...source, changedEntryIds: [] }]} />)).toBe("");
});
