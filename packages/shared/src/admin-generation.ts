import type { TextUsageEvidence } from "./text-usage";
import type { TaskPriceSnapshot } from "./task-price-snapshot";

/** Read-only administrative snapshot; amounts retain their stored units.
 * Reasons contain only known server codes or `unrecognized_reason`, never raw provider text.
 */
export type AdminGenerationTaskDetail = {
    observedAt: string;
    priceSnapshot: TaskPriceSnapshot;
    task: {
        id: string;
        ownerId: string;
        projectId: string | null;
        nodeId: string | null;
        modelId: string;
        priceVersion: number | null;
        quotedUnits: number | null;
        billingUnitSnapshot: "request" | "input_token" | "output_token" | "second" | "megapixel" | "image" | null;
        creditsPerUnitSnapshot: number | null;
        executionStatus: "pending" | "queued" | "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "timeout";
        deliveryStatus: "pending" | "saved" | "visible" | "failed" | "unknown";
        billingStatus: "unbilled" | "reserved" | "captured" | "released" | "pending_review";
        unknownReason: string | null;
        createdAt: string;
        updatedAt: string;
        finishedAt: string | null;
    };
    result: {
        status: "succeeded" | "failed" | "unknown";
        consumedUnits: number | null;
        textUsage: TextUsageEvidence | null;
        errorCode: string | null;
        unknownReason: string | null;
        createdAt: string;
        updatedAt: string;
    } | null;
    reservation: {
        linkStatus: "linked" | "none" | "missing" | "mismatch";
        details: {
            id: string;
            status: "pending" | "captured" | "released" | "expired";
            requestedUnits: string;
            capturedUnits: string;
            releasedUnits: string;
            remainingUnits: string;
            createdAt: string;
            updatedAt: string;
        } | null;
    };
    ledger: Array<{
        id: string;
        kind: "grant" | "recharge" | "adjustment" | "reserve" | "capture" | "release" | "refund" | "consume";
        deltaAvailableUnits: string;
        deltaReservedUnits: string;
        createdAt: string;
    }>;
};
