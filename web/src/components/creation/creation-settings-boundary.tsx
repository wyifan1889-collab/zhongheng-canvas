import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useConfigStore } from "@/stores/use-config-store";

/** Preserve the creation workspace's settings return path and pending intent. */
export function CreationSettingsBoundary() {
    const open = useConfigStore(state => state.isConfigOpen), close = useConfigStore(state => state.setConfigDialogOpen);
    const location = useLocation(), navigate = useNavigate();
    useEffect(() => {
        if (!open) return;
        close(false);
        navigate("/config", { state: { from: `${location.pathname}${location.search}${location.hash}`, returnState: location.state } });
    }, [open, close, navigate, location.pathname, location.search, location.hash, location.state]);
    return null;
}
