import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { codexToolSource } from "./codex-tool-scope.js";

test("installed MCP SDK preserves the original request metadata through a real handler", async () => {
    const server = new McpServer({ name: "synthetic-scope", version: "1" });
    const client = new Client({ name: "synthetic-scope-client", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const seen: unknown[] = [];
    server.registerTool("scope_probe", { inputSchema: { value: z.string() } }, async (_input, extra) => {
        seen.push(extra._meta);
        return { content: [{ type: "text", text: JSON.stringify(codexToolSource(extra._meta) ?? null) }] };
    });
    try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const meta = { threadId: "original-thread", "x-codex-turn-metadata": { thread_id: "original-thread", turn_id: "original-turn" } };
        const result = await client.callTool({ name: "scope_probe", arguments: { value: "synthetic" }, _meta: meta });
        assert.deepEqual(seen, [meta]);
        assert.deepEqual(JSON.parse((result.content as Array<{ text: string }>)[0]!.text), { threadId: "original-thread", turnId: "original-turn" });
        const conflicting = { ...meta, threadId: "wrong-thread" };
        const refused = await client.callTool({ name: "scope_probe", arguments: { value: "synthetic" }, _meta: conflicting });
        assert.deepEqual(seen[1], conflicting);
        assert.deepEqual(JSON.parse((refused.content as Array<{ text: string }>)[0]!.text), { invalid: true });
        const generic = { progressToken: "synthetic-progress" };
        const legacy = await client.callTool({ name: "scope_probe", arguments: { value: "synthetic" }, _meta: generic });
        assert.deepEqual(seen[2], generic);
        assert.equal(JSON.parse((legacy.content as Array<{ text: string }>)[0]!.text), null);
    } finally {
        await client.close();
        await server.close();
    }
});
