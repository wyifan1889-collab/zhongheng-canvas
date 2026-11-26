import { and, desc, eq } from "drizzle-orm";
import { addCreditAmounts, compareCreditAmounts, normalizeCreditAmount, subtractCreditAmounts } from "@infinite-canvas/shared";
import type { Database } from "./client";
import { generationTask, paymentEvent, paymentOrder, wallet, walletLedger, walletReservation } from "./schema";

export type WalletView = {
    unit: "credit";
    availableUnits: string;
    reservedUnits: string;
    totalUnits: string;
    version: number;
    createdAt: string;
    updatedAt: string;
};

export type WalletLedgerView = {
    id: string;
    kind: "grant" | "recharge" | "adjustment" | "reserve" | "capture" | "release" | "refund" | "consume";
    deltaAvailableUnits: string;
    deltaReservedUnits: string;
    availableUnitsAfter: string;
    reservedUnitsAfter: string;
    referenceType: string | null;
    referenceId: string | null;
    createdAt: string;
};

export type WalletReservationStatus = "pending" | "captured" | "released" | "expired";

export type WalletReservationView = {
    id: string;
    requestedUnits: string;
    capturedUnits: string;
    releasedUnits: string;
    status: WalletReservationStatus;
    providerRequestId: string | null;
    taskId: string | null;
    expiresAt: string | null;
    createdAt: string;
    updatedAt: string;
};

export class WalletOperationError extends Error {
    constructor(public readonly code: "invalid_amount" | "invalid_idempotency_key" | "insufficient_balance" | "reservation_not_found" | "reservation_conflict" | "idempotency_conflict" | "reservation_settled" | "version_exhausted" | "payment_not_verified" | "payment_conflict", message: string) {
        super(message);
        this.name = "WalletOperationError";
    }
}

