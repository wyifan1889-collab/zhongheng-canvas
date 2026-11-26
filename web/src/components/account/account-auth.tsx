import { useTranslation } from "react-i18next";
import { CreationUiContext } from "@/components/creation/ui/context";
import { AccountPanel } from "./account-panel";
import type { AccountReturn } from "@/services/saas/account-return";

export function AccountAuth({ link, onAuthenticated }: { link?: AccountReturn; onAuthenticated?: () => void }) {
    const { t } = useTranslation();
    return <CreationUiContext value>
        <section aria-label="平台账户" className="w-full max-w-[360px]">
            <div className="mb-7 flex items-center justify-center gap-2.5">
                <span aria-hidden className="size-8 shrink-0 bg-primary" style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }} />
                <span className="text-xl font-semibold">{t("meta.title")}</span>
            </div>
            <AccountPanel variant="auth" link={link} onAuthenticated={onAuthenticated} />
        </section>
    </CreationUiContext>;
}
