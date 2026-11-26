import { expect, test } from "bun:test";
import { accountGateAllowsWorkspace, accountReturnPath, safeAccountReturn } from "./account-navigation";

test("account gate only allows workspace content with a confirmed session", () => {
    expect(accountGateAllowsWorkspace("idle", false)).toBe(false);
    expect(accountGateAllowsWorkspace("loading", false)).toBe(false);
    expect(accountGateAllowsWorkspace("unavailable", false)).toBe(false);
    expect(accountGateAllowsWorkspace("unavailable", true)).toBe(false);
    expect(accountGateAllowsWorkspace("ready", true)).toBe(true);
    expect(accountGateAllowsWorkspace("ready", false)).toBe(false);
});

test("protected return path preserves query and hash exactly", () => {
    expect(accountReturnPath("/canvas/project-1", "?agent=1", "#node-2")).toBe("/canvas/project-1?agent=1#node-2");
});

test("post-login return paths stay local and protected", () => {
    expect(safeAccountReturn("/canvas/project-1?agent=1#node-2")).toBe("/canvas/project-1?agent=1#node-2");
    expect(safeAccountReturn("//evil.example/login")).toBe("/canvas");
    expect(safeAccountReturn("/account?from=secret")).toBe("/canvas");
    expect(safeAccountReturn(null)).toBe("/canvas");
});
