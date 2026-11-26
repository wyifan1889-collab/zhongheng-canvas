import type { Database } from "@infinite-canvas/database";
import { modelCatalog, modelPricing, modelProvider, modelProviderCredential } from "@infinite-canvas/database/schema";

export async function seedGenerationPricing(
    db: Database,
    entries: readonly Array<{
        modelId: string;
        capability: "text" | "image" | "video" | "audio";
        version: number;
        billingUnit: "request" | "input_token" | "output_token" | "second" | "megapixel";
        creditsPerUnit: number;
    }>,
) {
    await db.insert(modelProvider).values({
        id: "generation-test-provider",
        displayName: "Generation test provider",
        adapter: "openai-compatible",
        endpoint: "https://provider.invalid/v1",
        secretRef: "GENERATION_TEST_PROVIDER",
        enabled: true,
    });
    await db.insert(modelProviderCredential).values({
        providerId: "generation-test-provider",
        ciphertext: "test-ciphertext",
        nonce: "0".repeat(24),
        authTag: "0".repeat(32),
    });
    await db.insert(modelCatalog).values(entries.map((entry) => ({
        id: `generation-${entry.modelId}`,
        providerId: "generation-test-provider",
        publicId: entry.modelId,
        providerModel: `provider-${entry.modelId}`,
        displayName: entry.modelId,
        capability: entry.capability,
        enabled: true,
    })));
    await db.insert(modelPricing).values(entries.map((entry) => ({
        id: `generation-price-${entry.modelId}-${entry.version}`,
        modelId: `generation-${entry.modelId}`,
        version: entry.version,
        billingUnit: entry.billingUnit,
        creditsPerUnit: entry.creditsPerUnit,
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
        enabled: true,
    })));
}
