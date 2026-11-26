import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ImageSpecHistory } from "./canvas-platform-image-modal";

test("owner specification history renders original exact fields as read-only information", () => {
    const html = renderToStaticMarkup(<ImageSpecHistory snapshot={{ status: "recorded", parameters: { size: "2048x2048", quality: "high" } }} />);
    expect(html).toContain("受理时图片规格"); expect(html).toContain("2048x2048"); expect(html).toContain("high");
    expect(html).toContain("原任务"); expect(html).not.toMatch(/<(?:input|select|button)\b/);
});

test("partial original selections are not filled from current settings or inferred size labels", () => {
    const html = renderToStaticMarkup(<ImageSpecHistory snapshot={{ status: "recorded", parameters: { quality: "low" } }} />);
    expect(html).toContain("low"); expect(html).not.toContain("尺寸："); expect(html).not.toContain("1024"); expect(html).not.toContain("auto");
});

test("invalid source displays a warning without treating it as a recorded specification", () => {
    const html = renderToStaticMarkup(<ImageSpecHistory snapshot={{ status: "invalid" }} />);
    expect(html).toContain("受理时图片规格无法核对"); expect(html).toContain("保留任务号");
    expect(html).not.toContain("尺寸："); expect(html).not.toContain("质量："); expect(html).not.toContain("2048");
});

test("legacy tasks with no specification keep their original UI without a new fallback", () => {
    expect(renderToStaticMarkup(<ImageSpecHistory />)).toBe("");
});
