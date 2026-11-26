import { describe, expect, test } from "bun:test";
import { createPreviewService } from "./preview";

describe("isolated UI preview (not real authentication or cloud storage)", () => {
    test("registration requires verification and never accepts a real email", () => {
        const api = createPreviewService();
        expect(() => api.register("Test", "person@real.example", "normal")).toThrow();
        api.register("New", "new@example.test", "normal");
        expect(() => api.login("new@example.test")).toThrow();
        expect(() => api.verify("new@example.test", "link-expired")).toThrow();
        api.verify("new@example.test", "normal");
        expect(api.login("new@example.test").role).toBe("user");
        expect(api.list()).toEqual([]);
        expect(() => api.verify("new@example.test", "normal")).toThrow();
    });
    test("mail failure leaves only an unverified account; resend is recoverable", () => {
        const api = createPreviewService();
        expect(() => api.register("New", "retry@example.test", "mail")).toThrow();
        expect(() => api.login("retry@example.test")).toThrow();
        expect(() => api.verify("retry@example.test", "normal")).toThrow();
        api.resend("retry@example.test", "normal");
        api.verify("retry@example.test", "normal");
        expect(api.login("retry@example.test").name).toBe("New");
    });
    test("captcha/refusal/fault scenarios do not create accounts", () => {
        for (const scenario of ["captcha", "captcha-service", "rate"] as const) {
            const api = createPreviewService();
            expect(() => api.register("New", "blocked@example.test", scenario)).toThrow();
            expect(() => api.login("blocked@example.test")).toThrow();
            api.register("New", "blocked@example.test", "normal");
        }
    });
    test("reset requires a requested link, is single-use and ends the mock session", () => {
        const api = createPreviewService();
        api.login("creator@example.test");
        expect(() => api.resetPassword("creator@example.test", "normal")).toThrow();
        api.requestReset("unknown@example.test", "normal");
        expect(() => api.resetPassword("unknown@example.test", "normal")).toThrow();
        api.requestReset("creator@example.test", "normal");
        expect(() => api.resetPassword("creator@example.test", "link-expired")).toThrow();
        api.resetPassword("creator@example.test", "normal");
        expect(() => api.list()).toThrow();
        expect(() => api.resetPassword("creator@example.test", "normal")).toThrow();
    });
    test("account B cannot read/write A's records and logout removes access", () => {
        const api = createPreviewService();
        api.login("creator@example.test");
        const draft = api.create("Private", "alpha");
        api.logout();
        expect(() => api.get(draft.id)).toThrow();
        api.login("guest@example.test");
        expect(api.list()).toEqual([]);
        expect(() => api.get(draft.id)).toThrow();
        expect(() => api.save(draft, "normal")).toThrow();
        api.login("creator@example.test");
        expect(api.get(draft.id).document.note).toBe("alpha");
    });
    test("editing copies cannot change saved memory until explicit save", () => {
        const api = createPreviewService();
        api.login("creator@example.test");
        const draft = api.create("Saved", "before");
        draft.document.note = "after";
        expect(api.get(draft.id).document.note).toBe("before");
        const saved = api.save(draft, "normal");
        expect(saved.revision).toBe(2);
        expect(api.get(draft.id).document.note).toBe("after");
        saved.document.note = "local-only";
        expect(api.get(draft.id).document.note).toBe("after");
    });
    test("offline/rate/oversize/pending errors leave old and edited contents intact", () => {
        const api = createPreviewService();
        api.login("creator@example.test");
        const original = api.create("Failure", "before");
        const edited = { ...original, document: { note: "keep my work" } };
        for (const scenario of ["offline", "rate", "oversize", "pending"] as const) {
            expect(() => api.save(edited, scenario)).toThrow();
            expect(api.get(original.id)).toEqual(original);
            expect(edited.document.note).toBe("keep my work");
        }
    });
    test("conflict preserves both versions and does not disappear on ordinary retry", () => {
        const api = createPreviewService();
        api.login("creator@example.test");
        const local = api.create("Conflict", "my edit");
        expect(() => api.save(local, "conflict")).toThrow();
        const remote = api.get(local.id);
        expect(remote.revision).toBe(2);
        expect(local.document.note).toBe("my edit");
        expect(() => api.save(local, "normal")).toThrow();
        const copy = api.create("My copy", local.document.note);
        expect(copy.id).not.toBe(local.id);
        expect(api.get(local.id)).toEqual(remote);
    });
    test("expired session rejects save and recovery never auto-saves", () => {
        const api = createPreviewService();
        api.login("creator@example.test");
        const draft = api.create("Expired", "before");
        const edit = { ...draft, document: { note: "preserved" } };
        expect(() => api.save(edit, "expired")).toThrow();
        expect(() => api.list()).toThrow();
        api.login("creator@example.test");
        expect(api.get(draft.id)).toEqual(draft);
        api.save(edit, "normal");
        expect(api.get(draft.id).document.note).toBe("preserved");
    });
    test("new preview instances cannot see old state (no persistence)", () => {
        const first = createPreviewService();
        first.login("creator@example.test");
        const draft = first.create("Tab only");
        const second = createPreviewService();
        expect(() => second.list()).toThrow();
        second.login("creator@example.test");
        expect(() => second.get(draft.id)).toThrow();
        expect(second.list()).toHaveLength(2);
    });
    test("title limits follow approved Unicode count and failures do not overwrite", () => {
        const api = createPreviewService();
        api.login("creator@example.test");
        const draft = api.create("🎨".repeat(100));
        expect(() => api.create(" ")).toThrow();
        expect(() => api.create("字".repeat(101))).toThrow();
        expect(() => api.save({ ...draft, title: " " }, "normal")).toThrow();
        expect(api.get(draft.id)).toEqual(draft);
    });
});
