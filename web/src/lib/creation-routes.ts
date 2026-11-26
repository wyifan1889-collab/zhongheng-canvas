export const creationModes = ["image", "video", "audio", "agent"] as const;
export type CreationMode = (typeof creationModes)[number];
type LocationParts = { search: string; hash: string };

function explicitMode(search: string): CreationMode | null {
    const values = new URLSearchParams(search).getAll("mode");
    return values.length === 1 && creationModes.includes(values[0] as CreationMode) ? values[0] as CreationMode : null;
}

export const creationModeFromSearch = (search: string): CreationMode => explicitMode(search) ?? "image";
export const creationPath = (mode: CreationMode) => `/create?mode=${mode}`;
const imageConversationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const validImageConversationId = (id: string | null): id is string => !!id && imageConversationId.test(id);
export const imageConversationPath = (id: string) => `/create?mode=image&session=${encodeURIComponent(id)}`;
export const isImageConversationPath = (route: string) => {
    const prefix = "/create?mode=image&session=";
    return route.startsWith(prefix) && validImageConversationId(route.slice(prefix.length));
};

/** Mode navigation changes only its own query key; receipt/query/hash stay intact. */
export function creationModeTarget(mode: CreationMode, location: LocationParts) {
    const query = new URLSearchParams(location.search);
    query.set("mode", mode);
    return { pathname: "/create", search: `?${query}`, hash: location.hash };
}

export function legacyCreationTarget(location: LocationParts, mode?: CreationMode) {
    if (mode) return creationModeTarget(mode, location);
    const query = new URLSearchParams(location.search);
    if (!query.has("mode")) query.set("mode", "image");
    return { pathname: "/create", search: `?${query}`, hash: location.hash };
}

/** A staged action belongs only to its legacy bridge or the matching real mode. */
export function isCreationMediaTarget(pathname: string, search: string, kind: "image" | "video" | "audio") {
    return pathname === `/${kind}` || pathname === "/create" && (explicitMode(search) === kind || !new URLSearchParams(search).has("mode") && kind === "image");
}

export const isAgentCreationOrigin = (pathname: string, search = "") => pathname === "/" || pathname === "/create" && explicitMode(search) === "agent";

/** History DTOs have a media type, but no trustworthy original canvas location. */
export function historyCreationTarget(type: string | null | undefined) {
    return type === "image" || type === "video" || type === "audio" ? creationPath(type) : null;
}
