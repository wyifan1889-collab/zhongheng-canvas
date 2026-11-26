import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import { RequireAccount } from "@/components/account/require-account";
import { LegacyCreationRedirect } from "@/components/creation/legacy-creation-redirect";
import { Button } from "@/components/ui/button";
import UserLayout from "@/layouts/user-layout";
import AssetsPage from "@/pages/assets";
import AudioPage from "@/pages/audio";
import AccountPage from "@/pages/account";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import CanvasJoinPage from "@/pages/canvas/join";
import ConfigPage from "@/pages/config";
import GenerationHistoryPage from "@/pages/generation-history";
import HomePage from "@/pages/home";
import DramaPage from "@/pages/drama";
import InspirationPage from "@/pages/inspiration";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";

function AdminUnavailable() {
    const { t } = useTranslation();
    return <main className="space-y-3 p-6">
        <p role="alert" className="text-sm">{t("adminRoute.loadFailed")}</p>
        <Button type="button" variant="outline" onClick={() => window.location.reload()}>{t("adminRoute.reload")}</Button>
    </main>;
}

const AdminPage = lazy(() => import("@/pages/admin").catch(() => ({ default: AdminUnavailable })));

function AdminRoute() {
    const { t } = useTranslation();
    return <Suspense fallback={<p role="status" className="p-6 text-sm text-muted-foreground">{t("adminRoute.loading")}</p>}><AdminPage /></Suspense>;
}

function ProtectedLayout() {
    return (
        <RequireAccount>
            <Outlet />
        </RequireAccount>
    );
}

export const router = createBrowserRouter([
    { path: "/login", element: <AccountPage /> },
    { path: "/account", element: <AccountPage /> },
    { path: "/reset-password", element: <AccountPage /> },
    {
        element: (
            <UserLayout>
                <AnalyticsTracker />
                <Outlet />
            </UserLayout>
        ),
        children: [
            { path: "/", element: <LegacyCreationRedirect /> },
            { path: "/create", element: <HomePage /> },
            { path: "/image", element: <LegacyCreationRedirect mode="image" /> },
            { path: "/video", element: <LegacyCreationRedirect mode="video" /> },
            { path: "/audio", element: <LegacyCreationRedirect mode="audio" /> },
            { path: "/drama", element: <DramaPage /> },
            { path: "/inspiration", element: <InspirationPage /> },
            {
                element: <ProtectedLayout />,
                children: [
                    { path: "/music", element: <AudioPage music /> },
                    { path: "/generation/history", element: <GenerationHistoryPage /> },
                    { path: "/assets", element: <AssetsPage /> },
                    { path: "/prompts", element: <PromptsPage /> },
                    { path: "/canvas", element: <CanvasPage /> },
                    { path: "/projects", element: <CanvasPage /> },
                    { path: "/canvas/join/:token", element: <CanvasJoinPage /> },
                    { path: "/canvas/:id", element: <CanvasProjectPage /> },
                    { path: "/config", element: <ConfigPage /> },
                    { path: "/admin", element: <AdminRoute /> },
                ],
            },
        ],
    },
    { path: "*", element: <NotFound /> },
]);
