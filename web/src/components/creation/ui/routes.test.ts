import { expect, test } from "bun:test";
import { isOwnedUiRoute } from "./routes";
import { isCreationUiRoute } from "./context";

test("presentation opt-in is restricted to the migrated route list", () => {
    for (const path of ["/create", "/music", "/assets", "/inspiration", "/generation/history", "/account", "/login", "/reset-password", "/config", "/drama"]) {
        expect(isOwnedUiRoute(path)).toBe(true);
        expect(isOwnedUiRoute(`${path}/`)).toBe(true);
    }
    for (const path of ["/", "/music/other", "/music//", "/musical", "/canvas", "/canvas/project", "/projects", "/admin", "/prompts", "/image", "/video", "/audio", "/assets/other", "/accounting", "/configuration"]) {
        expect(isOwnedUiRoute(path)).toBe(false);
    }
});

test("an owned UI route does not acquire creation return semantics", () => {
    expect(isCreationUiRoute("/create")).toBe(true);
    for (const path of ["/music", "/assets", "/account", "/config", "/drama", "/inspiration", "/generation/history"]) {
        expect(isOwnedUiRoute(path)).toBe(true);
        expect(isCreationUiRoute(path)).toBe(false);
    }
});
