import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";

import { AppConfigPanel } from "@/components/layout/app-config-modal";
import { useConfigStore } from "@/stores/use-config-store";
import { isCreationUiRoute } from "@/components/creation/ui/context";

export default function ConfigPage() {
    const { t } = useTranslation();
    const configTab = useConfigStore(state => state.configTab), location = useLocation();
    const from = typeof location.state?.from === "string" ? location.state.from : "";
    const creationReturn = from.startsWith("/") && !from.startsWith("//") && isCreationUiRoute(from.split(/[?#]/)[0]) ? from : null;

    return (
        <main className="h-full overflow-y-auto bg-background">
            <div className="mx-auto max-w-4xl px-4 py-6 sm:px-8 sm:py-8">
                <div className="mb-6">
                    {creationReturn ? <Link to={creationReturn} state={location.state?.returnState} className="mb-3 inline-block text-sm text-primary">返回创作工作台</Link> : null}
                    <h1 className="text-xl font-semibold text-foreground">{t("config.title")}</h1>
                </div>
                <AppConfigPanel initialTab={creationReturn ? configTab : undefined} />
            </div>
        </main>
    );
}
