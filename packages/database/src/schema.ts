import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, numeric, pgSchema, primaryKey, text, timestamp, uniqueIndex, uuid, varchar } from "drizzle-orm/pg-core";
import type { JsonObject, ModelPriceRules, OfficialPriceEntry, OfficialPriceSourceId, PricingCapability, TextQuoteSnapshot } from "@infinite-canvas/shared";
import type { VideoParameters, VideoPhase, VideoQuoteSnapshot } from "../../shared/src/generation-video";
import { emptyMappingDraft, type MappingDraft } from "../../shared/src/model-mapping-drafts";

// Keep SaaS data in its own namespace; never target the Sub2API database.
export const saas = pgSchema("canvas_saas");
const timestamps = () => ({
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const user = saas.table("user", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").default(false).notNull(),
    image: text("image"),
    role: text("role").$type<"user" | "admin">().default("user").notNull(),
    disabled: boolean("disabled").default(false).notNull(),
    moderationVersion: integer("moderation_version").default(0).notNull(),
    ...timestamps(),
}, (table) => [
    check("user_role", sql`${table.role} IN ('user', 'admin')`),
    check("user_moderation_version", sql`${table.moderationVersion} >= 0`),
    // Email identifiers are normalized by the HTTP boundary, but this
    // database constraint is the final cross-process guard.  Keep the
    // expression aligned with the migration's legacy-row normalization.
    uniqueIndex("user_email_lower_unique").on(sql`lower(btrim(${table.email}))`),
]);

export const session = saas.table("session", {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    moderationVersion: integer("moderation_version").default(0).notNull(),
    ...timestamps(),
}, (table) => [
    index("session_user").on(table.userId),
    check("session_moderation_version", sql`${table.moderationVersion} >= 0`),
]);

export const account = saas.table("account", {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps(),
}, (table) => [
    index("account_user").on(table.userId),
    uniqueIndex("account_provider_identity").on(table.providerId, table.accountId),
]);

export const verification = saas.table("verification", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps(),
}, (table) => [index("verification_identifier").on(table.identifier)]);

export const canvasDraft = saas.table("canvas_draft", {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => user.id),
    title: text("title").notNull(),
    revision: integer("revision").default(1).notNull(),
    documentVersion: integer("document_version").$type<1>().default(1).notNull(),
    document: jsonb("document").$type<JsonObject>().notNull(),
    ...timestamps(),
}, (table) => [
    index("canvas_draft_owner").on(table.ownerId),
    index("canvas_draft_owner_created").on(table.ownerId, table.createdAt),
    index("canvas_draft_document_gin").using("gin", table.document),
    check("canvas_draft_revision", sql`${table.revision} > 0`),
    check("canvas_draft_version", sql`${table.documentVersion} = 1`),
    check("canvas_draft_object", sql`jsonb_typeof(${table.document}) = 'object'`),
]);

export type CanvasRole = "owner" | "editor" | "viewer";
export type CanvasShareRole = "editor" | "viewer";

