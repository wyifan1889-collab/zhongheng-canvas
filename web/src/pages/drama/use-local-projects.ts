import { useEffect, useRef, useState } from "react";

import { useAccountStore } from "@/stores/use-account-store";
import { captureDramaProjects, sameDramaScope, type DramaProject } from "./local-projects";

type Operation = ReturnType<typeof captureDramaProjects>;
type State = { operation: Operation | null; projects: DramaProject[]; loading: boolean; ready: boolean; saving: boolean; error: string };

export function useLocalDramaProjects() {
    const account = useAccountStore();
    const scope = account.getDraftScope();
    const [revision, setRevision] = useState(0);
    const [state, setState] = useState<State>({ operation: null, projects: [], loading: false, ready: false, saving: false, error: "" });
    const submitted = useRef(false);
    const activeOperation = useRef<Operation | null>(null);

    useEffect(() => {
        let active = true;
        submitted.current = false;
        activeOperation.current = null;
        if (!scope) {
            setState({ operation: null, projects: [], loading: false, ready: false, saving: false, error: "" });
            return;
        }
        setState({ operation: null, projects: [], loading: true, ready: false, saving: false, error: "" });
        void (async () => {
            try {
                const operation = captureDramaProjects(() => active);
                activeOperation.current = operation;
                setState(previous => ({ ...previous, operation }));
                const projects = await operation.read();
                if (active && operation.isCurrent()) setState({ operation, projects, loading: false, ready: true, saving: false, error: "" });
            } catch {
                if (active) setState(previous => ({ ...previous, loading: false, ready: false, error: "本机项目读取失败或数据损坏，已有数据未改动。请保留浏览器数据后重新读取。" }));
            }
        })();
        return () => { active = false; activeOperation.current = null; };
    }, [scope?.accountId, scope?.epoch, revision]);

    const current = sameDramaScope(state.operation?.scope ?? null, scope);
    return {
        projects: current ? state.projects : [], loading: !!scope && (state.loading || !current && !state.error),
        ready: current && state.ready, saving: current && state.saving, error: scope ? state.error : "",
        scopeKey: scope ? JSON.stringify([scope.accountId, scope.epoch]) : "",
        reload: () => { if (!submitted.current) setRevision(value => value + 1); },
        async create(name: string, onCreated: (project: DramaProject) => void) {
            const operation = state.operation;
            if (submitted.current || !state.ready || activeOperation.current !== operation || !operation?.isCurrent() || !name.trim()) return;
            submitted.current = true;
            setState(previous => ({ ...previous, saving: true, error: "" }));
            const isCurrent = () => activeOperation.current === operation && operation.isCurrent();
            try {
                const result = await operation.create(name);
                if (!isCurrent()) return;
                setState(previous => ({ ...previous, projects: result.projects, saving: false }));
                onCreated(result.project);
            } catch {
                if (isCurrent()) setState(previous => ({ ...previous, saving: false, ready: false, error: "创建结果未确认，项目名称已保留。请先重新读取本机项目，确认结果后再创建。" }));
            } finally { if (isCurrent()) submitted.current = false; }
        },
    };
}
