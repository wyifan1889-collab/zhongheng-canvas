import assert from "node:assert/strict";
import test from "node:test";
import { codexToolScope, codexToolSource } from "./codex-tool-scope.js";

test("MCP routing only reads runtime turn metadata, never tool arguments or flat guesses", () => {
    assert.deepEqual(codexToolScope({ "x-codex-turn-metadata": { thread_id: "thread-1", turn_id: "turn-1", model: "ignored" } }), { threadId: "thread-1", turnId: "turn-1" });
    assert.deepEqual(codexToolScope({ threadId: "t", "x-codex-turn-metadata": { thread_id: "t", turn_id: "u" } }), { threadId: "t", turnId: "u" });
    assert.equal(codexToolScope({ threadId: "other", "x-codex-turn-metadata": { thread_id: "t", turn_id: "u" } }), undefined);
    assert.equal(codexToolScope({ threadId: null, "x-codex-turn-metadata": { thread_id: "t", turn_id: "u" } }), undefined);
    for (const input of [null, [], "{}", {}, { threadId: "t", turnId: "u" }, { threadId: "t", "x-codex-turn-metadata": { thread_id: "t" } }, { "x-codex-turn-metadata": "{\"thread_id\":\"t\",\"turn_id\":\"u\"}" }, { "x-codex-turn-metadata": { thread_id: ["t"], turn_id: "u" } }, { "x-codex-turn-metadata": { thread_id: "t", turn_id: "" } }]) {
        assert.equal(codexToolScope(input), undefined);
    }
});

test("provided malformed metadata is explicit and cannot downgrade to legacy", () => {
    assert.equal(codexToolSource(undefined), undefined);
    for (const meta of [null, [], "{}", { threadId: "wrong", "x-codex-turn-metadata": { thread_id: "t", turn_id: "u" } }, { threadId: "t" }, { turn_id: "u" }]) assert.deepEqual(codexToolSource(meta), { invalid: true });
    assert.deepEqual(codexToolSource({ "x-codex-turn-metadata": { thread_id: "t", turn_id: "u" } }), { threadId: "t", turnId: "u" });
});

test("generic MCP metadata without a Codex source declaration retains legacy routing", () => {
    for (const meta of [{}, { progressToken: "synthetic-progress" }, { progressToken: 42, custom: { value: true } }]) assert.equal(codexToolSource(meta), undefined);
});
