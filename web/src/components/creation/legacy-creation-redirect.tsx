import { Navigate, useLocation } from "react-router-dom";
import { legacyCreationTarget, type CreationMode } from "@/lib/creation-routes";

export function LegacyCreationRedirect({ mode }: { mode?: CreationMode }) {
    const location = useLocation();
    return <Navigate replace to={legacyCreationTarget(location, mode)} state={location.state} />;
}
