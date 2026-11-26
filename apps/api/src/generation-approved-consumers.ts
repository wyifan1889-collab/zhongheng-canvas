import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { visit } from "jsonc-parser";
import { z } from "zod";

const text = z.string().refine(value => value.trim().length > 0);
const hash = z.string().regex(/^[0-9a-fA-F]{64}$/);
const absolutePath = text.refine(value => isAbsolute(value) && !/[\u0000-\u001f\u007f]/.test(value));
const capabilities = ["text", "image", "audio", "video"] as const;
const expectedSchema = z.strictObject({
    candidate: z.string().regex(/^[0-9a-fA-F]{40}$/),
    image: z.string().regex(/^sha256:[0-9a-fA-F]{64}$/),
    // The caller supplies the original canonicalPostgresTarget result. Never normalize receipt identity.
    databaseTarget: text,
    queueSchema: z.literal("canvas_jobs"), queueName: z.literal("generation"), payloadVersion: z.literal(1),
    videoProtocol: z.literal("yunfei-grok-video-v1"),
    capabilities: z.array(z.enum(capabilities)).refine(items => items.includes("video") &&
        items.every((item, index) => index === 0 || capabilities.indexOf(items[index - 1]!) < capabilities.indexOf(item))),
    storage: z.discriminatedUnion("provider", [
        z.strictObject({ provider: z.literal("aliyun-oss"), region: text, bucket: text, endpoint: z.string().nullable() }),
        z.strictObject({ provider: z.literal("server-disk"), rootDirectory: absolutePath }),
    ]),
    configPlanSha256: hash, readyReceiptSha256: hash,
});
const receiptSchema = z.strictObject({ schemaVersion: z.literal(1), status: z.literal("approved"), ...expectedSchema.shape,
    approval: z.strictObject({ allConsumersReviewed: z.literal(true), oldConsumersExited: z.literal(true), reference: text }),
});
export type ApprovedConsumerExpected = z.infer<typeof expectedSchema>;
export type ApprovedConsumerCheckOptions = { path: string; sha256: string; expected: ApprovedConsumerExpected };

/** Explicit operator approval evidence only; this grants no claim about live worker health. */
export function createApprovedConsumerCheck(options: ApprovedConsumerCheckOptions): () => Promise<boolean> {
    try {
        const path = absolutePath.parse(options.path), pin = hash.parse(options.sha256).toLowerCase();
        const expected = expectedSchema.parse(options.expected), identity = JSON.stringify(expected);
        return async () => {
            try {
                const bytes = await readFile(path);
                if (createHash("sha256").update(bytes).digest("hex") !== pin) return false;
                const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
                const objects: Set<string>[] = [];
                let invalid = false;
                visit(raw, {
                    onObjectBegin() { objects.push(new Set()); },
                    onObjectProperty(key) {
                        const object = objects.at(-1);
                        if (!object || object.has(key)) invalid = true;
                        else object.add(key);
                    },
                    onObjectEnd() { objects.pop(); },
                    onError() { invalid = true; },
                }, { disallowComments: true, allowTrailingComma: false, allowEmptyContent: false });
                if (invalid) return false;
                const parsed = receiptSchema.safeParse(JSON.parse(raw));
                if (!parsed.success) return false;
                const { schemaVersion: _schemaVersion, status: _status, approval: _approval, ...actual } = parsed.data;
                // Zod emits each strict object in schema order; retain exact values and capability order.
                return JSON.stringify(actual) === identity;
            } catch { return false; }
        };
    } catch { return async () => false; }
}
