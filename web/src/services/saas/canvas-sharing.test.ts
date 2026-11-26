import { describe, expect, test } from "bun:test";
import { CanvasSharingError, createCanvasSharingClient, type CanvasMember, type CanvasShare } from "./canvas-sharing";
import type { DraftAccountScope } from "./drafts";

const canvasId = "10000000-0000-4000-8000-00000000000a";
const otherCanvasId = "10000000-0000-4000-8000-00000000000b";
const shareId = "20000000-0000-4000-8000-00000000000a";
const token = "30000000-0000-4000-8000-00000000000a";
const timestamp = "2026-10-26T00:00:00.000Z";
const accountId = "Synthetic-Owner";
const scope = (): DraftAccountScope => ({ accountId, epoch: 1 });
const share = (patch: Partial<CanvasShare> = {}): CanvasShare => ({ id: shareId, canvasId, token, role: "viewer", createdBy: accountId, expiresAt: null, createdAt: timestamp, ...patch });
const member = (patch: Partial<CanvasMember> = {}): CanvasMember => ({ canvasId, userId: "Target-User", role: "viewer", invitedBy: accountId, joinedAt: null, ...patch });
const owner = () => member({ userId: accountId, role: "owner", invitedBy: null, joinedAt: timestamp });
const management = () => ({ share: share(), members: [owner(), member()] });
const mockFetch = (run: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): typeof fetch =>
    Object.assign(run, { preconnect: fetch.preconnect });

