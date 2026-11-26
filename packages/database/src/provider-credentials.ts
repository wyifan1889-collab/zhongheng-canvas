import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "./client";
import { modelProviderCredential } from "./schema";

const KEY_VERSION = 1;
const KEY_LENGTH = 32;
const NONCE_LENGTH = 12;
const AAD_PREFIX = "infinite-canvas/provider-credential/v1:";

function keyFor(authSecret: string, providerId: string): Buffer {
    if (authSecret.length < 32) throw new Error("provider credential key derivation requires a sufficiently long auth secret");
    return Buffer.from(hkdfSync("sha256", Buffer.from(authSecret, "utf8"), Buffer.from("infinite-canvas/provider-credential", "utf8"), Buffer.from(providerId, "utf8"), KEY_LENGTH));
}

function aadFor(providerId: string): Buffer {
    return Buffer.from(`${AAD_PREFIX}${providerId}`, "utf8");
}

export type EncryptedProviderCredential = {
    ciphertext: string;
    nonce: string;
    authTag: string;
    keyVersion: 1;
};

/** Encrypt a provider API credential. The clear value never reaches the DB. */
export function encryptProviderCredential(authSecret: string, providerId: string, value: string): EncryptedProviderCredential {
    const nonce = randomBytes(NONCE_LENGTH);
    const cipher = createCipheriv("aes-256-gcm", keyFor(authSecret, providerId), nonce);
    cipher.setAAD(aadFor(providerId));
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { ciphertext: ciphertext.toString("base64url"), nonce: nonce.toString("hex"), authTag: cipher.getAuthTag().toString("hex"), keyVersion: KEY_VERSION };
}

/** Decrypt only at the provider gateway boundary; never include this in HTTP projections. */
export function decryptProviderCredential(authSecret: string, providerId: string, row: EncryptedProviderCredential): string {
    if (row.keyVersion !== KEY_VERSION) throw new Error("unsupported provider credential key version");
    const decipher = createDecipheriv("aes-256-gcm", keyFor(authSecret, providerId), Buffer.from(row.nonce, "hex"));
    decipher.setAAD(aadFor(providerId));
    decipher.setAuthTag(Buffer.from(row.authTag, "hex"));
    return Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64url")), decipher.final()]).toString("utf8");
}

export async function hasProviderCredential(db: Database, providerId: string): Promise<boolean> {
    const [row] = await db.select({ providerId: modelProviderCredential.providerId }).from(modelProviderCredential).where(eq(modelProviderCredential.providerId, providerId)).limit(1);
    return Boolean(row);
}

export async function saveProviderCredential(db: Database, authSecret: string, providerId: string, value: string): Promise<void> {
    const encrypted = encryptProviderCredential(authSecret, providerId, value);
    await db.insert(modelProviderCredential).values({ providerId, ...encrypted }).onConflictDoUpdate({
        target: modelProviderCredential.providerId,
        set: { ciphertext: encrypted.ciphertext, nonce: encrypted.nonce, authTag: encrypted.authTag, keyVersion: encrypted.keyVersion, updatedAt: new Date() },
    });
}

export async function loadProviderCredential(db: Database, authSecret: string, providerId: string): Promise<string | null> {
    const [row] = await db.select().from(modelProviderCredential).where(eq(modelProviderCredential.providerId, providerId)).limit(1);
    return row ? decryptProviderCredential(authSecret, providerId, row) : null;
}
