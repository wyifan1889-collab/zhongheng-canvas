import { createContext, useContext, useLayoutEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { isCreationMediaTarget } from "@/lib/creation-routes";
import type { CreationMediaKind, CreationMediaScope } from "@/stores/use-creation-media-launch";
import type { createCreationShortcutRegistry } from "./creation-shortcut-target";

export const CreationShortcutTargetContext = createContext<ReturnType<typeof createCreationShortcutRegistry> | null>(null);

export function useCreationShortcutTarget(options: {
    kind: CreationMediaKind; scope: CreationMediaScope; ready: boolean; watch: readonly unknown[]; onApply: (prompt: string) => void; enabled?: boolean;
}) {
    const registry = useContext(CreationShortcutTargetContext), location = useLocation();
    const latest = useRef({ options, location }); latest.current = { options, location };
    useLayoutEffect(() => {
        if (!registry || options.enabled === false) return;
        return registry.register(options.kind, {
            read: () => {
                const { options, location } = latest.current;
                return { scope: options.scope, locationKey: location.key, watch: options.watch,
                    ready: options.ready && isCreationMediaTarget(location.pathname, location.search, options.kind) };
            },
            apply: prompt => latest.current.options.onApply(prompt),
        });
    }, [registry, options.kind, options.scope.accountId, options.scope.epoch, options.enabled]);
}
