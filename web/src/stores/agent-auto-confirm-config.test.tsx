import { afterEach, beforeEach, expect, test } from "bun:test";
import { App } from "antd";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentChatComposer } from "@/components/agent/agent-chat-composer";
import i18n from "@/i18n";
import { canvasThemes } from "@/lib/canvas-theme";
import { useAgentStore } from "./use-agent-store";

let storageDescriptor: PropertyDescriptor | undefined;
let previous: Pick<ReturnType<typeof useAgentStore.getState>, "autoConfirm" | "autoConfirmOwnerContext">;
let values: Map<string, string>;
let storage: Storage;

beforeEach(() => {
    storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const state = useAgentStore.getState();
    previous = { autoConfirm: state.autoConfirm, autoConfirmOwnerContext: state.autoConfirmOwnerContext };
    values = new Map();
    storage = {
        get length() { return values.size; },
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => { values.set(key, value); },
        removeItem: (key) => { values.delete(key); },
        clear: () => values.clear(),
        key: (index) => [...values.keys()][index] ?? null,
    };
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    useAgentStore.setState({ autoConfirm: false, autoConfirmOwnerContext: null });
});

afterEach(() => {
    useAgentStore.setState(previous);
    if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
});

test("T5 stays off until an account is confirmed and ignores the former unscoped setting", () => {
    values.set("canvas-auto-confirm", "true");
    const state = useAgentStore.getState();
    expect(useAgentStore.getInitialState().autoConfirm).toBe(false);
    expect(useAgentStore.getInitialState().autoConfirmOwnerContext).toBeNull();
    state.setAutoConfirm(true);
    expect(useAgentStore.getState().autoConfirm).toBe(false);
    state.setAutoConfirmOwnerContext("account-a");
    expect(useAgentStore.getState().autoConfirm).toBe(false);
    expect(values.size).toBe(1);
});

test("T5 restores each account preference independently after switching or logout", () => {
    const { setAutoConfirm, setAutoConfirmOwnerContext } = useAgentStore.getState();
    const permissionMode = useAgentStore.getState().permissionMode;
    const confirmTools = useAgentStore.getState().confirmTools;
    setAutoConfirmOwnerContext("account-a");
    setAutoConfirm(true);
    expect(values.get("canvas-auto-confirm:account-a")).toBe("true");
    setAutoConfirmOwnerContext("account-b");
    expect(useAgentStore.getState().autoConfirm).toBe(false);
    setAutoConfirm(false);
    setAutoConfirmOwnerContext(null);
    setAutoConfirm(true);
    expect(useAgentStore.getState().autoConfirm).toBe(false);
    expect(values.has("canvas-auto-confirm:null")).toBe(false);
    setAutoConfirmOwnerContext("account-a");
    expect(useAgentStore.getState().autoConfirm).toBe(true);
    setAutoConfirmOwnerContext("account-b");
    expect(useAgentStore.getState().autoConfirm).toBe(false);
    expect(useAgentStore.getState().permissionMode).toBe(permissionMode);
    expect(useAgentStore.getState().confirmTools).toBe(confirmTools);
});

test("T5 personal local mode has a separate preference and blank identity stays unconfirmed", () => {
    const { setAutoConfirm, setAutoConfirmOwnerContext } = useAgentStore.getState();
    setAutoConfirmOwnerContext("account-a");
    setAutoConfirm(true);
    setAutoConfirmOwnerContext("local");
    expect(useAgentStore.getState().autoConfirm).toBe(false);
    setAutoConfirm(true);
    expect(values.get("canvas-auto-confirm:local")).toBe("true");
    setAutoConfirmOwnerContext(" ");
    expect(useAgentStore.getState().autoConfirmOwnerContext).toBeNull();
    expect(useAgentStore.getState().autoConfirm).toBe(false);
});

test("T5 only restores an explicit true value and encodes account keys without collisions", () => {
    const { setAutoConfirm, setAutoConfirmOwnerContext } = useAgentStore.getState();
    for (const value of ["1", "TRUE", "{}", "false", ""]) {
        values.set("canvas-auto-confirm:account-a", value);
        setAutoConfirmOwnerContext("account-a");
        expect(useAgentStore.getState().autoConfirm).toBe(false);
        setAutoConfirmOwnerContext(null);
    }
    setAutoConfirmOwnerContext("a:b");
    setAutoConfirm(true);
    expect(values.get("canvas-auto-confirm:a%3Ab")).toBe("true");
    setAutoConfirmOwnerContext("a%3Ab");
    expect(useAgentStore.getState().autoConfirm).toBe(false);
});

test("T5 storage failures fail closed on restore and do not break a confirmed browser setting", () => {
    const { setAutoConfirm, setAutoConfirmOwnerContext } = useAgentStore.getState();
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("storage denied"); } });
    expect(() => setAutoConfirmOwnerContext("account-a")).not.toThrow();
    expect(useAgentStore.getState().autoConfirm).toBe(false);
    expect(() => setAutoConfirm(true)).not.toThrow();
    expect(useAgentStore.getState().autoConfirm).toBe(true);
    setAutoConfirmOwnerContext(null);
    setAutoConfirmOwnerContext("account-a");
    expect(useAgentStore.getState().autoConfirm).toBe(false);
});

test("T5 composer shows a controlled labelled switch and disables it for unconfirmed accounts", () => {
    const render = (enabled: boolean, disabled: boolean) => renderToStaticMarkup(<App><AgentChatComposer prompt="保留用户草稿" placeholder="输入消息" theme={canvasThemes.dark} onPromptChange={() => {}} onSubmit={() => {}} autoConfirm={enabled} autoConfirmDisabled={disabled} onAutoConfirmChange={() => {}} /></App>);
    const label = i18n.t("agent.interactions.autoConfirmLabel");
    const pending = render(false, true);
    const confirmed = render(true, false);
    expect(pending).toContain(`aria-label="${label}"`);
    expect(pending).toContain('role="switch" aria-checked="false"');
    expect(pending.match(/<button\b(?=[^>]*role="switch")[^>]*>/)?.[0]).toContain("disabled");
    expect(confirmed).toContain('role="switch" aria-checked="true"');
    expect(confirmed).toContain('role="textbox"');
});
