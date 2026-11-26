import { expect, test } from "bun:test";
import type { ArgsProps } from "antd/es/notification/interface";
import { createGenerationNotificationPresentation } from "./generation-tracking-notifications";

function fixture() {
    let creation = true, listener = () => {}, unsubscribed = false;
    const ant: ArgsProps[] = [], antClosed: string[] = [], toasts: { notice: ArgsProps; key: string }[] = [], toastClosed: string[] = [];
    const presentation = createGenerationNotificationPresentation({ isCreation: () => creation,
        notification: { open: notice => { ant.push(notice); }, destroy: key => { antClosed.push(String(key)); } },
        showToast: (notice, key) => { toasts.push({ notice, key }); }, dismissToast: key => { toastClosed.push(key); },
        subscribe: next => { listener = next; return () => { unsubscribed = true; listener = () => {}; }; },
    });
    return { presentation, ant, antClosed, toasts, toastClosed, isUnsubscribed: () => unsubscribed, change: (next: boolean) => { creation = next; listener(); } };
}

test("creation notifications retain the task key and action while only using the current presentation", () => {
    const f = fixture(), action = <button>返回原任务</button>, notice = { key: "owner:epoch:task", title: "任务完成", description: "原回执", actions: action };
    f.presentation.open(notice);
    expect(f.ant).toHaveLength(0); expect(f.toasts).toEqual([{ key: notice.key, notice }]);
    expect(f.toasts[0].notice.actions).toBe(action);
    f.change(false);
    expect(f.toastClosed).toEqual([notice.key]); expect(f.antClosed).toEqual([]);
    f.presentation.open(notice);
    expect(f.ant).toEqual([notice]); expect(f.toasts).toHaveLength(1);
    f.change(true);
    expect(f.antClosed).toEqual([notice.key]);
});

test("replacement and teardown dismiss only owned keys and unregister the route listener", () => {
    const f = fixture(), notice = { key: "owner:epoch:task", title: "任务结果待核对" };
    f.presentation.open(notice); f.presentation.open({ ...notice, title: "任务完成" });
    expect(f.toasts).toHaveLength(2); expect(f.toastClosed).toEqual([notice.key]);
    f.presentation.destroy("another-module-notice"); expect(f.toastClosed).toHaveLength(1);
    f.presentation.close(); expect(f.isUnsubscribed()).toBe(true); expect(f.toastClosed).toEqual([notice.key, notice.key]);
    f.change(false); expect(f.antClosed).toEqual([]); expect(f.toastClosed).toHaveLength(2);
});
