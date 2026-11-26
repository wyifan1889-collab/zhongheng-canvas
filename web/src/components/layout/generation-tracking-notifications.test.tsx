import { expect, test } from "bun:test";
import { isValidElement, type ReactElement } from "react";
import type { ArgsProps } from "antd/es/notification/interface";
import type { GenerationTrackingScope } from "@/services/saas/generation";
import type { GenerationTrackerNotice } from "@/stores/use-generation-tracker";
import { createGenerationNotificationBridge, navigateToGenerationOrigin } from "./generation-tracking-notifications";

const scope = { accountId: "synthetic-owner", epoch: 4 };
function fixture() {
    let account: GenerationTrackingScope | null = scope, valid = true;
    const opened: ArgsProps[] = [], destroyed: unknown[] = [], navigation: { route: string; isCurrent: () => boolean }[] = [];
    const bridge = createGenerationNotificationBridge({ getScope: () => account,
        notification: { open: value => { opened.push(value); }, destroy: key => { destroyed.push(key); } },
        navigate: (route, isCurrent) => { navigation.push({ route, isCurrent }); } });
    const notice: GenerationTrackerNotice = { ...scope, key: "generation:synthetic-owner:task", taskId: "11111111-1111-4111-8111-111111111111",
        originRoute: "/canvas/synthetic-original", kindHint: "text", title: "任务处理完成，查看回执", description: "请在原画布主动核对回执。", level: "success", isCurrent: () => valid };
    const click = () => {
        const action = opened.at(-1)?.actions;
        expect(isValidElement(action)).toBe(true);
        (action as ReactElement<{ onClick: () => void }>).props.onClick();
    };
    return { bridge, notice, opened, destroyed, navigation, click, account: (next: GenerationTrackingScope | null) => { account = next; }, invalidate: () => { valid = false; } };
}

test("T4 notification actions retain the original route and provide a fresh account guard", () => {
    const f = fixture();
    f.bridge.notify(f.notice);
    expect(f.opened).toHaveLength(1);
    expect(f.opened[0]).toMatchObject({ key: f.notice.key, type: "success", role: "status" });
    f.click();
    expect(f.navigation[0].route).toBe("/canvas/synthetic-original");
    expect(f.navigation[0].isCurrent()).toBe(true);
    f.account({ ...scope, epoch: 5 });
    expect(f.navigation[0].isCurrent()).toBe(false);
    f.click();
    f.bridge.notify(f.notice);
    expect(f.navigation).toHaveLength(1);
    expect(f.opened).toHaveLength(1);
});

test("T4 deferred router loading cannot navigate after the notification loses authority", async () => {
    const f = fixture();
    f.bridge.notify(f.notice); f.click();
    let resolve!: (value: { router: { navigate: (route: string) => void } }) => void;
    const loading = new Promise<{ router: { navigate: (route: string) => void } }>(done => { resolve = done; });
    const routes: string[] = [], action = f.navigation[0];
    const pending = navigateToGenerationOrigin(action.route, action.isCurrent, () => loading);
    f.account({ ...scope, epoch: 5 });
    resolve({ router: { navigate: route => { routes.push(route); } } });
    await pending;
    expect(routes).toEqual([]);
    let loaded = false;
    await navigateToGenerationOrigin(action.route, action.isCurrent, async () => { loaded = true; return { router: { navigate: () => {} } }; });
    expect(loaded).toBe(false);
});

test("T4 revoked tasks and teardown invalidate old buttons and only destroy owned notification keys", () => {
    const f = fixture();
    f.bridge.notify(f.notice);
    f.invalidate();
    f.click();
    expect(f.navigation).toHaveLength(0);
    f.bridge.dismiss("another-module-notice");
    expect(f.destroyed).toEqual([]);
    f.bridge.close();
    f.click();
    expect(f.navigation).toHaveLength(0);
    expect(f.destroyed).toEqual([f.notice.key]);
    f.bridge.notify(f.notice);
    expect(f.opened).toHaveLength(1);
});

test("T4 notifications reject unavailable accounts and external or query-bearing destinations", () => {
    for (const route of ["https://example.invalid/canvas/a", "//example.invalid/a", "/canvas/a?token=synthetic", "/canvas/a#fragment", "/video?task=synthetic", "/video#fragment", "/video/other", "https://example.invalid/video", "/image?task=synthetic", "/image#fragment", "/image/other", "https://example.invalid/image", "/audio?task=synthetic", "/audio#fragment", "/audio/other", "https://example.invalid/audio"]) {
        const f = fixture(); f.bridge.notify({ ...f.notice, originRoute: route });
        expect(f.opened).toHaveLength(0);
    }
    const f = fixture(); f.account(null); f.bridge.notify(f.notice);
    expect(f.opened).toHaveLength(0);
    f.account({ ...scope, accountId: "other-synthetic-owner" }); f.bridge.notify(f.notice);
    expect(f.opened).toHaveLength(0);
});

test("T4 video notifications return to its fixed legacy workbench route and reject stale account actions", () => {
    const f = fixture(); f.bridge.notify({ ...f.notice, originRoute: "/video", kindHint: "video", level: "warning" });
    expect(f.opened).toHaveLength(1);
    expect((f.opened[0].actions as ReactElement<{ children: string }>).props.children).toBe("返回视频工作台");
    f.click(); expect(f.navigation[0].route).toBe("/video");
    f.account({ ...scope, epoch: 5 }); f.click(); expect(f.navigation).toHaveLength(1); expect(f.navigation[0].isCurrent()).toBe(false);
});

test("T4 audio notifications return to its fixed workbench route and stop old account navigation", () => {
    const f = fixture(); f.bridge.notify({ ...f.notice, originRoute: "/audio", kindHint: "audio", level: "warning" });
    expect(f.opened).toHaveLength(1);
    expect((f.opened[0].actions as ReactElement<{ children: string }>).props.children).toBe("返回音频工作台");
    f.click(); expect(f.navigation[0].route).toBe("/audio");
    f.account({ ...scope, epoch: 5 }); f.click();
    expect(f.navigation).toHaveLength(1); expect(f.navigation[0].isCurrent()).toBe(false);
});

test("T4 image workbench completion returns to the fixed image route, and old account buttons lose authority", () => {
    const f = fixture(); f.bridge.notify({ ...f.notice, originRoute: "/image", kindHint: "image" });
    expect(f.opened).toHaveLength(1);
    const button = f.opened[0].actions as ReactElement<{ children: string }>;
    expect(button.props.children).toBe("返回图片工作台"); f.click();
    expect(f.navigation[0].route).toBe("/image"); expect(f.navigation[0].isCurrent()).toBe(true);
    f.account({ ...scope, accountId: "other-owner", epoch: 5 }); f.click();
    expect(f.navigation).toHaveLength(1); expect(f.navigation[0].isCurrent()).toBe(false);
});
