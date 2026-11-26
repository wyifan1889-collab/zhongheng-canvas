import { z } from "zod";
export const abuseReportWriteSchema = z.strictObject({ id: z.uuid(), subject: z.string().trim().min(1), details: z.string().trim().min(1) });
export const abuseReportReceiptSchema = z.strictObject({ expectedVersion: z.number().int().min(1).max(2_147_483_647) });
export const abuseReportListSchema = z.strictObject({ cursor: z.string().min(1).optional(), status: z.enum(["submitted", "received"]).optional() });
