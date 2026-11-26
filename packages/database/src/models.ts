import { and, asc, eq, isNull } from "drizzle-orm";
import type { NodeModelGroups, PublicModelGroup } from "@infinite-canvas/shared";
import type { Database } from "./client";
import { modelCatalog, modelProvider, modelProviderCredential } from "./schema";
import { listNodeModelGroups } from "./node-model-groups";

export type PublicModel = {
    id: string;
    displayName: string;
    capability: "text" | "image" | "video" | "audio";
    group: PublicModelGroup | null;
};

export type AdminModel = PublicModel & {
    providerId: string;
    providerDisplayName: string;
    adapter: "openai-compatible" | "sub2api";
    endpoint: string;
    providerModel: string;
    providerEnabled: boolean;
    enabled: boolean;
    secretRefConfigured: boolean;
    groupId: string | null;
    revision: number;
    createdAt: Date;
    updatedAt: Date;
};

export type AdminProvider = {
    id: string;
    displayName: string;
    adapter: "openai-compatible" | "sub2api";
    endpoint: string;
    enabled: boolean;
    revision: number;
    credentialConfigured: boolean;
    createdAt: Date;
    updatedAt: Date;
};

function safeEndpoint(value: string): string {
    try {
        const endpoint = new URL(value);
        // Keep valid stored bindings byte-for-byte: URL.toString() adds a slash to
        // bare hosts, which would turn a metadata-only edit into a target change.
        if (endpoint.protocol === "https:" && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash) return value;
        endpoint.username = "";
        endpoint.password = "";
        endpoint.search = "";
        endpoint.hash = "";
        return endpoint.toString();
    } catch {
        // Invalid provider configuration remains visible to an administrator
        // without echoing arbitrary text that could contain credentials.
        return "[invalid endpoint]";
    }
}

/** Only enabled providers and entries become selectable by normal users. */
export async function listPublicModels(db: Database): Promise<PublicModel[]> {
    const groups = await listNodeModelGroups(db);
    const rows = await db
        .select({
            id: modelCatalog.publicId,
            displayName: modelCatalog.displayName,
            capability: modelCatalog.capability,
            groupId: modelCatalog.groupId,
        })
        .from(modelCatalog)
        .innerJoin(modelProvider, eq(modelCatalog.providerId, modelProvider.id))
        .innerJoin(modelProviderCredential, eq(modelProviderCredential.providerId, modelProvider.id))
        .where(and(eq(modelCatalog.enabled, true), eq(modelProvider.enabled, true)))
        .orderBy(asc(modelCatalog.capability), asc(modelCatalog.displayName), asc(modelCatalog.publicId));
    return rows.map(({ groupId, ...row }) => ({ ...row, group: publicGroup(groups, row.capability, groupId) }));
}

function publicGroup(groups: NodeModelGroups[], capability: PublicModel["capability"], id: string | null): PublicModelGroup | null {
    const entries = groups.find(item => item.capability === capability)?.groups ?? [], order = entries.findIndex(item => item.id === id);
    return order === -1 ? null : { ...entries[order], order };
}

/** Admin projection includes endpoint and provider model id but never a secret value. */
export async function listAdminModels(db: Database): Promise<AdminModel[]> {
    const groups = await listNodeModelGroups(db);
    const rows = await db
        .select({
            id: modelCatalog.publicId,
            displayName: modelCatalog.displayName,
            capability: modelCatalog.capability,
            groupId: modelCatalog.groupId,
            revision: modelCatalog.revision,
            providerId: modelProvider.id,
            providerDisplayName: modelProvider.displayName,
            adapter: modelProvider.adapter,
            endpoint: modelProvider.endpoint,
            providerModel: modelCatalog.providerModel,
            providerEnabled: modelProvider.enabled,
            enabled: modelCatalog.enabled,
            credentialConfigured: modelProviderCredential.providerId,
            createdAt: modelCatalog.createdAt,
            updatedAt: modelCatalog.updatedAt,
        })
        .from(modelCatalog)
        .innerJoin(modelProvider, eq(modelCatalog.providerId, modelProvider.id))
        .leftJoin(modelProviderCredential, eq(modelProviderCredential.providerId, modelProvider.id))
        .where(and(isNull(modelCatalog.deletedAt), isNull(modelProvider.deletedAt)))
        .orderBy(asc(modelCatalog.capability), asc(modelCatalog.displayName), asc(modelCatalog.publicId));
    return rows.map(({ credentialConfigured, ...row }) => ({ ...row, group: publicGroup(groups, row.capability, row.groupId), endpoint: safeEndpoint(row.endpoint), secretRefConfigured: Boolean(credentialConfigured) }));
}

/** Administrator-only provider projection; credential material is represented by a boolean only. */
export async function listAdminProviders(db: Database): Promise<AdminProvider[]> {
    const rows = await db.select({
        id: modelProvider.id,
        displayName: modelProvider.displayName,
        adapter: modelProvider.adapter,
        endpoint: modelProvider.endpoint,
        enabled: modelProvider.enabled,
        revision: modelProvider.revision,
        credentialConfigured: modelProviderCredential.providerId,
        createdAt: modelProvider.createdAt,
        updatedAt: modelProvider.updatedAt,
    }).from(modelProvider)
        .leftJoin(modelProviderCredential, eq(modelProviderCredential.providerId, modelProvider.id))
        .where(isNull(modelProvider.deletedAt))
        .orderBy(asc(modelProvider.displayName), asc(modelProvider.id));
    return rows.map((row) => ({ ...row, endpoint: safeEndpoint(row.endpoint), credentialConfigured: Boolean(row.credentialConfigured) })) as AdminProvider[];
}
