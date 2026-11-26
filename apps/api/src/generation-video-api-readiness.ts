import type { VideoRuntimePolicy } from "./generation-video-config";
import { inspectVideoToolchainReadOnly, type VideoToolchainIdentity } from "./generation-video-probe";
import { checkVideoDatabaseReadiness, type RelationQuery } from "./readiness";

/** Queue readiness cannot prove that all consumers understand the video task contract. */
export function createVideoApiReadiness(options: {
    database: RelationQuery;
    policy: VideoRuntimePolicy;
    toolchainIdentity: VideoToolchainIdentity | null;
    compatibleConsumers?: () => Promise<boolean>;
    inspectTools?: typeof inspectVideoToolchainReadOnly;
    checkDatabase?: typeof checkVideoDatabaseReadiness;
}) {
    return async () => {
        try {
            if (!options.toolchainIdentity || !options.compatibleConsumers || !await options.compatibleConsumers()) return false;
            if (!await (options.checkDatabase ?? checkVideoDatabaseReadiness)(options.database)) return false;
            return (await (options.inspectTools ?? inspectVideoToolchainReadOnly)(options.policy, options.toolchainIdentity)).ready;
        } catch { return false; }
    };
}
