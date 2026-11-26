import { readFile } from "node:fs/promises";
import { createDatabase } from "../../packages/database/src/client";
import { normalizeCreditAmount } from "../../packages/shared/src/credit-amounts";
import { parseImageSpecParameters, publishedImageSpecDraftPrice } from "../../packages/shared/src/model-price-publications";
import { canonicalPostgresTarget, readGenerationWorkerConfig } from "../../apps/api/src/generation-worker-config";
import {
    evaluateGenerationPreflight,
    generationPreflightSnapshotSchema,
    type GenerationPreflightSnapshot,
} from "../../apps/api/src/generation-config-preflight";

function arg(name: string): string | undefined {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(message: string): never {
    console.error(`FAIL generation config preflight: ${message}`);
    process.exit(1);
}

/**
 * Database mode is intentionally harder to invoke than snapshot mode. These
 * checks run before createDatabase so a copied production env cannot trigger a
 * read, even though the transaction itself is read-only.
 */
function assertReadOnlyStagingDatabaseGate(): void {
    if (process.env.GENERATION_WORKER_ENABLED !== "true") fail("database mode requires GENERATION_WORKER_ENABLED=true");
    const worker = readGenerationWorkerConfig(process.env);
    if (!worker || worker.environment !== "staging") fail("database mode requires GENERATION_WORKER_ENVIRONMENT=staging");
    const databaseUrl = process.env.SAAS_DATABASE_URL;
    if (!databaseUrl || !["postgres:", "postgresql:"].includes(new URL(databaseUrl).protocol)) fail("database mode requires a PostgreSQL SAAS_DATABASE_URL");
    const queueTarget = canonicalPostgresTarget(worker.queueConnectionString, "GENERATION_WORKER_QUEUE_URL");
    const applicationTarget = canonicalPostgresTarget(databaseUrl, "SAAS_DATABASE_URL");
    if (queueTarget !== applicationTarget) fail("database mode requires the queue and SAAS_DATABASE_URL to target the same database for transactional enqueue");
    if (!process.env.SAAS_AUTH_SECRET || process.env.SAAS_AUTH_SECRET.length < 32) fail("database mode requires SAAS_AUTH_SECRET");
    const originValue = process.env.SAAS_ORIGIN;
    if (!originValue) fail("database mode requires SAAS_ORIGIN");
    let origin: URL;
    try { origin = new URL(originValue); } catch { fail("SAAS_ORIGIN must be an absolute HTTPS origin"); }
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
        fail("SAAS_ORIGIN must be an absolute HTTPS origin without credentials, path, query or fragment");
    }
    if (origin.hostname.toLowerCase() === "agent.zh-api.com") fail("database mode refuses the production origin");
}

/** Read metadata in a read-only transaction; no credential ciphertext is selected. */
async function readDatabaseSnapshot(connectionString: string, testAccountId: string): Promise<GenerationPreflightSnapshot> {
    const database = createDatabase(connectionString);
    const client = await database.pool.connect();
    try {
        await client.query("BEGIN TRANSACTION READ ONLY");
        const providers = (await client.query(`SELECT p.id, p.enabled, p.adapter,
            EXISTS (SELECT 1 FROM canvas_saas.model_provider_credential c WHERE c.provider_id = p.id) AS "credentialConfigured"
            FROM canvas_saas.model_provider p`)).rows;
        const models = (await client.query(`SELECT id, public_id AS "publicId", provider_id AS "providerId", capability, enabled
            FROM canvas_saas.model_catalog`)).rows;
        const pricingRows = (await client.query(`SELECT p.model_id AS "modelId", p.version, p.billing_unit AS "billingUnit",
            p.credits_per_unit::text AS "creditsPerUnit", p.effective_from AS "effectiveFrom", p.effective_to AS "effectiveTo", p.enabled,
            d.id AS "sourceDraftId", d.provider_id_snapshot AS "sourceProviderId", d.provider_model_snapshot AS "sourceProviderModel",
            d.adapter_snapshot AS "sourceAdapter", d.endpoint_snapshot AS "sourceEndpoint", d.capability_snapshot AS "sourceCapability", d.rules AS "sourceRules"
            FROM canvas_saas.model_pricing p
            LEFT JOIN canvas_saas.model_price_publication publication ON publication.pricing_id = p.id
            LEFT JOIN canvas_saas.model_catalog model ON model.id = p.model_id
            LEFT JOIN canvas_saas.model_provider provider ON provider.id = model.provider_id
            LEFT JOIN canvas_saas.model_price_draft d ON d.id = publication.draft_id AND d.model_id = p.model_id
                AND d.provider_id_snapshot = model.provider_id AND d.provider_model_snapshot = model.provider_model
                AND d.adapter_snapshot = provider.adapter AND d.endpoint_snapshot = provider.endpoint AND d.capability_snapshot = model.capability`)).rows;
        const pricing = pricingRows.map((row) => {
            // Private source evidence never enters the printed metadata snapshot.
            const price = { modelId: row.modelId, version: row.version, billingUnit: row.billingUnit,
                creditsPerUnit: row.creditsPerUnit === null ? null : Number(row.creditsPerUnit),
                effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo, enabled: row.enabled };
            if (row.billingUnit !== "image_specs" || !row.sourceDraftId) return price;
            const published = publishedImageSpecDraftPrice({ providerId: row.sourceProviderId, providerModel: row.sourceProviderModel,
                adapter: row.sourceAdapter, endpoint: row.sourceEndpoint, capability: row.sourceCapability }, row.sourceRules);
            return published ? { ...price, protocol: published.protocol, imageSpecs: published.imageSpecs } : price;
        });
        const wallets = (await client.query(`SELECT user_id AS "userId", unit,
            available_units::text AS "availableUnits", reserved_units::text AS "reservedUnits"
            FROM canvas_saas.wallet WHERE user_id = $1`, [testAccountId])).rows
            .map((row) => ({ ...row, availableUnits: normalizeCreditAmount(row.availableUnits), reservedUnits: normalizeCreditAmount(row.reservedUnits) }));
        await client.query("ROLLBACK");
        return generationPreflightSnapshotSchema.parse({ providers, models, pricing, wallets });
    } catch (error) {
        try { await client.query("ROLLBACK"); } catch { /* preserve the original failure */ }
        throw error;
    } finally {
        client.release();
        await database.close();
    }
}