describe("canvas sharing transport (synthetic HTTP; no server or page acceptance)", () => {
    test("five commands use exact scoped same-origin routes and minimal DTO projections", async () => {
        const calls: { path: string; options: RequestInit }[] = [];
        const targetUserId = "Mixed/Case ?#用户";
        const client = createCanvasSharingClient(scope, mockFetch(async (path, options) => {
            calls.push({ path: String(path), options: options! });
            if (options?.method === "GET") return Response.json({ ...management(), share: { ...share(), privateKey: "discard" }, members: [{ ...owner(), email: "discard" }, member()], requestId: "discard" });
            if (String(path).endsWith("/share-link")) return Response.json({ share: { ...share(), privateKey: "discard" } });
            if (String(path).endsWith("/join")) return Response.json({ member: { ...member({ userId: accountId, joinedAt: timestamp }), email: "discard" } });
            if (options?.method === "DELETE") return Response.json({ ok: true, requestId: "discard" });
            return Response.json({ member: member({ userId: targetUserId }) });
        }));

        expect(await client.read(canvasId.toUpperCase())).toEqual(management());
        expect(await client.createLink(canvasId, { role: "viewer" })).toEqual(share());
        expect(await client.join(token.toUpperCase())).toEqual(member({ userId: accountId, joinedAt: timestamp }));
        expect(await client.addMember(canvasId, { userId: targetUserId, role: "viewer" })).toEqual(member({ userId: targetUserId }));
        expect(await client.removeMember(canvasId, targetUserId)).toBeUndefined();
        expect(calls.map((call) => [call.path, call.options.method])).toEqual([
            [`/api/v1/canvas/${canvasId}/share`, "GET"], [`/api/v1/canvas/${canvasId}/share-link`, "POST"],
            [`/api/v1/canvas/share/${token}/join`, "POST"], [`/api/v1/canvas/${canvasId}/members`, "POST"],
            [`/api/v1/canvas/${canvasId}/members/${encodeURIComponent(targetUserId)}`, "DELETE"],
        ]);
        expect(calls.map((call) => call.options.body)).toEqual([undefined, '{"role":"viewer"}', "{}", JSON.stringify({ userId: targetUserId, role: "viewer" }), undefined]);
        for (const { options } of calls) {
            expect(options.credentials).toBe("same-origin");
            expect(options.redirect).toBe("error");
            expect(options.cache).toBe("no-store");
            expect(options.referrerPolicy).toBe("no-referrer");
            expect(new Headers(options.headers).get("x-canvas-account-id")).toBe(accountId);
            expect(new Headers(options.headers).has("authorization")).toBe(false);
        }
    });

    test("reset is only sent explicitly and a caller cannot change an in-flight role or user", async () => {
        let finish!: (value: Response) => void;
        let sent: RequestInit | undefined;
        const client = createCanvasSharingClient(scope, mockFetch(async (_path, options) => { sent = options; return await new Promise<Response>((resolve) => { finish = resolve; }); }));
        const input = { role: "viewer" as "viewer" | "editor", reset: true };
        const pending = client.createLink(canvasId, input);
        input.role = "editor";
        finish(Response.json({ share: share() }));
        expect(await pending).toEqual(share());
        expect(JSON.parse(String(sent?.body))).toEqual({ role: "viewer", reset: true });
        const invite = { userId: "Target-User", role: "viewer" as "viewer" | "editor" };
        const invited = client.addMember(canvasId, invite);
        invite.userId = "Another-User"; invite.role = "editor";
        finish(Response.json({ member: member() }));
        expect(await invited).toEqual(member());
        expect(JSON.parse(String(sent?.body))).toEqual({ userId: "Target-User", role: "viewer" });
    });

    test("invalid IDs, tokens, roles, extra fields and owner mutations never send", async () => {
        let calls = 0, getters = 0;
        const client = createCanvasSharingClient(scope, mockFetch(async () => { calls++; return Response.json({}); }));
        for (const invalidId of ["", "../session", "//external.example", `${canvasId}?token=${token}`, "local-nanoid"]) {
            await expect(client.read(invalidId)).rejects.toMatchObject({ code: "invalid_input", outcome: "not-sent" });
            await expect(client.createLink(invalidId, { role: "viewer" })).rejects.toMatchObject({ outcome: "not-sent" });
            await expect(client.join(invalidId)).rejects.toMatchObject({ outcome: "not-sent" });
        }
        const accessor = Object.defineProperty({}, "role", { enumerable: true, get() { getters++; return "viewer"; } });
        for (const input of [null, {}, { role: "owner" }, { role: "viewer", reset: 1 }, { role: "viewer", reset: undefined }, { role: "viewer", token }, { role: "viewer", [Symbol()]: "extra" }, accessor, new Date()]) {
            await expect(client.createLink(canvasId, input as Parameters<typeof client.createLink>[1])).rejects.toMatchObject({ code: "invalid_input", outcome: "not-sent" });
        }
        for (const input of [{ userId: "", role: "viewer" }, { userId: " \t", role: "viewer" }, { userId: "user\nheader", role: "viewer" }, { userId: accountId, role: "viewer" }, { userId: "target", role: "owner" }, { userId: "target", role: "viewer", invitedBy: "fake-owner" }]) {
            await expect(client.addMember(canvasId, input as Parameters<typeof client.addMember>[1])).rejects.toMatchObject({ outcome: "not-sent" });
        }
        await expect(client.removeMember(canvasId, accountId)).rejects.toMatchObject({ outcome: "not-sent" });
        await expect(client.removeMember(canvasId, "")).rejects.toMatchObject({ outcome: "not-sent" });
        expect(getters).toBe(0); expect(calls).toBe(0);
    });

    test("pending is retained, but owner must be active and management results cannot cross canvases or identities", async () => {
        const badStates = [
            {}, { members: [owner()] }, { share: null, members: {} },
            { share: share({ canvasId: otherCanvasId }), members: [owner()] },
            { share: share({ createdBy: "Other-Owner" }), members: [owner()] },
            { share: share({ token: "invalid" }), members: [owner()] },
            { share: share({ createdAt: "bad-date" }), members: [owner()] },
            { share: null, members: [owner(), member({ canvasId: otherCanvasId })] },
            { share: null, members: [owner(), member(), member()] },
            { share: null, members: [member()] },
            { share: null, members: [member({ role: "owner", joinedAt: timestamp })] },
            { share: null, members: [owner(), member({ userId: "other-owner", role: "owner", joinedAt: timestamp })] },
            { share: null, members: [member({ userId: accountId, role: "owner", joinedAt: null })] },
            { share: null, members: [owner(), { ...member(), invitedBy: undefined }] },
        ];
        for (const data of badStates) {
            const client = createCanvasSharingClient(scope, mockFetch(async () => Response.json(data)));
            await expect(client.read(canvasId)).rejects.toMatchObject({ code: "unavailable", outcome: "unknown" });
        }
        const client = createCanvasSharingClient(scope, mockFetch(async () => Response.json({ share: null, members: [owner(), member()] })));
        expect((await client.read(canvasId)).members[1].joinedAt).toBeNull();
    });

    test("mutation responses must confirm the requested member/role and a completed join", async () => {
        for (const value of [member(), member({ userId: "Other-User", joinedAt: timestamp }), member({ userId: accountId, joinedAt: null })]) {
            const client = createCanvasSharingClient(scope, mockFetch(async () => Response.json({ member: value })));
            await expect(client.join(token)).rejects.toMatchObject({ outcome: "unknown" });
        }
        for (const value of [member({ canvasId: otherCanvasId }), member({ userId: "Other-User" }), member({ role: "editor" }), member({ joinedAt: "invalid-date" })]) {
            const client = createCanvasSharingClient(scope, mockFetch(async () => Response.json({ member: value })));
            await expect(client.addMember(canvasId, { userId: "Target-User", role: "viewer" })).rejects.toMatchObject({ outcome: "unknown" });
        }
        const client = createCanvasSharingClient(scope, mockFetch(async () => Response.json({ share: share({ role: "editor" }), ok: false })));
        await expect(client.createLink(canvasId, { role: "viewer" })).rejects.toMatchObject({ outcome: "unknown" });
        await expect(client.removeMember(canvasId, "Target-User")).rejects.toMatchObject({ outcome: "unknown" });
    });

    test("known rejections use safe text, including a deliberate reset requirement", async () => {
        for (const [status, code] of [[400, "invalid_input"], [404, "not_found"], [409, "share_reset_required"], [429, "rate_limited"]] as const) {
            const client = createCanvasSharingClient(scope, mockFetch(async () => Response.json({ error: { code, message: `secret ${token}` }, token }, { status, headers: { "retry-after": "2" } })));
            let caught: unknown;
            try { await client.createLink(canvasId, { role: "editor" }); } catch (error) { caught = error; }
            expect(caught).toBeInstanceOf(CanvasSharingError);
            expect(caught).toMatchObject({ code, status, outcome: "rejected" });
            expect((caught as Error).message).not.toContain(token);
            expect((caught as Error).message).not.toContain("secret");
            if (status === 429) expect((caught as CanvasSharingError).retryAfter).toBe(2);
        }
    });

    test("network, proxy, malformed and incomplete responses remain unknown without resending", async () => {
        const responses = [
            () => { throw new Error(`request ${token}`); },
            () => new Response("upstream secret", { status: 502, headers: { "content-type": "text/plain" } }),
            () => Response.json({ error: { code: "db_error", message: token } }, { status: 500 }),
            () => Response.json({ error: { code: token, message: token } }, { status: 400 }),
            () => new Response("{", { headers: { "content-type": "application/json" } }),
            () => Response.json({}),
        ];
        for (const respond of responses) {
            let calls = 0;
            const client = createCanvasSharingClient(scope, mockFetch(async () => { calls++; return respond(); }));
            let caught: unknown;
            try { await client.createLink(canvasId, { role: "viewer", reset: true }); } catch (error) { caught = error; }
            expect(caught).toMatchObject({ code: "unavailable", outcome: "unknown" });
            expect((caught as Error).message).not.toContain(token);
            expect(calls).toBe(1);
        }
    });

    test("the deadline aborts both stalled fetches and response bodies without retry", async () => {
        for (const receivedHeaders of [false, true]) {
            let calls = 0, aborted = false;
            const client = createCanvasSharingClient(scope, mockFetch(async (_path, options) => {
                calls++;
                const stalled = () => new Promise<never>((_resolve, reject) => options?.signal?.addEventListener("abort", () => {
                    aborted = true; reject(new DOMException("aborted", "AbortError"));
                }, { once: true }));
                if (!receivedHeaders) return await stalled();
                const response = Response.json({});
                response.json = stalled;
                return response;
            }), { requestTimeoutMs: 5 });
            await expect(client.createLink(canvasId, { role: "viewer" })).rejects.toMatchObject({ code: "unavailable", outcome: "unknown", status: receivedHeaders ? 200 : 0 });
            expect(aborted).toBe(true); expect(calls).toBe(1);
        }
    });

    test("a client cannot adopt another account or a new epoch, even after switching back", async () => {
        for (const replacement of [null, { accountId: "Other-Account", epoch: 1 }, { accountId, epoch: 2 }]) {
            let current: DraftAccountScope | null = scope(), calls = 0;
            const client = createCanvasSharingClient(() => current, mockFetch(async () => { calls++; return Response.json(management()); }));
            current = replacement;
            await expect(client.read(canvasId)).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
            current = scope();
            await expect(client.createLink(canvasId, { role: "viewer" })).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
            expect(calls).toBe(0);
        }
        let current: DraftAccountScope | null = null, calls = 0;
        const client = createCanvasSharingClient(() => current, mockFetch(async () => { calls++; return Response.json(management()); }));
        current = scope();
        await expect(client.read(canvasId)).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
        expect(calls).toBe(0);
    });

    test("late successes and rejections after account changes cannot apply or trigger another request", async () => {
        for (const reject of [false, true]) {
            let current: DraftAccountScope | null = scope(), calls = 0;
            const client = createCanvasSharingClient(() => current, mockFetch(async () => {
                calls++; current = { accountId: "Other-Account", epoch: 2 };
                return reject ? Response.json({ error: { code: "invalid_input" } }, { status: 400 }) : Response.json({ share: share() });
            }));
            await expect(client.createLink(canvasId, { role: "viewer" })).rejects.toMatchObject({ code: "account_changed", outcome: "unknown" });
            current = scope();
            await expect(client.read(canvasId)).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
            expect(calls).toBe(1);
        }
    });

    test("confirmed session/account rejections permanently invalidate the client", async () => {
        for (const [status, code] of [[401, "unauthorized"], [400, "account_context_required"], [409, "account_changed"]] as const) {
            let calls = 0;
            const client = createCanvasSharingClient(scope, mockFetch(async () => { calls++; return Response.json({ error: { code, message: token } }, { status }); }));
            await expect(client.read(canvasId)).rejects.toMatchObject({ code, outcome: "rejected" });
            await expect(client.join(token)).rejects.toMatchObject({ code: "account_changed", outcome: "not-sent" });
            expect(calls).toBe(1);
        }
    });
});
