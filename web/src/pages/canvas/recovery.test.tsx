import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
(globalThis as any).__APP_VERSION__ = "b05-isolated-test";
(globalThis as any).__APP_RELEASES__ = [];
const { MissingLocalCanvas } = await import("./project");

test("missing local graph keeps its exact identity and explains the recovery sources without claiming deletion", () => {
    const id = "tfG4kIqDWG14R0wJpvW_P";
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={[`/canvas/${id}`]}><MissingLocalCanvas id={id} /></MemoryRouter>);
    for (const text of [id, "当前浏览器未找到这个本机画布", "无法判断原稿是否丢失", "原浏览器数据", "有效导出", "已保存的云稿", "生成图片不能代替", "查看创作历史", "查看已有云稿"]) expect(html).toContain(text);
    expect(html).not.toContain("还没有画布");
    expect(html).not.toContain("数据不可恢复");
});