try {
    // No selector retains the existing text preflight. Image readiness is always
    // explicit: --capability image --model-id <platform public model ID>.
    const capability = arg("--capability");
    const publicModelId = arg("--model-id");
    const imageSize = arg("--image-size"), imageQuality = arg("--image-quality");
    const hasImageSpec = process.argv.includes("--image-size") || process.argv.includes("--image-quality");
    if (process.argv.includes("--capability") && capability !== "text" && capability !== "image") fail("--capability must be text or image");
    if (process.argv.includes("--model-id") && (!publicModelId?.trim() || publicModelId.startsWith("--"))) fail("--model-id requires a public model ID");
    if (capability === "image" && !publicModelId) fail("image preflight requires --model-id <public model ID>");
    if (publicModelId && capability !== "image") fail("--model-id requires explicit --capability image");
    if (hasImageSpec && capability !== "image") fail("--image-size and --image-quality require explicit --capability image");
    if (process.argv.includes("--image-size") && (!imageSize || imageSize.startsWith("--"))) fail("--image-size requires an explicit WIDTHxHEIGHT value");
    if (process.argv.includes("--image-quality") && (!imageQuality || imageQuality.startsWith("--"))) fail("--image-quality requires low, medium or high");
    const imageSpec = hasImageSpec ? parseImageSpecParameters({ ...(imageSize === undefined ? {} : { size: imageSize }),
        ...(imageQuality === undefined ? {} : { quality: imageQuality }) }) : null;
    if (hasImageSpec && !imageSpec) fail("image preflight requires an explicit supported image specification");
    const testAccountId = process.env.GENERATION_STAGING_TEST_ACCOUNT_ID?.trim();
    if (!testAccountId) fail("GENERATION_STAGING_TEST_ACCOUNT_ID is required and is never printed");
    const snapshotPath = arg("--snapshot");
    const useDatabase = process.argv.includes("--database-read-only");
    if (!snapshotPath && !useDatabase) fail("choose --snapshot <path> or explicit --database-read-only");
    if (snapshotPath && useDatabase) fail("choose only one input mode");
    if (useDatabase) assertReadOnlyStagingDatabaseGate();
    const raw = snapshotPath ? JSON.parse(await readFile(snapshotPath, "utf8")) : await readDatabaseSnapshot(process.env.SAAS_DATABASE_URL ?? "", testAccountId);
    const snapshot = generationPreflightSnapshotSchema.parse(raw);
    const result = evaluateGenerationPreflight(snapshot, capability === "image"
        ? { testAccountId, capability, publicModelId: publicModelId!, ...(imageSpec ? { imageSpec } : {}) }
        : { testAccountId });
    console.log(JSON.stringify(result));
    if (result.status !== "ready") process.exitCode = 1;
} catch (error) {
    fail(error instanceof Error ? error.message : "invalid snapshot or read-only database result");
}
