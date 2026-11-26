import { Drawer } from "antd";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools, navigationToolPath, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { AppSidebar } from "./app-sidebar";
import type { ReactNode } from "react";

type MobileNavDrawerProps = {
    open: boolean;
    activeToolSlug?: NavigationToolSlug;
    onClose: () => void;
    owned?: boolean;
    trigger?: ReactNode;
};

export function MobileNavDrawer({ open, activeToolSlug, onClose, owned = false, trigger }: MobileNavDrawerProps) {
    const { t } = useTranslation();

    if (owned) return <Sheet open={open} onOpenChange={next => { if (!next) onClose(); }}>
        {trigger ? <SheetTrigger asChild>{trigger}</SheetTrigger> : null}
        <SheetContent side="left" aria-describedby={undefined} className="z-[1400] w-[min(300px,calc(100vw-48px))]! gap-0 sm:hidden" data-canvas-shortcuts-ignore>
            <SheetHeader className="sr-only"><SheetTitle>{t("topNav.navigation")}</SheetTitle></SheetHeader>
            <div className="min-h-0 flex-1 overflow-hidden" onClick={event => { if ((event.target as HTMLElement).closest("a")) onClose(); }}><AppSidebar mobile /></div>
        </SheetContent>
    </Sheet>;

    return (
        <Drawer title={t("topNav.navigation")} placement="left" size={280} open={open} onClose={onClose} className="xl:hidden">
            <div className="space-y-1">
                {navigationTools.map((tool) => {
                    const Icon = tool.icon;
                    const active = tool.slug === activeToolSlug;
                    return (
                        <Link
                            key={tool.slug}
                            to={navigationToolPath(tool)}
                            onClick={onClose}
                            className={cn(
                                "flex items-center gap-3 rounded-lg px-3 py-3 text-base transition",
                                active ? "bg-stone-100 font-medium text-stone-950 dark:bg-stone-800 dark:text-stone-100" : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-stone-800 dark:hover:text-stone-100",
                            )}
                        >
                            <Icon className="size-5" />
                            <span>{t(`navigation.${tool.slug}`)}</span>
                        </Link>
                    );
                })}
            </div>
        </Drawer>
    );
}