function toWalletView(row: typeof wallet.$inferSelect): WalletView {
    return {
        unit: row.unit,
        availableUnits: amount(row.availableUnits),
        reservedUnits: amount(row.reservedUnits),
        totalUnits: addCreditAmounts(row.availableUnits, row.reservedUnits),
        version: row.version,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function toLedgerView(row: typeof walletLedger.$inferSelect): WalletLedgerView {
    return {
        id: row.id,
        kind: row.kind,
        deltaAvailableUnits: amount(row.deltaAvailableUnits),
        deltaReservedUnits: amount(row.deltaReservedUnits),
        availableUnitsAfter: amount(row.availableUnitsAfter),
        reservedUnitsAfter: amount(row.reservedUnitsAfter),
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        createdAt: row.createdAt.toISOString(),
    };
}

function toReservationView(row: typeof walletReservation.$inferSelect): WalletReservationView {
    return {
        id: row.id,
        requestedUnits: amount(row.requestedUnits),
        capturedUnits: amount(row.capturedUnits),
        releasedUnits: amount(row.releasedUnits),
        status: row.status,
        providerRequestId: row.providerRequestId,
        taskId: row.taskId,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    };
}

function amount(value: unknown): string {
    const normalized = normalizeCreditAmount(value);
    if (normalized === null) throw new WalletOperationError("invalid_amount", "余额操作需要有效的精确积分数量");
    return normalized;
}

function positiveAmount(value: string | number): string {
    const normalized = amount(value);
    if (compareCreditAmounts(normalized, "0") <= 0) throw new WalletOperationError("invalid_amount", "余额操作数量必须大于零");
    return normalized;
}

/** New entries bind the reservation explicitly; historical entries must prove the same identity. */
async function assertSettlementReplay(db: Database, prior: typeof walletLedger.$inferSelect, reservation: typeof walletReservation.$inferSelect,
    input: { referenceType?: string; referenceId?: string }, kind: "capture" | "release", requested?: string) {
    const referenceType = input.referenceType ?? "generation", referenceId = input.referenceId ?? reservation.id;
    const consumed = subtractCreditAmounts("0", prior.deltaReservedUnits);
    if (prior.kind !== kind || prior.referenceType !== referenceType || prior.referenceId !== referenceId ||
        compareCreditAmounts(consumed, "0") <= 0 ||
        (requested !== undefined && compareCreditAmounts(consumed, requested) !== 0) ||
        compareCreditAmounts(prior.deltaAvailableUnits, kind === "capture" ? "0" : consumed) !== 0) {
        throw new WalletOperationError("idempotency_conflict", "幂等键已用于其他结算");
    }
    if (prior.metadata && Object.hasOwn(prior.metadata, "reservationId")) {
        if (prior.metadata.reservationId === reservation.id) return;
    } else {
        if (referenceId === reservation.id) return;
        if (referenceType === "generation" && reservation.taskId === referenceId) {
            const [task] = await db.select({ id: generationTask.id }).from(generationTask).where(and(
                eq(generationTask.id, referenceId), eq(generationTask.ownerId, reservation.userId),
                eq(generationTask.reservationId, reservation.id),
            )).limit(1);
            if (task) return;
        }
    }
    throw new WalletOperationError("idempotency_conflict", "幂等键的余额预留关联无法确认");
}

function assertIdempotencyKey(value: string) {
    if (!value.trim() || value.length > 200) throw new WalletOperationError("invalid_idempotency_key", "余额操作需要有效的幂等键");
}

/**
 * Wallet projection and settlement boundary. All mutations lock the wallet row
 * and append a ledger entry in one transaction. The ledger remains append-only;
 * idempotency keys make retries safe after a provider timeout.
 */
export function createWalletRepository(db: Database) {
    async function ensure(userId: string) {
        await db.insert(wallet).values({ userId }).onConflictDoNothing({ target: wallet.userId });
        const [row] = await db.select().from(wallet).where(eq(wallet.userId, userId));
        if (!row) throw new Error("钱包记录不存在");
        return row;
    }

    return {
        async get(userId: string) {
            return toWalletView(await ensure(userId));
        },
        async listLedger(userId: string, limit = 50) {
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("账本查询数量无效");
            const rows = await db.select().from(walletLedger)
                .where(and(eq(walletLedger.userId, userId)))
                .orderBy(desc(walletLedger.createdAt), desc(walletLedger.id))
                .limit(limit);
            return rows.map(toLedgerView);
        },
        async getReservation(userId: string, reservationId: string) {
            const [row] = await db.select().from(walletReservation)
                .where(and(eq(walletReservation.userId, userId), eq(walletReservation.id, reservationId)));
            return row ? toReservationView(row) : null;
        },
        async getReservationForTask(userId: string, taskId: string) {
            const [row] = await db.select().from(walletReservation)
                .where(and(eq(walletReservation.userId, userId), eq(walletReservation.taskId, taskId)))
                .orderBy(desc(walletReservation.updatedAt), desc(walletReservation.id)).limit(1);
            return row ? toReservationView(row) : null;
        },
        /** Server-only: amounts and owner come exclusively from the immutable original order. */
        async rechargePaymentOrder(orderId: string, proof: { notificationEventId: string; queryEventId: string }) {
            return db.transaction(async (tx) => {
                const [order] = await tx.select().from(paymentOrder).where(eq(paymentOrder.id, orderId)).for("update");
                if (!order || order.refundState !== "none") throw new WalletOperationError("payment_not_verified", "原付款需要核对");
                const [notice] = await tx.select().from(paymentEvent).where(and(eq(paymentEvent.id, proof.notificationEventId), eq(paymentEvent.orderId, order.id)));
                const [query] = await tx.select().from(paymentEvent).where(and(eq(paymentEvent.id, proof.queryEventId), eq(paymentEvent.orderId, order.id)));
                const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
                const n = notice?.evidence, q = query?.evidence;
                const e = record(q) && record(q.evidence) ? q.evidence : null;
                const bound = (value: Record<string, unknown>) => value.provider === "zpay" && value.merchantId === order.merchantId &&
                    value.merchantOrderId === order.merchantOrderId && value.currency === "CNY" && value.amountMinor === order.amountMinor &&
                    value.paymentType === order.paymentType && typeof value.providerTradeNo === "string" && /^[A-Za-z0-9_-]+$/.test(value.providerTradeNo) &&
                    value.orderIdentity === JSON.stringify(["zpay", order.merchantId, order.merchantOrderId]);
                if (!notice || notice.kind !== "notification" || notice.outcome !== "verified_success" || !record(n) || !bound(n) ||
                    n.protocol !== "zpay-epay-md5-doc-03b0f9fb1ff6" || n.kind !== "payment_success_notification" || n.tradeStatus !== "TRADE_SUCCESS" ||
                    n.eventIdentity !== JSON.stringify(["zpay", order.merchantId, n.providerTradeNo, "TRADE_SUCCESS"]) || notice.eventIdentity !== n.eventIdentity ||
                    !query || query.kind !== "query" || query.outcome !== "paid" || !record(q) || q.status !== "paid" || q.jsonMemberUniqueness !== "checked_unique" ||
                    !e || !bound(e) || e.source !== "zpay-order-query-doc-03b0f9fb1ff6" || e.level !== "bound_query_observation" ||
                    e.jsonMemberUniqueness !== "not_checked" || e.providerTradeNo !== n.providerTradeNo ||
                    e.paymentIdentity !== JSON.stringify(["zpay", order.merchantId, n.providerTradeNo]) || !record(e.notification) ||
                    e.notification.kind !== "payment_success_notification" || e.notification.eventIdentity !== n.eventIdentity ||
                    (order.providerTradeNo !== null && order.providerTradeNo !== n.providerTradeNo)) {
                    throw new WalletOperationError("payment_not_verified", "原付款尚未完成验签与查单核对");
                }
                const creditUnits = positiveAmount(order.creditUnits);
                const key = `payment:${order.id}:recharge`;
                if (order.creditState === "credited") {
                    const [prior] = await tx.select().from(walletLedger).where(and(eq(walletLedger.id, order.creditedLedgerId!), eq(walletLedger.userId, order.ownerId)));
                    if (!prior || prior.kind !== "recharge" || prior.idempotencyKey !== key || prior.referenceType !== "payment_order" || prior.referenceId !== order.id ||
                        compareCreditAmounts(prior.deltaAvailableUnits, creditUnits) !== 0 || compareCreditAmounts(prior.deltaReservedUnits, "0") !== 0) {
                        throw new WalletOperationError("payment_conflict", "原充值账本关联不一致");
                    }
                    const [current] = await tx.select().from(wallet).where(eq(wallet.userId, order.ownerId));
                    if (!current) throw new WalletOperationError("payment_conflict", "原充值钱包不存在");
                    return { credited: false, ledgerId: prior.id, wallet: toWalletView(current) };
                }
                // This unique transaction binding covers different users and configuration versions.
                await tx.update(paymentOrder).set({ providerTradeNo: n.providerTradeNo as string, paymentState: "paid" }).where(eq(paymentOrder.id, order.id));
                await tx.insert(wallet).values({ userId: order.ownerId }).onConflictDoNothing({ target: wallet.userId });
                const [current] = await tx.select().from(wallet).where(eq(wallet.userId, order.ownerId)).for("update");
                if (!current) throw new WalletOperationError("payment_conflict", "钱包记录不存在");
                const [prior] = await tx.select().from(walletLedger).where(and(eq(walletLedger.userId, order.ownerId), eq(walletLedger.idempotencyKey, key)));
                if (prior) throw new WalletOperationError("payment_conflict", "充值账本与原订单状态不一致");
                const availableUnits = addCreditAmounts(current.availableUnits, creditUnits);
                addCreditAmounts(availableUnits, current.reservedUnits);
                const version = current.version + 1;
                if (!Number.isSafeInteger(version) || version > 2_147_483_647) throw new WalletOperationError("version_exhausted", "钱包版本已达到上限");
                const now = new Date(), ledgerId = crypto.randomUUID();
                await tx.update(wallet).set({ availableUnits, version, updatedAt: now }).where(eq(wallet.userId, order.ownerId));
                await tx.insert(walletLedger).values({
                    id: ledgerId, userId: order.ownerId, kind: "recharge", deltaAvailableUnits: creditUnits, deltaReservedUnits: "0",
                    availableUnitsAfter: availableUnits, reservedUnitsAfter: current.reservedUnits, idempotencyKey: key,
                    referenceType: "payment_order", referenceId: order.id,
                    metadata: { notificationEventId: notice.id, queryEventId: query.id },
                });
                await tx.update(paymentOrder).set({ creditState: "credited", creditedLedgerId: ledgerId, creditedAt: now, lastReason: null, updatedAt: now }).where(eq(paymentOrder.id, order.id));
                return { credited: true, ledgerId, wallet: toWalletView({ ...current, availableUnits, version, updatedAt: now }) };
            });
        },
        /** Reserve credits before calling a provider. The same key returns the original reservation. */
        async reserve(input: {
            userId: string;
            requestedUnits: string | number;
            idempotencyKey: string;
            providerRequestId?: string;
            taskId?: string;
            expiresAt?: Date;
            referenceType?: string;
            referenceId?: string;
        }): Promise<WalletReservationView> {
            const requestedUnits = positiveAmount(input.requestedUnits);
            assertIdempotencyKey(input.idempotencyKey);
            return db.transaction(async (tx) => {
                await tx.insert(wallet).values({ userId: input.userId }).onConflictDoNothing({ target: wallet.userId });
                const [current] = await tx.select().from(wallet).where(eq(wallet.userId, input.userId)).for("update");
                if (!current) throw new WalletOperationError("reservation_not_found", "钱包记录不存在");
                const [existing] = await tx.select().from(walletReservation)
                    .where(and(eq(walletReservation.userId, input.userId), eq(walletReservation.idempotencyKey, input.idempotencyKey)))
                    .for("update");
                if (existing) {
                    if (compareCreditAmounts(existing.requestedUnits, requestedUnits) !== 0 ||
                        (input.taskId !== undefined && existing.taskId !== input.taskId) ||
                        (input.providerRequestId !== undefined && existing.providerRequestId !== input.providerRequestId)) {
                        throw new WalletOperationError("idempotency_conflict", "幂等键已用于其他预留");
                    }
                    return toReservationView(existing);
                }
                if (compareCreditAmounts(current.availableUnits, requestedUnits) < 0) throw new WalletOperationError("insufficient_balance", "余额不足");
                const nextVersion = current.version + 1;
                if (!Number.isSafeInteger(nextVersion)) throw new WalletOperationError("version_exhausted", "钱包版本已达到上限");
                const now = new Date();
                const availableUnits = subtractCreditAmounts(current.availableUnits, requestedUnits);
                const reservedUnits = addCreditAmounts(current.reservedUnits, requestedUnits);
                const reservationId = crypto.randomUUID();
                await tx.update(wallet).set({ availableUnits, reservedUnits, version: nextVersion, updatedAt: now }).where(eq(wallet.userId, input.userId));
                const [reservation] = await tx.insert(walletReservation).values({
                    id: reservationId, userId: input.userId, requestedUnits,
                    idempotencyKey: input.idempotencyKey, providerRequestId: input.providerRequestId,
                    taskId: input.taskId, expiresAt: input.expiresAt,
                }).returning();
                if (!reservation) throw new WalletOperationError("reservation_not_found", "余额预留写入失败");
                await tx.insert(walletLedger).values({
                    id: crypto.randomUUID(), userId: input.userId, kind: "reserve",
                    deltaAvailableUnits: subtractCreditAmounts("0", requestedUnits), deltaReservedUnits: requestedUnits,
                    availableUnitsAfter: availableUnits, reservedUnitsAfter: reservedUnits,
                    idempotencyKey: `reserve:${input.idempotencyKey}`,
                    referenceType: input.referenceType ?? "generation", referenceId: input.referenceId ?? reservationId,
                });
                return toReservationView(reservation);
            });
        },
        /** Capture actual usage from a pending reservation. A partial capture stays pending until released. */
        async capture(input: { userId: string; reservationId: string; capturedUnits: string | number; idempotencyKey: string; referenceType?: string; referenceId?: string }): Promise<WalletReservationView> {
            const requestedCapture = positiveAmount(input.capturedUnits);
            assertIdempotencyKey(input.idempotencyKey);
            return db.transaction(async (tx) => {
                const [currentWallet] = await tx.select().from(wallet).where(eq(wallet.userId, input.userId)).for("update");
                if (!currentWallet) throw new WalletOperationError("reservation_not_found", "钱包记录不存在");
                const [priorLedger] = await tx.select().from(walletLedger)
                    .where(and(eq(walletLedger.userId, input.userId), eq(walletLedger.idempotencyKey, `capture:${input.idempotencyKey}`))).limit(1);
                const [reservation] = await tx.select().from(walletReservation)
                    .where(and(eq(walletReservation.id, input.reservationId), eq(walletReservation.userId, input.userId))).for("update");
                if (!reservation) throw new WalletOperationError("reservation_not_found", "余额预留不存在");
                if (priorLedger) {
                    await assertSettlementReplay(tx, priorLedger, reservation, input, "capture", requestedCapture);
                    return toReservationView(reservation);
                }
                if (reservation.status !== "pending") throw new WalletOperationError("reservation_settled", "余额预留已结算");
                const remaining = subtractCreditAmounts(subtractCreditAmounts(reservation.requestedUnits, reservation.capturedUnits), reservation.releasedUnits);
                if (compareCreditAmounts(requestedCapture, remaining) > 0) throw new WalletOperationError("reservation_conflict", "扣费数量超过余额预留");
                const reservedUnits = subtractCreditAmounts(currentWallet.reservedUnits, requestedCapture);
                if (compareCreditAmounts(reservedUnits, "0") < 0) throw new WalletOperationError("reservation_conflict", "钱包冻结余额不一致");
                const nextVersion = currentWallet.version + 1;
                if (!Number.isSafeInteger(nextVersion)) throw new WalletOperationError("version_exhausted", "钱包版本已达到上限");
                const capturedUnits = addCreditAmounts(reservation.capturedUnits, requestedCapture);
                const status = compareCreditAmounts(addCreditAmounts(capturedUnits, reservation.releasedUnits), reservation.requestedUnits) === 0 ? "captured" : "pending";
                const now = new Date();
                await tx.update(wallet).set({ reservedUnits, version: nextVersion, updatedAt: now }).where(eq(wallet.userId, input.userId));
                const [updated] = await tx.update(walletReservation).set({ capturedUnits, status, updatedAt: now }).where(eq(walletReservation.id, reservation.id)).returning();
                if (!updated) throw new WalletOperationError("reservation_not_found", "余额预留更新失败");
                await tx.insert(walletLedger).values({
                    id: crypto.randomUUID(), userId: input.userId, kind: "capture", deltaAvailableUnits: "0",
                    deltaReservedUnits: subtractCreditAmounts("0", requestedCapture), availableUnitsAfter: currentWallet.availableUnits,
                    reservedUnitsAfter: reservedUnits, idempotencyKey: `capture:${input.idempotencyKey}`,
                    referenceType: input.referenceType ?? "generation", referenceId: input.referenceId ?? reservation.id,
                    metadata: { reservationId: reservation.id },
                });
                return toReservationView(updated);
            });
        },
        /** Release unused credits from a pending reservation. Releasing after capture settles the remainder. */
        async release(input: { userId: string; reservationId: string; releasedUnits?: string | number; idempotencyKey: string; referenceType?: string; referenceId?: string }): Promise<WalletReservationView> {
            const requestedRelease = input.releasedUnits === undefined ? undefined : positiveAmount(input.releasedUnits);
            assertIdempotencyKey(input.idempotencyKey);
            return db.transaction(async (tx) => {
                const [currentWallet] = await tx.select().from(wallet).where(eq(wallet.userId, input.userId)).for("update");
                if (!currentWallet) throw new WalletOperationError("reservation_not_found", "钱包记录不存在");
                const [reservation] = await tx.select().from(walletReservation)
                    .where(and(eq(walletReservation.id, input.reservationId), eq(walletReservation.userId, input.userId))).for("update");
                if (!reservation) throw new WalletOperationError("reservation_not_found", "余额预留不存在");
                const [priorLedger] = await tx.select().from(walletLedger)
                    .where(and(eq(walletLedger.userId, input.userId), eq(walletLedger.idempotencyKey, `release:${input.idempotencyKey}`))).limit(1);
                if (priorLedger) {
                    await assertSettlementReplay(tx, priorLedger, reservation, input, "release", requestedRelease);
                    return toReservationView(reservation);
                }
                if (reservation.status !== "pending") throw new WalletOperationError("reservation_settled", "余额预留已结算");
                const remaining = subtractCreditAmounts(subtractCreditAmounts(reservation.requestedUnits, reservation.capturedUnits), reservation.releasedUnits);
                const releasedUnits = requestedRelease ?? positiveAmount(remaining);
                if (compareCreditAmounts(releasedUnits, remaining) > 0) throw new WalletOperationError("reservation_conflict", "释放数量超过余额预留");
                const reservedUnits = subtractCreditAmounts(currentWallet.reservedUnits, releasedUnits);
                if (compareCreditAmounts(reservedUnits, "0") < 0) throw new WalletOperationError("reservation_conflict", "钱包冻结余额不一致");
                const nextVersion = currentWallet.version + 1;
                if (!Number.isSafeInteger(nextVersion)) throw new WalletOperationError("version_exhausted", "钱包版本已达到上限");
                const nextReleased = addCreditAmounts(reservation.releasedUnits, releasedUnits);
                const status = compareCreditAmounts(addCreditAmounts(reservation.capturedUnits, nextReleased), reservation.requestedUnits) === 0
                    ? (compareCreditAmounts(reservation.capturedUnits, "0") > 0 ? "captured" : "released") : "pending";
                const now = new Date();
                const availableUnits = addCreditAmounts(currentWallet.availableUnits, releasedUnits);
                await tx.update(wallet).set({ availableUnits, reservedUnits, version: nextVersion, updatedAt: now }).where(eq(wallet.userId, input.userId));
                const [updated] = await tx.update(walletReservation).set({ releasedUnits: nextReleased, status, updatedAt: now }).where(eq(walletReservation.id, reservation.id)).returning();
                if (!updated) throw new WalletOperationError("reservation_not_found", "余额预留更新失败");
                await tx.insert(walletLedger).values({
                    id: crypto.randomUUID(), userId: input.userId, kind: "release", deltaAvailableUnits: releasedUnits,
                    deltaReservedUnits: subtractCreditAmounts("0", releasedUnits), availableUnitsAfter: availableUnits, reservedUnitsAfter: reservedUnits,
                    idempotencyKey: `release:${input.idempotencyKey}`, referenceType: input.referenceType ?? "generation", referenceId: input.referenceId ?? reservation.id,
                    metadata: { reservationId: reservation.id },
                });
                return toReservationView(updated);
            });
        },
    };
}
