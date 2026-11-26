import { describe, expect, test } from "bun:test";
import { verifyCanvasCloudMediaOwnership } from "./cloud-media-ownership";

const reference = (cloudMediaId: string) => [{ kind: "cloud-media" as const, path: "/nodes/0/metadata/cloudMediaId", cloudMediaId }];
const id = "11111111-1111-4111-8111-111111111111";

describe("cloud media ownership gate", () => {
    test("does not call the resolver when a document has no cloud media references", async () => {
        let calls = 0;
        await verifyCanvasCloudMediaOwnership([], { resolve: async () => { calls++; return { items: [], missing: [] }; } });
        expect(calls).toBe(0);
    });

    test("accepts owned IDs and deduplicates repeated references", async () => {
        let received: string[] = [];
        await verifyCanvasCloudMediaOwnership([...reference(id), ...reference(id.toUpperCase())], { resolve: async (ids) => {
            received = ids;
            return { items: [{ id }], missing: [] };
        } });
        expect(received).toEqual([id]);
    });

    test("rejects missing or foreign IDs before a save can proceed", async () => {
        await expect(verifyCanvasCloudMediaOwnership(reference(id), { resolve: async () => ({ items: [], missing: [id] }) })).rejects.toThrow();
    });

    test("rejects malformed resolver responses and invalid reference shapes", async () => {
        await expect(verifyCanvasCloudMediaOwnership(reference(id), { resolve: async () => ({ items: [{ id: "foreign" }], missing: [] }) })).rejects.toThrow();
        await expect(verifyCanvasCloudMediaOwnership(reference("not-a-uuid"), { resolve: async () => ({ items: [], missing: [] }) })).rejects.toThrow();
    });
});