/** One transferable invitation link. A token never grants document access before join. */
export const canvasShares = saas.table("canvas_shares", {
    id: uuid("id").primaryKey(),
    canvasId: text("canvas_id").notNull().references(() => canvasDraft.id, { onDelete: "cascade" }),
    token: uuid("token").notNull(),
    role: text("role").$type<CanvasShareRole>().notNull(),
    createdBy: text("created_by").notNull().references(() => user.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex("canvas_shares_canvas_unique").on(table.canvasId),
    uniqueIndex("canvas_shares_token_unique").on(table.token),
    check("canvas_shares_role", sql`${table.role} IN ('viewer', 'editor')`),
]);

/** NULL joinedAt is pending. The owner mirror is created/protected by migration triggers. */
export const canvasMembers = saas.table("canvas_members", {
    canvasId: text("canvas_id").notNull().references(() => canvasDraft.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    role: text("role").$type<CanvasRole>().notNull(),
    invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
}, (table) => [
    primaryKey({ name: "canvas_members_pk", columns: [table.canvasId, table.userId] }),
    index("canvas_members_user").on(table.userId),
    uniqueIndex("canvas_members_one_owner").on(table.canvasId).where(sql`${table.role} = 'owner'`),
    check("canvas_members_role", sql`${table.role} IN ('viewer', 'editor', 'owner')`),
    check("canvas_members_owner_active", sql`${table.role} <> 'owner' OR ${table.joinedAt} IS NOT NULL`),
]);

export const storageQuota = saas.table("storage_quota", {
    userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
    quotaBytes: bigint("quota_bytes", { mode: "number" }).notNull(),
    usedBytes: bigint("used_bytes", { mode: "number" }).default(0).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    check("storage_quota_nonnegative", sql`${table.quotaBytes} >= 0 AND ${table.usedBytes} >= 0`),
    check("storage_quota_used_within_quota", sql`${table.usedBytes} <= ${table.quotaBytes}`),
]);

export const mediaObject = saas.table("media_object", {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    objectKey: text("object_key").notNull().unique(),
    kind: text("kind").$type<"image" | "video" | "audio">().notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    etag: text("etag").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    index("media_object_owner_created").on(table.ownerId, table.createdAt),
    check("media_object_size_positive", sql`${table.sizeBytes} > 0`),
    check("media_object_kind", sql`${table.kind} IN ('image', 'video', 'audio')`),
]);

/**
 * Server-side provider registry. `secretRef` is only the name of a secret
 * managed by the runtime (for example an environment/secret-manager key); it
 * is deliberately never a provider credential or token.
 */
export const modelProvider = saas.table("model_provider", {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    adapter: text("adapter").$type<"openai-compatible" | "sub2api">().notNull(),
    endpoint: text("endpoint").notNull(),
    secretRef: text("secret_ref").notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    revision: integer("revision").default(1).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps(),
}, (table) => [
    check("model_provider_adapter", sql`${table.adapter} IN ('openai-compatible', 'sub2api')`),
    check("model_provider_secret_ref", sql`length(trim(${table.secretRef})) > 0`),
    check("model_provider_revision", sql`${table.revision} > 0`),
    check("model_provider_deleted_disabled", sql`${table.deletedAt} IS NULL OR NOT ${table.enabled}`),
]);

/** Successful read evidence is private, session-bound and consumed with the channel write. */
export const providerDiscoveryReceipt = saas.table("provider_discovery_receipt", {
    id: text("id").primaryKey(),
    actorId: text("actor_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    sessionId: text("session_id").notNull().references(() => session.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(), // New channels do not exist yet.
    revision: integer("revision").notNull(),
    targetFingerprint: text("target_fingerprint").notNull(),
    models: jsonb("models").$type<string[]>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    index("provider_discovery_receipt_session").on(table.sessionId),
    check("provider_discovery_receipt_revision", sql`${table.revision} >= 0`),
    check("provider_discovery_receipt_models", sql`jsonb_typeof(${table.models}) = 'array'`),
]);

/** Administrative inventory only; discovery never creates a public/selectable model. */
export const providerDiscoveredModel = saas.table("provider_discovered_model", {
    providerId: text("provider_id").notNull().references(() => modelProvider.id, { onDelete: "restrict" }),
    providerModel: text("provider_model").notNull(),
    available: boolean("available").default(true).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex("provider_discovered_model_unique").on(table.providerId, table.providerModel),
    check("provider_discovered_model_id", sql`length(btrim(${table.providerModel})) BETWEEN 1 AND 200`),
]);

/**
 * Encrypted provider credential material. The API never returns these fields;
 * the runtime decrypts them only at the provider gateway boundary. `secretRef`
 * on model_provider remains a stable non-secret label for backwards-safe
 * configuration projections.
 */
export const modelProviderCredential = saas.table("model_provider_credential", {
    providerId: text("provider_id").primaryKey().references(() => modelProvider.id, { onDelete: "cascade" }),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    authTag: text("auth_tag").notNull(),
    keyVersion: integer("key_version").default(1).notNull(),
    ...timestamps(),
}, (table) => [
    check("model_provider_credential_ciphertext", sql`length(${table.ciphertext}) > 0`),
    check("model_provider_credential_nonce", sql`length(${table.nonce}) = 24`),
    check("model_provider_credential_auth_tag", sql`length(${table.authTag}) = 32`),
    check("model_provider_credential_key_version", sql`${table.keyVersion} = 1`),
]);

/** Public model catalogue entries map a safe public id to a provider model id. */
export const modelNodeGroups = saas.table("model_node_groups", {
    capability: text("capability").$type<PricingCapability>().primaryKey(),
    version: integer("version").default(0).notNull(),
    groups: jsonb("groups").$type<{ id: string; name: string }[]>().default([]).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    check("model_node_groups_capability", sql`${table.capability} IN ('text', 'image', 'video', 'audio')`),
    check("model_node_groups_version", sql`${table.version} >= 0`),
    check("model_node_groups_array", sql`jsonb_typeof(${table.groups}) = 'array'`),
]);

/** Versioned administrative draft, separate from executable models and published prices. */
export const modelMappingDraft = saas.table("model_mapping_draft", {
    id: text("id").primaryKey(),
    version: integer("version").default(0).notNull(),
    document: jsonb("document").$type<MappingDraft>().default(emptyMappingDraft()).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
    check("model_mapping_draft_id", sql`${table.id} = 'catalog'`),
    check("model_mapping_draft_version", sql`${table.version} >= 0`),
    check("model_mapping_draft_object", sql`jsonb_typeof(${table.document}) = 'object'`),
]);

/** Immutable alias/specification release; route prices use the existing immutable price publications. */
export const modelMappingPublication = saas.table("model_mapping_publication", {
    id: text("id").primaryKey(),
    version: integer("version").notNull(),
    draftVersion: integer("draft_version").notNull(),
    fingerprint: text("fingerprint").notNull(),
    document: jsonb("document").$type<import("@infinite-canvas/shared").MappingPublicationDocument>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [uniqueIndex("model_mapping_publication_version").on(table.version),
    check("model_mapping_publication_positive_version", sql`${table.version} > 0 AND ${table.draftVersion} >= 0`),
    check("model_mapping_publication_fingerprint", sql`${table.fingerprint} ~ '^[a-f0-9]{64}$'`),
    check("model_mapping_publication_document", sql`jsonb_typeof(${table.document}) = 'object'`)]);

export const modelCatalog = saas.table("model_catalog", {
    id: text("id").primaryKey(),
    providerId: text("provider_id").notNull().references(() => modelProvider.id, { onDelete: "restrict" }),
    publicId: text("public_id").notNull(),
    providerModel: text("provider_model").notNull(),
    displayName: text("display_name").notNull(),
    capability: text("capability").$type<"text" | "image" | "video" | "audio">().notNull(),
    groupId: text("group_id"),
    revision: integer("revision").default(1).notNull(),
    enabled: boolean("enabled").default(false).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps(),
}, (table) => [
    uniqueIndex("model_catalog_public_id_unique").on(table.publicId),
    uniqueIndex("model_catalog_provider_model_unique").on(table.providerId, table.providerModel).where(sql`${table.deletedAt} IS NULL`),
    index("model_catalog_enabled_capability").on(table.enabled, table.capability),
    check("model_catalog_capability", sql`${table.capability} IN ('text', 'image', 'video', 'audio')`),
    check("model_catalog_revision", sql`${table.revision} > 0`),
    check("model_catalog_deleted_disabled", sql`${table.deletedAt} IS NULL OR NOT ${table.enabled}`),
    check("model_catalog_public_id", sql`length(trim(${table.publicId})) > 0`),
    check("model_catalog_provider_model", sql`length(trim(${table.providerModel})) > 0`),
]);

export type ScalarBillingUnit = "request" | "input_token" | "output_token" | "second" | "megapixel";
export type TaskBillingUnit = ScalarBillingUnit | "image";
export type BillingUnit = ScalarBillingUnit | "text_tokens" | "image_specs" | "video_specs";

/**
 * Versioned pricing. Structured text/image prices come from an immutable publication instead of a global scalar.
 * A row is immutable once used by a charge;
 * a new version must be inserted for any future price change. Generation tasks
 * copy the billing fields into an immutable snapshot before reservation.
 */
export const modelPricing = saas.table("model_pricing", {
    id: text("id").primaryKey(),
    modelId: text("model_id").notNull().references(() => modelCatalog.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    billingUnit: text("billing_unit").$type<BillingUnit>().notNull(),
    creditsPerUnit: bigint("credits_per_unit", { mode: "number" }),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    enabled: boolean("enabled").default(false).notNull(),
    ...timestamps(),
}, (table) => [
    uniqueIndex("model_pricing_model_version_unique").on(table.modelId, table.version),
    index("model_pricing_active_lookup").on(table.modelId, table.enabled, table.effectiveFrom),
    check("model_pricing_version", sql`${table.version} > 0`),
    check("model_pricing_billing_unit", sql`${table.billingUnit} IN ('request', 'input_token', 'output_token', 'second', 'megapixel', 'text_tokens', 'image_specs', 'video_specs')`),
    check("model_pricing_credits_positive", sql`(${table.billingUnit} IN ('text_tokens', 'image_specs', 'video_specs') AND ${table.creditsPerUnit} IS NULL) OR (${table.billingUnit} NOT IN ('text_tokens', 'image_specs', 'video_specs') AND ${table.creditsPerUnit} IS NOT NULL AND ${table.creditsPerUnit} > 0)`),
    check("model_pricing_effective_range", sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`),
]);

/** Administrator-only CNY drafts. Never consulted by credit quotes, wallets or workers. */
export const cnyPriceDraft = saas.table("cny_price_draft", {
    id: text("id").primaryKey(),
    modelId: text("model_id").notNull().references(() => modelCatalog.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    currency: text("currency").$type<"CNY">().default("CNY").notNull(),
    billingUnit: text("billing_unit").$type<"request">().default("request").notNull(),
    costAmount: numeric("cost_amount"),
    saleAmount: numeric("sale_amount").notNull(),
    priceNote: text("price_note").notNull(),
    providerIdSnapshot: text("provider_id_snapshot").notNull(),
    providerModelSnapshot: text("provider_model_snapshot").notNull(),
    adapterSnapshot: text("adapter_snapshot").$type<"openai-compatible" | "sub2api">().notNull(),
    endpointSnapshot: text("endpoint_snapshot").notNull(),
    capabilitySnapshot: text("capability_snapshot").$type<"image">().default("image").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex("cny_price_draft_model_version_unique").on(table.modelId, table.version),
    check("cny_price_draft_version", sql`${table.version} > 0`),
    check("cny_price_draft_currency", sql`${table.currency} = 'CNY'`),
    check("cny_price_draft_billing_unit", sql`${table.billingUnit} = 'request'`),
    check("cny_price_draft_cost_amount", sql`${table.costAmount} IS NULL OR (${table.costAmount} >= 0 AND ${table.costAmount}::text NOT IN ('NaN', 'Infinity', '-Infinity'))`),
    check("cny_price_draft_sale_amount", sql`${table.saleAmount} >= 0 AND ${table.saleAmount}::text NOT IN ('NaN', 'Infinity', '-Infinity')`),
    check("cny_price_draft_adapter", sql`${table.adapterSnapshot} IN ('openai-compatible', 'sub2api')`),
    check("cny_price_draft_capability", sql`${table.capabilitySnapshot} = 'image'`),
]);

/** Complete administrator-only rules; execution requires a separate immutable publication. */
export const modelPriceDraft = saas.table("model_price_draft", {
    id: text("id").primaryKey(),
    modelId: text("model_id").notNull().references(() => modelCatalog.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    rules: jsonb("rules").$type<ModelPriceRules>().notNull(),
    priceNote: text("price_note").notNull(),
    providerIdSnapshot: text("provider_id_snapshot").notNull(),
    providerModelSnapshot: text("provider_model_snapshot").notNull(),
    adapterSnapshot: text("adapter_snapshot").$type<"openai-compatible" | "sub2api">().notNull(),
    endpointSnapshot: text("endpoint_snapshot").notNull(),
    capabilitySnapshot: text("capability_snapshot").$type<"text" | "image" | "video" | "audio">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex("model_price_draft_model_version_unique").on(table.modelId, table.version),
    check("model_price_draft_version", sql`${table.version} > 0`),
    check("model_price_draft_rules", sql`jsonb_typeof(${table.rules}) = 'object'`),
    check("model_price_draft_adapter", sql`${table.adapterSnapshot} IN ('openai-compatible', 'sub2api')`),
    check("model_price_draft_capability", sql`${table.capabilitySnapshot} IN ('text', 'image', 'video', 'audio')`),
]);

/** The referenced draft preserves private cost/rule/binding snapshots without copying secrets. */
export const modelPricePublication = saas.table("model_price_publication", {
    id: text("id").primaryKey(),
    pricingId: text("pricing_id").notNull().references(() => modelPricing.id, { onDelete: "restrict" }),
    draftId: text("draft_id").notNull().references(() => modelPriceDraft.id, { onDelete: "restrict" }),
    publicPriceNote: text("public_price_note").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex("model_price_publication_pricing_unique").on(table.pricingId),
    uniqueIndex("model_price_publication_draft_unique").on(table.draftId),
]);

/** Independent supplier list-price cache. Never read by executable pricing or billing. */
export const officialPriceSource = saas.table("official_price_source", {
    id: text("id").$type<OfficialPriceSourceId>().primaryKey(),
    version: integer("version").default(0).notNull(),
    entries: jsonb("entries").$type<OfficialPriceEntry[]>().default([]).notNull(),
    digest: text("digest"),
    previousEntries: jsonb("previous_entries").$type<OfficialPriceEntry[]>().default([]).notNull(),
    previousDigest: text("previous_digest"),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }),
    changedAt: timestamp("changed_at", { withTimezone: true }),
    status: text("status").$type<"ready" | "stale" | "unavailable">().default("unavailable").notNull(),
    changedEntryIds: jsonb("changed_entry_ids").$type<string[]>().default([]).notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
}, (table) => [
    check("official_price_source_id", sql`${table.id} IN ('openai','anthropic')`),
    check("official_price_source_version", sql`${table.version} >= 0`),
    check("official_price_source_status", sql`${table.status} IN ('ready','stale','unavailable')`),
    check("official_price_source_arrays", sql`jsonb_typeof(${table.entries}) = 'array' AND jsonb_typeof(${table.previousEntries}) = 'array' AND jsonb_typeof(${table.changedEntryIds}) = 'array'`),
    check("official_price_source_lease", sql`(${table.leaseToken} IS NULL) = (${table.leaseExpiresAt} IS NULL)`),
]);

export const officialPriceMapping = saas.table("official_price_mapping", {
    modelId: text("model_id").primaryKey().references(() => modelCatalog.publicId, { onDelete: "restrict" }),
    referenceId: text("reference_id"),
    version: integer("version").notNull(),
    providerIdSnapshot: text("provider_id_snapshot").notNull(),
    providerModelSnapshot: text("provider_model_snapshot").notNull(),
    adapterSnapshot: text("adapter_snapshot").$type<"openai-compatible" | "sub2api">().notNull(),
    endpointSnapshot: text("endpoint_snapshot").notNull(),
    capabilitySnapshot: text("capability_snapshot").$type<"text">().notNull(),
    ...timestamps(),
}, (table) => [
    check("official_price_mapping_version", sql`${table.version} > 0`),
    check("official_price_mapping_reference", sql`${table.referenceId} IS NULL OR ${table.referenceId} ~ '^(openai|anthropic):.+'`),
    check("official_price_mapping_adapter", sql`${table.adapterSnapshot} IN ('openai-compatible','sub2api')`),
    check("official_price_mapping_capability", sql`${table.capabilitySnapshot} = 'text'`),
]);

// Matches rate-limiter-flexible's PostgreSQL layout; created only by explicit migrations.
export const rateLimit = saas.table("rate_limit", {
    key: varchar("key", { length: 255 }).primaryKey(),
    points: integer("points").default(0).notNull(),
    expire: bigint("expire", { mode: "number" }),
}, (table) => [index("rate_limit_expire").on(table.expire)]);

// No document, email, IP, cookie, token or provider secret in this record.
export const auditEvent = saas.table("audit_event", {
    id: text("id").primaryKey(),
    actorId: text("actor_id").notNull(),
    action: text("action").$type<"canvas.created" | "canvas.saved" | "canvas.share.created" | "canvas.share.reset" | "canvas.member.updated" | "canvas.member.removed" | "canvas.member.joined" | "provider.saved" | "model.saved" | "model.pricing.created" | "model.cny-price-draft.created" | "model.price-draft.created" | "model.price.published" | "model.official-price-mapping.saved" | "user.balance.adjusted" | "user.disabled" | "user.enabled" | "abuse.report.submitted" | "abuse.report.received" | "payment.merchant.saved" | "payment.offers.saved" | "payment.reconciled" | "generation.rates.published">().notNull(),
    resourceId: text("resource_id").notNull(),
    revision: integer("revision").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [index("audit_actor_created").on(table.actorId, table.createdAt)]);

/** Immutable moderation receipts; the migration owner adds the mutation-rejection trigger. */
export const accountModerationOperation = saas.table("account_moderation_operation", {
    id: uuid("id").primaryKey(),
    targetUserId: text("target_user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    actorId: text("actor_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    disabled: boolean("disabled").notNull(),
    expectedVersion: integer("expected_version").notNull(),
    revision: integer("revision").notNull(),
    reason: text("reason").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    check("account_moderation_operation_versions", sql`${table.expectedVersion} >= 0 AND ${table.revision} >= 0`),
]);

export const abuseReport = saas.table("abuse_report", {
    id: uuid("id").primaryKey(),
    reporterId: text("reporter_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    subject: text("subject").notNull(),
    details: text("details").notNull(),
    status: text("status").$type<"submitted" | "received">().default("submitted").notNull(),
    revision: integer("revision").default(1).notNull(),
    receivedBy: text("received_by"),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    ...timestamps(),
}, (table) => [
    index("abuse_report_reporter_created").on(table.reporterId, table.createdAt, table.id),
    index("abuse_report_status_created").on(table.status, table.createdAt, table.id),
    check("abuse_report_revision", sql`${table.revision} > 0`),
    check("abuse_report_receipt", sql`(${table.status} = 'submitted' AND ${table.receivedBy} IS NULL AND ${table.receivedAt} IS NULL) OR (${table.status} = 'received' AND ${table.receivedBy} IS NOT NULL AND ${table.receivedAt} IS NOT NULL)`),
]);

/** Metadata only: a record is not a moderation verdict or generation authorization. */
export const contentSafetyEvent = saas.table("content_safety_event", {
    id: uuid("id").primaryKey(),
    actorId: text("actor_id").notNull(),
    requestId: text("request_id").notNull(),
    modelId: text("model_id").notNull(),
    capability: text("capability").$type<"text" | "image" | "video" | "audio">().notNull(),
    phase: text("phase").$type<"pre_generation">().notNull(),
    mode: text("mode").$type<"record">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    check("content_safety_event_capability", sql`${table.capability} IN ('text', 'image', 'video', 'audio')`),
    check("content_safety_event_phase", sql`${table.phase} = 'pre_generation'`),
    check("content_safety_event_mode", sql`${table.mode} = 'record'`),
]);

/** A published policy is immutable; only the settings pointer advances. */
export const generationRateVersion = saas.table("generation_rate_version", {
    id: uuid("id").primaryKey(),
    revision: integer("revision").notNull(),
    expectedRevision: integer("expected_revision").notNull(),
    policy: jsonb("policy").$type<{ ip: { enabled: boolean; points: number; duration: number }; user: { enabled: boolean; points: number; duration: number } }>().notNull(),
    actorId: text("actor_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    requestId: text("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
    uniqueIndex("generation_rate_version_revision").on(table.revision),
    check("generation_rate_version_revision", sql`${table.revision} > 0 AND ${table.expectedRevision} >= 0 AND ${table.revision}::bigint = ${table.expectedRevision}::bigint + 1`),
    check("generation_rate_version_policy", sql`(jsonb_typeof(${table.policy}) = 'object' AND ${table.policy} - 'ip' - 'user' = '{}'::jsonb AND
        ${sql.join(["ip", "user"].map(key => {
            const member = sql.raw(`'${key}'`); // Fixed schema keys must be SQL literals in generated DDL.
            return sql`(
                jsonb_typeof(${table.policy}->${member}) = 'object' AND
                ${table.policy}->${member} ?& ARRAY['enabled','points','duration'] AND
                (${table.policy}->${member}) - 'enabled' - 'points' - 'duration' = '{}'::jsonb AND
                jsonb_typeof(${table.policy}->${member}->'enabled') = 'boolean' AND
                jsonb_typeof(${table.policy}->${member}->'points') = 'number' AND
                (${table.policy}->${member}->>'points')::numeric BETWEEN 1 AND 2147483647 AND
                trunc((${table.policy}->${member}->>'points')::numeric) = (${table.policy}->${member}->>'points')::numeric AND
                jsonb_typeof(${table.policy}->${member}->'duration') = 'number' AND
                (${table.policy}->${member}->>'duration')::numeric BETWEEN 1 AND 9007199254740 AND
                trunc((${table.policy}->${member}->>'duration')::numeric) = (${table.policy}->${member}->>'duration')::numeric
            )`;
        }), sql` AND `)}) IS TRUE`),
]);
export const generationRateSettings = saas.table("generation_rate_settings", {
    id: text("id").$type<"generation">().primaryKey(),
    revision: integer("revision").default(0).notNull(),
    activeVersionId: uuid("active_version_id").references(() => generationRateVersion.id, { onDelete: "restrict" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
    check("generation_rate_settings_id", sql`${table.id} = 'generation'`),
    check("generation_rate_settings_revision", sql`(${table.revision} = 0 AND ${table.activeVersionId} IS NULL) OR (${table.revision} > 0 AND ${table.activeVersionId} IS NOT NULL)`),
]);

/**
 * Exact decimal credits: unconstrained numeric stores existing integers and
 * fractional amounts without rounding. Application amounts cross this boundary
 * as decimal strings. A wallet is created lazily for existing accounts.
 */
export const wallet = saas.table("wallet", {
    userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
    unit: text("unit").$type<"credit">().default("credit").notNull(),
    availableUnits: numeric("available_units").default("0").notNull(),
    reservedUnits: numeric("reserved_units").default("0").notNull(),
    version: integer("version").default(1).notNull(),
    ...timestamps(),
}, (table) => [
    check("wallet_unit", sql`${table.unit} = 'credit'`),
    check("wallet_nonnegative", sql`${table.availableUnits} >= 0 AND ${table.reservedUnits} >= 0`),
    check("wallet_amounts_finite", sql`${table.availableUnits} NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND ${table.reservedUnits} NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`),
    check("wallet_version", sql`${table.version} > 0`),
]);

/** Append-only accounting entries. Mutations are rejected by a DB trigger in 0006. */
export const walletLedger = saas.table("wallet_ledger", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    kind: text("kind").$type<"grant" | "recharge" | "adjustment" | "reserve" | "capture" | "release" | "refund" | "consume">().notNull(),
    deltaAvailableUnits: numeric("delta_available_units").notNull(),
    deltaReservedUnits: numeric("delta_reserved_units").notNull(),
    availableUnitsAfter: numeric("available_units_after").notNull(),
    reservedUnitsAfter: numeric("reserved_units_after").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    referenceType: text("reference_type"),
    referenceId: text("reference_id"),
    actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<JsonObject>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex("wallet_ledger_user_idempotency").on(table.userId, table.idempotencyKey),
    uniqueIndex("wallet_ledger_payment_order_unique").on(table.referenceId)
        .where(sql`${table.kind} = 'recharge' AND ${table.referenceType} = 'payment_order'`),
    index("wallet_ledger_user_created").on(table.userId, table.createdAt),
    check("wallet_ledger_kind", sql`${table.kind} IN ('grant', 'recharge', 'adjustment', 'reserve', 'capture', 'release', 'refund', 'consume')`),
    check("wallet_ledger_balance_after_nonnegative", sql`${table.availableUnitsAfter} >= 0 AND ${table.reservedUnitsAfter} >= 0`),
    check("wallet_ledger_amounts_finite", sql`${table.deltaAvailableUnits} NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND ${table.deltaReservedUnits} NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND ${table.availableUnitsAfter} NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND ${table.reservedUnitsAfter} NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`),
]);

/** Published payment configuration is immutable; old orders retain the exact credential version. */
export const paymentMerchantVersion = saas.table("payment_merchant_version", {
    id: uuid("id").primaryKey(),
    merchantId: text("merchant_id").notNull(),
    protocol: text("protocol").$type<"zpay-epay-md5-doc-03b0f9fb1ff6">().notNull(),
    currency: text("currency").$type<"CNY">().notNull(),
    paymentType: text("payment_type").$type<"alipay" | "wxpay">().notNull(),
    channelId: text("channel_id"),
    productName: text("product_name").notNull(),
    notifyUrl: text("notify_url").notNull(),
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    authTag: text("auth_tag").notNull(),
    keyVersion: integer("key_version").notNull(),
    actorId: text("actor_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    check("payment_merchant_identity", sql`${table.merchantId} ~ '^[A-Za-z0-9_-]+$'`),
    check("payment_merchant_protocol", sql`${table.protocol} = 'zpay-epay-md5-doc-03b0f9fb1ff6' AND ${table.currency} = 'CNY'`),
    check("payment_merchant_type", sql`${table.paymentType} IN ('alipay', 'wxpay')`),
    check("payment_merchant_credential", sql`length(${table.ciphertext}) > 0 AND length(${table.nonce}) = 24 AND length(${table.authTag}) = 32 AND ${table.keyVersion} = 1`),
]);

/** Cash and credits are separate exact quantities, never an inferred conversion multiplier. */
export const paymentOfferVersion = saas.table("payment_offer_version", {
    id: uuid("id").primaryKey(),
    offerId: uuid("offer_id").notNull(),
    revision: integer("revision").notNull(),
    label: text("label").notNull(),
    amountMinor: text("amount_minor").notNull(),
    creditUnits: numeric("credit_units").notNull(),
    policyReference: text("policy_reference"),
    actorId: text("actor_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex("payment_offer_version_unique").on(table.offerId, table.revision),
    check("payment_offer_revision", sql`${table.revision} > 0`),
    check("payment_offer_amount", sql`${table.amountMinor} ~ '^[1-9][0-9]*$'`),
    check("payment_offer_credits", sql`${table.creditUnits} > 0 AND ${table.creditUnits} NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`),
]);

/** The only mutable configuration pointer. Publishing configuration does not enable the public site. */
export const paymentSettings = saas.table("payment_settings", {
    id: text("id").$type<"zpay">().primaryKey(),
    revision: integer("revision").default(0).notNull(),
    newOrdersEnabled: boolean("new_orders_enabled").default(false).notNull(),
    merchantVersionId: uuid("merchant_version_id").references(() => paymentMerchantVersion.id, { onDelete: "restrict" }),
    offerVersionIds: jsonb("offer_version_ids").$type<string[]>().default([]).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    check("payment_settings_id", sql`${table.id} = 'zpay'`),
    check("payment_settings_revision", sql`${table.revision} >= 0`),
    check("payment_settings_offers", sql`jsonb_typeof(${table.offerVersionIds}) = 'array'`),
    check("payment_settings_enablement", sql`NOT ${table.newOrdersEnabled} OR (${table.merchantVersionId} IS NOT NULL AND jsonb_array_length(${table.offerVersionIds}) > 0)`),
]);

export const paymentOrder = saas.table("payment_order", {
    id: uuid("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "restrict" }),
    createKey: text("create_key").notNull(),
    provider: text("provider").$type<"zpay">().notNull(),
    merchantVersionId: uuid("merchant_version_id").notNull().references(() => paymentMerchantVersion.id, { onDelete: "restrict" }),
    offerVersionId: uuid("offer_version_id").notNull().references(() => paymentOfferVersion.id, { onDelete: "restrict" }),
    merchantId: text("merchant_id").notNull(),
    merchantOrderId: text("merchant_order_id").notNull(),
    currency: text("currency").$type<"CNY">().notNull(),
    amountMinor: text("amount_minor").notNull(),
    creditUnits: numeric("credit_units").notNull(),
    paymentType: text("payment_type").$type<"alipay" | "wxpay">().notNull(),
    productName: text("product_name").notNull(),
    channelId: text("channel_id"),
    createState: text("create_state").$type<"pending" | "attempting" | "accepted" | "rejected" | "unknown">().default("pending").notNull(),
    createAttemptToken: uuid("create_attempt_token"),
    createAttemptedAt: timestamp("create_attempted_at", { withTimezone: true }),
    providerTradeNo: text("provider_trade_no"),
    providerOrderId: text("provider_order_id"),
    paymentLinks: jsonb("payment_links").$type<Record<string, string>>(),
    paymentState: text("payment_state").$type<"unknown" | "unpaid" | "paid">().default("unknown").notNull(),
    creditState: text("credit_state").$type<"pending" | "credited">().default("pending").notNull(),
    refundState: text("refund_state").$type<"none" | "pending_review" | "refunded">().default("none").notNull(),
    creditedLedgerId: text("credited_ledger_id").references(() => walletLedger.id, { onDelete: "restrict" }),
    creditedAt: timestamp("credited_at", { withTimezone: true }),
    lastReason: text("last_reason"),
    ...timestamps(),
}, (table) => [
    uniqueIndex("payment_order_owner_key").on(table.ownerId, table.createKey),
    uniqueIndex("payment_order_merchant_number").on(table.provider, table.merchantId, table.merchantOrderId),
    uniqueIndex("payment_order_merchant_transaction").on(table.provider, table.merchantId, table.providerTradeNo),
    uniqueIndex("payment_order_credited_ledger").on(table.creditedLedgerId),
    index("payment_order_owner_created").on(table.ownerId, table.createdAt, table.id),
    check("payment_order_identity", sql`${table.provider} = 'zpay' AND ${table.currency} = 'CNY' AND ${table.merchantId} ~ '^[A-Za-z0-9_-]+$' AND ${table.merchantOrderId} ~ '^[A-Za-z0-9_-]{1,32}$' AND (${table.providerTradeNo} IS NULL OR ${table.providerTradeNo} ~ '^[A-Za-z0-9_-]+$')`),
    check("payment_order_amount", sql`${table.amountMinor} ~ '^[1-9][0-9]*$' AND ${table.creditUnits} > 0 AND ${table.creditUnits} NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`),
    check("payment_order_type", sql`${table.paymentType} IN ('alipay', 'wxpay')`),
    check("payment_order_create_state", sql`${table.createState} IN ('pending', 'attempting', 'accepted', 'rejected', 'unknown')`),
    check("payment_order_attempt_pair", sql`(${table.createAttemptToken} IS NULL) = (${table.createAttemptedAt} IS NULL)`),
    check("payment_order_payment_state", sql`${table.paymentState} IN ('unknown', 'unpaid', 'paid')`),
    check("payment_order_refund_state", sql`${table.refundState} IN ('none', 'pending_review', 'refunded')`),
    check("payment_order_credit_state", sql`(${table.creditState} = 'pending' AND ${table.creditedLedgerId} IS NULL AND ${table.creditedAt} IS NULL) OR (${table.creditState} = 'credited' AND ${table.creditedLedgerId} IS NOT NULL AND ${table.creditedAt} IS NOT NULL AND ${table.providerTradeNo} IS NOT NULL AND ${table.paymentState} = 'paid')`),
]);

/** Private durable evidence, not an HTTP projection or a direct crediting authorization. */
export const paymentEvent = saas.table("payment_event", {
    id: uuid("id").primaryKey(),
    orderId: uuid("order_id").notNull().references(() => paymentOrder.id, { onDelete: "restrict" }),
    kind: text("kind").$type<"notification" | "query" | "create" | "reconcile">().notNull(),
    eventIdentity: text("event_identity"),
    outcome: text("outcome").notNull(),
    evidence: jsonb("evidence").$type<JsonObject>().notNull(),
    ciphertext: text("ciphertext"),
    nonce: text("nonce"),
    authTag: text("auth_tag"),
    keyVersion: integer("key_version"),
    requestId: text("request_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
    uniqueIndex("payment_event_identity").on(table.eventIdentity).where(sql`${table.kind} = 'notification'`),
    index("payment_event_order_created").on(table.orderId, table.createdAt, table.id),
    check("payment_event_kind", sql`${table.kind} IN ('notification', 'query', 'create', 'reconcile')`),
    check("payment_event_evidence", sql`jsonb_typeof(${table.evidence}) = 'object'`),
    check("payment_event_notice_cipher", sql`(${table.kind} = 'notification' AND ${table.eventIdentity} IS NOT NULL AND ${table.ciphertext} IS NOT NULL AND length(${table.ciphertext}) > 0 AND ${table.nonce} IS NOT NULL AND length(${table.nonce}) = 24 AND ${table.authTag} IS NOT NULL AND length(${table.authTag}) = 32 AND ${table.keyVersion} IS NOT NULL AND ${table.keyVersion} = 1) OR (${table.kind} <> 'notification' AND ${table.ciphertext} IS NULL AND ${table.nonce} IS NULL AND ${table.authTag} IS NULL AND ${table.keyVersion} IS NULL)`),
]);

export const walletReservation = saas.table("wallet_reservation", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    requestedUnits: numeric("requested_units").notNull(),
    capturedUnits: numeric("captured_units").default("0").notNull(),
    releasedUnits: numeric("released_units").default("0").notNull(),
    status: text("status").$type<"pending" | "captured" | "released" | "expired">().default("pending").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    providerRequestId: text("provider_request_id"),
    taskId: text("task_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    ...timestamps(),
}, (table) => [
    uniqueIndex("wallet_reservation_user_idempotency").on(table.userId, table.idempotencyKey),
    index("wallet_reservation_user_status").on(table.userId, table.status),
    check("wallet_reservation_status", sql`${table.status} IN ('pending', 'captured', 'released', 'expired')`),
    check("wallet_reservation_requested_positive", sql`${table.requestedUnits} > 0`),
    check("wallet_reservation_parts_nonnegative", sql`${table.capturedUnits} >= 0 AND ${table.releasedUnits} >= 0`),
    check("wallet_reservation_parts_within_request", sql`${table.capturedUnits} + ${table.releasedUnits} <= ${table.requestedUnits}`),
    check("wallet_reservation_amounts_finite", sql`${table.requestedUnits} NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND ${table.capturedUnits} NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) AND ${table.releasedUnits} NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`),
]);

export type GenerationExecutionStatus = "pending" | "queued" | "running" | "succeeded" | "failed" | "unknown" | "cancelled" | "timeout";
export type GenerationDeliveryStatus = "pending" | "saved" | "visible" | "failed" | "unknown";
export type GenerationBillingStatus = "unbilled" | "reserved" | "captured" | "released" | "pending_review";

/**
 * Durable task identity for the first server-side generation vertical slice.
 * Execution, delivery and billing stay separate so an upstream success cannot
 * be mistaken for a saved asset or a settled charge.
 */
export const generationTask = saas.table("generation_task", {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    // Workspace identity is reserved for the cloud canvas phase; existing
    // local drafts do not yet expose a durable space row.
    spaceId: text("space_id"),
    projectId: text("project_id"),
    nodeId: text("node_id"),
    inputSnapshot: jsonb("input_snapshot").$type<JsonObject>().notNull(),
    modelId: text("model_id").notNull(),
    parameterSnapshot: jsonb("parameter_snapshot").$type<JsonObject>().notNull(),
    priceVersion: integer("price_version"),
    quotedUnits: bigint("quoted_units", { mode: "number" }),
    billingUnitSnapshot: text("billing_unit_snapshot").$type<TaskBillingUnit>(),
    creditsPerUnitSnapshot: bigint("credits_per_unit_snapshot", { mode: "number" }),
    textQuoteSnapshot: jsonb("text_quote_snapshot").$type<TextQuoteSnapshot>(),
    videoQuoteSnapshot: jsonb("video_quote_snapshot").$type<VideoQuoteSnapshot>(),
    // Bound by the INSERT trigger, never accepted from a public task request.
    // Legacy tasks retain null; immutable publication/draft rows preserve the original rules.
    pricePublicationId: text("price_publication_id").references(() => modelPricePublication.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    reservationId: text("reservation_id").references(() => walletReservation.id, { onDelete: "set null" }),
    providerTaskId: text("provider_task_id"),
    executionStatus: text("execution_status").$type<GenerationExecutionStatus>().default("pending").notNull(),
    deliveryStatus: text("delivery_status").$type<GenerationDeliveryStatus>().default("pending").notNull(),
    billingStatus: text("billing_status").$type<GenerationBillingStatus>().default("unbilled").notNull(),
    unknownReason: text("unknown_reason"),
    requestId: text("request_id").notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...timestamps(),
}, (table) => [
    uniqueIndex("generation_task_owner_idempotency").on(table.ownerId, table.idempotencyKey),
    index("generation_task_owner_created").on(table.ownerId, table.createdAt),
    index("generation_task_owner_execution").on(table.ownerId, table.executionStatus, table.updatedAt),
    index("generation_task_reservation").on(table.reservationId),
    index("generation_task_provider_task").on(table.providerTaskId),
    index("generation_task_model").on(table.modelId),
    check("generation_task_input_object", sql`jsonb_typeof(${table.inputSnapshot}) = 'object'`),
    check("generation_task_parameters_object", sql`jsonb_typeof(${table.parameterSnapshot}) = 'object'`),
    check("generation_task_model_id", sql`length(trim(${table.modelId})) > 0`),
    check("generation_task_idempotency_key", sql`length(trim(${table.idempotencyKey})) > 0`),
    check("generation_task_request_id", sql`length(trim(${table.requestId})) > 0`),
    check("generation_task_price_version", sql`${table.priceVersion} IS NULL OR ${table.priceVersion} > 0`),
    check("generation_task_quoted_units", sql`${table.quotedUnits} IS NULL OR ${table.quotedUnits} >= 0`),
    check("generation_task_billing_unit_snapshot", sql`${table.billingUnitSnapshot} IS NULL OR ${table.billingUnitSnapshot} IN ('request', 'input_token', 'output_token', 'second', 'megapixel', 'image')`),
    check("generation_task_credits_per_unit_snapshot", sql`${table.creditsPerUnitSnapshot} IS NULL OR ${table.creditsPerUnitSnapshot} > 0`),
    check("generation_task_pricing_snapshot_pair", sql`(${table.billingUnitSnapshot} IS NULL AND ${table.creditsPerUnitSnapshot} IS NULL) OR (${table.billingUnitSnapshot} IS NOT NULL AND ${table.creditsPerUnitSnapshot} IS NOT NULL)`),
    check("generation_task_text_quote", sql`${table.textQuoteSnapshot} IS NULL OR (jsonb_typeof(${table.textQuoteSnapshot}) = 'object' AND ${table.priceVersion} IS NOT NULL AND ${table.quotedUnits} IS NULL AND ${table.billingUnitSnapshot} IS NULL AND ${table.creditsPerUnitSnapshot} IS NULL)`),
    check("generation_task_video_quote", sql`${table.videoQuoteSnapshot} IS NULL OR (jsonb_typeof(${table.videoQuoteSnapshot}) = 'object' AND ${table.textQuoteSnapshot} IS NULL AND ${table.priceVersion} IS NOT NULL AND ${table.quotedUnits} IS NOT NULL AND ${table.billingUnitSnapshot} = 'request' AND ${table.creditsPerUnitSnapshot} IS NOT NULL)`),
    check("generation_task_execution_status", sql`${table.executionStatus} IN ('pending', 'queued', 'running', 'succeeded', 'failed', 'unknown', 'cancelled', 'timeout')`),
    check("generation_task_delivery_status", sql`${table.deliveryStatus} IN ('pending', 'saved', 'visible', 'failed', 'unknown')`),
    check("generation_task_billing_status", sql`${table.billingStatus} IN ('unbilled', 'reserved', 'captured', 'released', 'pending_review')`),
    check("generation_task_unknown_reason", sql`${table.executionStatus} <> 'unknown' OR (${table.unknownReason} IS NOT NULL AND length(trim(${table.unknownReason})) > 0)`),
]);

/** Owner-only display metadata. Renaming never updates a generation task. */
export const generationHistoryTitle = saas.table("generation_history_title", {
    taskId: text("task_id").primaryKey().references(() => generationTask.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
}, table => [check("generation_history_title_nonempty", sql`length(trim(${table.title})) > 0`)]);

/** One durable execution attachment to the existing generation task, not a second task system. */
export const generationVideoStage = saas.table("generation_video_stage", {
    taskId: text("task_id").primaryKey().references(() => generationTask.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull(),
    protocol: text("protocol").$type<"yunfei-grok-video-v1">().notNull(),
    providerId: text("provider_id").notNull(),
    endpoint: text("endpoint").notNull(),
    providerModel: text("provider_model").notNull(),
    pricePublicationId: text("price_publication_id").notNull().references(() => modelPricePublication.id, { onDelete: "restrict" }),
    parametersSnapshot: jsonb("parameters_snapshot").$type<VideoParameters>().notNull(),
    phase: text("phase").$type<VideoPhase>().notNull(),
    revision: integer("revision").default(0).notNull(),
    createAttemptToken: text("create_attempt_token"),
    createStartedAt: timestamp("create_started_at", { withTimezone: true }),
    providerTaskId: text("provider_task_id"),
    claimToken: text("claim_token"),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    nextActionAt: timestamp("next_action_at", { withTimezone: true }),
    inspectAttempts: integer("inspect_attempts").default(0).notNull(),
    downloadAttempts: integer("download_attempts").default(0).notNull(),
    observationDeadlineAt: timestamp("observation_deadline_at", { withTimezone: true }),
    wakeRevision: integer("wake_revision"),
    wakeJobId: text("wake_job_id"),
    wakeDeadlineAt: timestamp("wake_deadline_at", { withTimezone: true }),
    lastReason: text("last_reason"),
    lastHttpStatus: integer("last_http_status"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    durationEvidence: jsonb("duration_evidence").$type<JsonObject>(),
    probeSnapshot: jsonb("probe_snapshot").$type<JsonObject>(),
    ...timestamps(),
}, (table) => [
    index("generation_video_stage_next_action").on(table.nextActionAt, table.taskId),
    index("generation_video_stage_lease").on(table.leaseUntil, table.taskId),
    check("generation_video_stage_protocol", sql`${table.protocol} = 'yunfei-grok-video-v1'`),
    check("generation_video_stage_phase", sql`${table.phase} IN ('ready', 'rejected', 'create_started', 'accepted', 'polling', 'completed', 'failed', 'unknown')`),
    check("generation_video_stage_counters", sql`${table.revision} >= 0 AND ${table.inspectAttempts} >= 0 AND ${table.downloadAttempts} >= 0 AND (${table.wakeRevision} IS NULL OR ${table.wakeRevision} >= 0)`),
    check("generation_video_stage_http_status", sql`${table.lastHttpStatus} IS NULL OR ${table.lastHttpStatus} BETWEEN 100 AND 599`),
    check("generation_video_stage_claim_pair", sql`(${table.claimToken} IS NULL) = (${table.leaseUntil} IS NULL)`),
    check("generation_video_stage_create_pair", sql`(${table.createAttemptToken} IS NULL) = (${table.createStartedAt} IS NULL)`),
    check("generation_video_stage_id", sql`${table.providerTaskId} IS NULL OR (length(${table.providerTaskId}) BETWEEN 1 AND 200 AND ${table.providerTaskId} NOT IN ('.', '..') AND ${table.providerTaskId} !~ '[[:cntrl:]]')`),
    check("generation_video_stage_bound_phase", sql`${table.phase} NOT IN ('accepted', 'polling', 'completed', 'failed') OR ${table.providerTaskId} IS NOT NULL`),
    check("generation_video_stage_rejected", sql`${table.phase} <> 'rejected' OR (${table.createAttemptToken} IS NULL AND ${table.createStartedAt} IS NULL AND ${table.providerTaskId} IS NULL)`),
    check("generation_video_stage_parameters", sql`jsonb_typeof(${table.parametersSnapshot}) = 'object'`),
    check("generation_video_stage_probe", sql`${table.probeSnapshot} IS NULL OR jsonb_typeof(${table.probeSnapshot}) = 'object'`),
    check("generation_video_stage_duration", sql`${table.durationEvidence} IS NULL OR COALESCE((jsonb_typeof(${table.durationEvidence}) = 'object' AND ((${table.durationEvidence} = '{"status":"missing"}'::jsonb) OR (${table.durationEvidence} = '{"status":"invalid"}'::jsonb) OR (${table.durationEvidence} = jsonb_build_object('status', 'reported', 'rawSeconds', ${table.durationEvidence}->>'rawSeconds') AND ${table.durationEvidence}->>'rawSeconds' ~ '^(0|[1-9][0-9]*)([.][0-9]+)?$' AND (${table.durationEvidence}->>'rawSeconds')::numeric > 0))), false)`),
]);

/** Each planned supplier request can be started only once; successful PNG evidence survives partial batches. */
export const generationImageRequest = saas.table("generation_image_request", {
    taskId: text("task_id").notNull().references(() => generationTask.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    requestIndex: integer("request_index").notNull(),
    imageCount: integer("image_count").notNull(),
    publicationId: text("publication_id").notNull().references(() => modelPricePublication.id, { onDelete: "restrict" }),
    bindingSnapshot: jsonb("binding_snapshot").$type<Record<string, unknown>>().notNull(),
    parametersSnapshot: jsonb("parameters_snapshot").$type<Record<string, unknown>>().notNull(),
    phase: text("phase").$type<"ready" | "started" | "succeeded" | "failed" | "unknown">().default("ready").notNull(),
    attemptToken: text("attempt_token"),
    resultSnapshot: jsonb("result_snapshot").$type<Record<string, unknown>>().default({}).notNull(),
    lastReason: text("last_reason"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
}, table => [
    primaryKey({ columns: [table.taskId, table.requestIndex] }),
    check("generation_image_request_count", sql`${table.requestIndex} BETWEEN 0 AND 9 AND ${table.imageCount} BETWEEN 1 AND 10`),
    check("generation_image_request_phase", sql`${table.phase} IN ('ready', 'started', 'succeeded', 'failed', 'unknown')`),
    check("generation_image_request_attempt", sql`(${table.phase} = 'ready' AND ${table.attemptToken} IS NULL AND ${table.startedAt} IS NULL) OR (${table.phase} <> 'ready' AND ${table.attemptToken} IS NOT NULL AND ${table.startedAt} IS NOT NULL)`),
    check("generation_image_request_snapshots", sql`jsonb_typeof(${table.bindingSnapshot}) = 'object' AND jsonb_typeof(${table.parametersSnapshot}) = 'object' AND jsonb_typeof(${table.resultSnapshot}) = 'object'`),
]);

export type GenerationResultStatus = "succeeded" | "failed" | "unknown";

/**
 * Normalized provider result metadata. Raw provider responses are deliberately
 * not persisted here; adapters must map them to safe asset/reference fields.
 */
export const generationResult = saas.table("generation_result", {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => generationTask.id, { onDelete: "cascade" }).unique(),
    ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    status: text("status").$type<GenerationResultStatus>().notNull(),
    providerStatus: integer("provider_status"),
    providerTaskId: text("provider_task_id"),
    consumedUnits: bigint("consumed_units", { mode: "number" }),
    resultSnapshot: jsonb("result_snapshot").$type<JsonObject>().notNull(),
    errorCode: text("error_code"),
    unknownReason: text("unknown_reason"),
    ...timestamps(),
}, (table) => [
    index("generation_result_owner_created").on(table.ownerId, table.createdAt),
    check("generation_result_status", sql`${table.status} IN ('succeeded', 'failed', 'unknown')`),
    check("generation_result_provider_status", sql`${table.providerStatus} IS NULL OR (${table.providerStatus} >= 100 AND ${table.providerStatus} <= 599)`),
    check("generation_result_consumed_units", sql`${table.consumedUnits} IS NULL OR ${table.consumedUnits} >= 0`),
    check("generation_result_snapshot_object", sql`jsonb_typeof(${table.resultSnapshot}) = 'object'`),
    check("generation_result_failed_code", sql`${table.status} <> 'failed' OR (${table.errorCode} IS NOT NULL AND length(trim(${table.errorCode})) > 0)`),
    check("generation_result_unknown_reason", sql`${table.status} <> 'unknown' OR (${table.unknownReason} IS NOT NULL AND length(trim(${table.unknownReason})) > 0)`),
]);
