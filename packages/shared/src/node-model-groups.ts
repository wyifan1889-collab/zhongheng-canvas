import type { PricingCapability } from "./model-pricing-drafts";

export const NODE_MODEL_GROUP_CAPABILITIES = ["text", "image", "video", "audio"] as const satisfies readonly PricingCapability[];

/** Display groups are independent from provider identity and published price rules. */
export type NodeModelGroup = { id: string; name: string };
export type NodeModelGroups = { capability: PricingCapability; version: number; groups: NodeModelGroup[] };
export type NodeModelGroupsWrite = Omit<NodeModelGroups, "version"> & { expectedVersion: number };
export type PublicModelGroup = NodeModelGroup & { order: number };

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) => Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
export function parseNodeModelGroupsWrite(value: unknown): NodeModelGroupsWrite | null {
    if (!object(value) || !exact(value, ["capability", "expectedVersion", "groups"]) ||
        !Number.isSafeInteger(value.expectedVersion) ||
        (value.expectedVersion as number) < 0 || (value.expectedVersion as number) >= 2_147_483_647 || !Array.isArray(value.groups)) return null;
    const capability = NODE_MODEL_GROUP_CAPABILITIES.find(entry => entry === value.capability);
    if (!capability) return null;
    const ids = new Set<string>(), names = new Set<string>(), groups: NodeModelGroup[] = [];
    for (const item of value.groups) {
        if (!object(item) || !exact(item, ["id", "name"]) || typeof item.id !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id) ||
            typeof item.name !== "string" || !item.name || item.name.trim() !== item.name || item.name.length > 120 || /[\u0000-\u001f\u007f]/.test(item.name)) return null;
        const id = item.id.toLowerCase(), nameKey = item.name.toLowerCase();
        if (ids.has(id) || names.has(nameKey)) return null;
        ids.add(id); names.add(nameKey); groups.push({ id, name: item.name });
    }
    return { capability, expectedVersion: value.expectedVersion as number, groups };
}

export function parseNodeModelGroups(value: unknown): NodeModelGroups | null {
    if (!object(value) || !exact(value, ["capability", "version", "groups"]) || !Number.isSafeInteger(value.version) ||
        (value.version as number) < 0 || (value.version as number) > 2_147_483_647) return null;
    const parsed = parseNodeModelGroupsWrite({ capability: value.capability, expectedVersion: 0, groups: value.groups });
    return parsed ? { capability: parsed.capability, version: value.version as number, groups: parsed.groups } : null;
}
