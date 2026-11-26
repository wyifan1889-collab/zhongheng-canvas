import { useEffect, useRef, useState } from "react";
import { Alert, Button, Spin } from "antd";
import { Link, useNavigate, useParams } from "react-router-dom";

import { useAccountStore } from "@/stores/use-account-store";
import { CanvasSharingError, createCanvasSharingClient } from "@/services/saas/canvas-sharing";

/** Joining uses the logged-in principal. The invitation is never a document credential. */
export default function CanvasJoinPage() {
    const { token = "" } = useParams<{ token: string }>();
    const navigate = useNavigate();
    const account = useAccountStore();
    const scope = account.getDraftScope();
    const key = JSON.stringify([token, scope?.accountId, scope?.epoch]);
    const attempted = useRef<{ key: string; promise: ReturnType<ReturnType<typeof createCanvasSharingClient>["join"]> } | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [retry, setRetry] = useState(0);

    useEffect(() => {
        if (!scope || account.site?.cloudCanvas !== true) return;
        // React StrictMode may replay an effect; attach to one accepted join promise.
        const currentKey = `${key}:${retry}`;
        let active = true;
        setError(null);
        if (attempted.current?.key !== currentKey) {
            const client = createCanvasSharingClient(() => useAccountStore.getState().getDraftScope());
            attempted.current = { key: currentKey, promise: client.join(token) };
        }
        void attempted.current.promise.then((member) => {
            if (active) navigate(`/canvas/${member.canvasId}`, { replace: true });
        }).catch((caught: unknown) => {
            if (active) setError(caught instanceof CanvasSharingError ? caught.message : "加入结果暂未确认，请检查连接后再试。");
        });
        return () => { active = false; };
    }, [key, retry, account.site?.cloudCanvas, navigate]);

    return <main className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-5 p-6">
        <h1 className="text-xl font-medium">加入共享画布</h1>
        {account.site?.cloudCanvas !== true ? <Alert showIcon type="info" title="云端画布暂未开放" />
            : error ? <><Alert showIcon type="warning" title="暂时无法打开共享画布" description={error} />
                <Button onClick={() => setRetry((value) => value + 1)}>重新确认加入</Button></>
            : <div className="flex items-center gap-3 text-sm"><Spin size="small" /><span>正在确认邀请并打开画布…</span></div>}
        <Link to="/projects" className="text-sm text-muted-foreground">返回我的画布</Link>
    </main>;
}
