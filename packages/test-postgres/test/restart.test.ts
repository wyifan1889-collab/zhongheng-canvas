import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "pg";
import { createJobQueue } from "@infinite-canvas/jobs";
import { postgresTestUrl } from "../../../apps/api/test/database";

const url = postgresTestUrl();
if (!url) throw new Error("请通过 bun run test:postgres 运行重启验收");
const client = new Client({ connectionString: url });
const errors: Error[] = [];
const queue = createJobQueue(url, (error) => errors.push(error));
beforeAll(async () => { await client.connect(); await queue.start(); }, 30_000);
afterAll(async () => {
    try { await queue.stop(); }
    finally { await client.end(); }
});

test("draft and pending job persist across a real PostgreSQL stop/start", async () => {
    const { rows } = await client.query("SELECT title, document FROM canvas_saas.canvas_draft WHERE id = $1", ["restart-draft"]);
    expect(rows).toEqual([{ title: "重启持久化检查", document: { synthetic: true } }]);
    const [job] = await queue.fetch<{ draftId: string }>("test-server-restart");
    expect(job.data).toEqual({ draftId: "restart-draft" });
    await queue.complete("test-server-restart", job);
    const [stored] = await queue.findJobs("test-server-restart", { id: job.id });
    expect(stored.state).toBe("completed");
    expect(await queue.fetch("test-server-restart")).toEqual([]);
    expect(errors).toEqual([]);
});

test("passwordless and wrong-password network logins are rejected", async () => {
    const invalid = new URL(url!);
    invalid.password = "incorrect-test-password";
    const wrong = new Client({ connectionString: invalid.toString() });
    try { await expect(wrong.connect()).rejects.toThrow(); }
    finally { await wrong.end(); }
    invalid.password = "";
    const noPassword = new Client({ connectionString: invalid.toString(), password: "" });
    try { await expect(noPassword.connect()).rejects.toThrow(); }
    finally { await noPassword.end(); }
});
