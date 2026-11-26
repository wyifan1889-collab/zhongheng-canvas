import { afterEach, expect, test } from "bun:test";

import { accountScopedStoreName, getAccountLocalScope, setAccountLocalAccount, subscribeAccountLocalScope } from "./account-local-scope";

afterEach(() => setAccountLocalAccount(null));

test("account local scope starts anonymous and names account stores without a global fallback", () => {
    expect(getAccountLocalScope()).toBeNull();
    expect(accountScopedStoreName("image_files")).toBe("image_files_anonymous");
    setAccountLocalAccount("account-A");
    expect(getAccountLocalScope()).toMatchObject({ accountId: "account-A" });
    expect(accountScopedStoreName("image_files")).toBe("image_files_account_account-A");
    setAccountLocalAccount("account-B");
    expect(accountScopedStoreName("image_files")).toBe("image_files_account_account-B");
});

test("scope listeners observe logout and account changes in order", () => {
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeAccountLocalScope((scope) => seen.push(scope?.accountId ?? null));
    setAccountLocalAccount("account-A");
    setAccountLocalAccount("account-B");
    setAccountLocalAccount(null);
    unsubscribe();
    expect(seen.slice(-4)).toEqual([null, "account-A", "account-B", null]);
});

