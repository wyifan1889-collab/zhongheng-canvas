import { cloneElement, useCallback, useEffect, useId, useState, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { Form, Popconfirm, Segmented, Typography as AntTypography, type FormItemProps, type FormProps } from "antd";
import { Eye, EyeOff } from "lucide-react";
import { Link } from "react-router-dom";
import { Alert, App, Button, Input, Tag, Typography } from "@/components/creation/ui";
import { useCreationUi } from "@/components/creation/ui/context";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button as UiButton } from "@/components/ui/button";

import { Turnstile } from "./turnstile";
import { AccountError, type AccountCommand } from "@/services/saas/account";
import { clearAccountReturn, type AccountReturn } from "@/services/saas/account-return";
import { useAccountStore } from "@/stores/use-account-store";
import { PlatformOverview } from "./platform-overview";

type Mode = "login" | "signup" | "forgot" | "resend" | "verify" | "reset";
type Fields = { name: string; email: string; password: string; newPassword: string; confirmPassword: string; otp: string };
const titles: Record<Mode, string> = { login: "登录", signup: "注册", forgot: "找回密码", resend: "重发验证码", verify: "验证邮箱", reset: "设置新密码" };
const passwordRules = [
    { required: true, message: "请输入密码" },
    { min: 8, max: 128, message: "密码长度需为 8–128 个字符" },
];

// Keep the existing form store, validation rules and submission contract. Only
// its presentation becomes native labels and shadcn inputs in the owned UI.
function AccountFieldControl({ label, compact, children, ...control }: { label: ReactNode; compact?: boolean; children: ReactElement; id?: string; value?: unknown }) {
    const { status, errors } = Form.Item.useStatus();
    const errorId = `${control.id}-error`;
    return <div className={compact ? "mb-3 space-y-1.5" : "mb-4 space-y-1.5"}>
        <label htmlFor={control.id} className={compact ? "sr-only" : "block text-sm font-medium"}>{label}</label>
        {cloneElement(children as ReactElement<Record<string, unknown>>, { ...control, value: control.value ?? "", "aria-invalid": status === "error" || undefined, "aria-describedby": errors.length ? errorId : undefined })}
        {errors.length ? <div id={errorId} role="alert" className="space-y-1 text-sm text-destructive">{errors.map((error, index) => <div key={index}>{error}</div>)}</div> : null}
    </div>;
}

function AccountField({ label, compact, children, ...props }: FormItemProps & { compact?: boolean }) {
    const owned = useCreationUi(), id = useId();
    if (!owned) return <Form.Item {...props} label={label}>{children}</Form.Item>;
    if (props.name === undefined) return <div className="mb-4 space-y-1.5"><label htmlFor={id} className={compact ? "sr-only" : "block text-sm font-medium"}>{label}</label>{cloneElement(children as ReactElement<Record<string, unknown>>, { id })}</div>;
    return <Form.Item {...props} noStyle><AccountFieldControl label={label} compact={compact}>{children as ReactElement}</AccountFieldControl></Form.Item>;
}

function AccountPasswordInput({ compact, ...props }: ComponentProps<typeof Input.Password> & { compact?: boolean }) {
    const [visible, setVisible] = useState(false);
    if (!compact) return <Input.Password {...props} />;
    const title = visible ? "隐藏密码" : "显示密码";
    return <div className="relative">
        <Input {...props} type={visible ? "text" : "password"} className="h-12 px-3.5 pr-12" />
        <button type="button" aria-label={title} title={title} disabled={props.disabled} onClick={() => setVisible(!visible)} className="absolute inset-y-0 right-1 flex w-10 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
    </div>;
}

type AccountFormProps = Omit<FormProps<Fields>, "children"> & { children?: ReactNode };

function AccountForm(props: AccountFormProps) {
    const owned = useCreationUi();
    if (!owned) return <Form {...props} />;
    return <Form {...props} component={false}><form noValidate onSubmit={event => { event.preventDefault(); props.form?.submit(); }}>
        <fieldset disabled={props.disabled} className="m-0 min-w-0 border-0 p-0">{props.children}</fieldset>
    </form></Form>;
}

function AccountModeTabs({ mode, busy, onChange, children, compact }: { mode: Mode; busy: boolean; onChange: (value: Mode) => void; children: ReactNode; compact?: boolean }) {
    const owned = useCreationUi(), selected = mode === "signup" ? "signup" : "login";
    if (compact || mode === "reset" || mode === "verify") return <>{children}</>;
    if (!owned) return <><Segmented block value={selected} disabled={busy} options={[{ label: "登录", value: "login" }, { label: "注册", value: "signup" }]} onChange={value => onChange(value as Mode)} />{children}</>;
    return <Tabs value={selected} onValueChange={value => onChange(value as Mode)}>
        <TabsList className="w-full" aria-label="账户操作"><TabsTrigger value="login" disabled={busy}>登录</TabsTrigger><TabsTrigger value="signup" disabled={busy}>注册</TabsTrigger></TabsList>
        <TabsContent value={selected} className="space-y-3">{children}</TabsContent>
    </Tabs>;
}

export function AccountPanel({ link, onAuthenticated, variant = "default" }: { link?: AccountReturn; onAuthenticated?: () => void; variant?: "default" | "auth" | "security" }) {
    const owned = useCreationUi(), { modal } = App.useApp();
    const compact = owned && variant === "auth";
    const security = owned && variant === "security";
    const { status, site, user, error, busy, initialize, refresh, submit } = useAccountStore();
    const [form] = Form.useForm<Fields>();
    const [mode, setMode] = useState<Mode>(link?.resetToken && !link.invalidLink ? "reset" : "login");
    const [notice, setNotice] = useState<{ type: "error" | "success" | "info"; text: string } | null>(
        link?.invalidLink ? { type: "error", text: "邮件链接信息缺失、无效或已过期。请重新打开邮件中的原链接，或重新申请对应邮件。" } : null,
    );
    const [captcha, setCaptcha] = useState("");
    const [challenge, setChallenge] = useState(0);
    const [pendingEmail, setPendingEmail] = useState<string | null>(null);
    const onToken = useCallback((token: string) => setCaptcha(token), []);
    const canUse = status === "ready" && Boolean(site?.captcha);
    const needsCaptcha = mode !== "reset" && mode !== "verify";

    useEffect(() => { void initialize(); }, [initialize]);

    function changeMode(next: Mode) {
        if (busy) return;
        form.setFieldsValue({ password: "", newPassword: "", confirmPassword: "", otp: "" });
        setNotice(null);
        setCaptcha("");
        if (next !== "verify") setPendingEmail(null);
        setChallenge((value) => value + 1);
        setMode(next);
    }
    async function onFinish(values: Fields) {
        const command: AccountCommand = mode === "signup"
            ? { action: "sign-up/email", name: values.name, email: values.email, password: values.password, captcha }
            : mode === "forgot" ? { action: "request-password-reset", email: values.email, captcha }
            : mode === "resend" ? { action: "send-email-otp", email: values.email, captcha }
            : mode === "verify" ? { action: "verify-email-otp", email: pendingEmail ?? "", otp: values.otp }
            : mode === "reset" ? { action: "reset-password", token: link?.resetToken ?? "", newPassword: values.newPassword }
            : { action: "sign-in/email", email: values.email, password: values.password, captcha };
        setNotice(null);
        try {
            await submit(command);
            form.setFieldsValue({ password: "", newPassword: "", confirmPassword: "", otp: "" });
            const text = mode === "login" ? "登录成功，已确认服务端会话。画布仍为本地保存。"
                : mode === "reset" ? "密码已重置，旧会话已失效，请使用新密码登录。"
                : mode === "verify" ? "邮箱已验证，请使用密码登录。"
                : mode === "signup" || mode === "resend" ? "验证码已发送，请输入邮件中的 6 位验证码完成验证。"
                : "邮件申请已受理。如果该邮箱符合发送条件，请查收邮件；未收到可稍后重新申请。";
            setNotice({ type: "success", text });
            if (mode === "signup" || mode === "resend") {
                setPendingEmail(values.email.trim());
                setMode("verify");
            }
            if (mode === "verify") {
                const verifiedEmail = pendingEmail?.trim() ?? "";
                setPendingEmail(null);
                setMode("login");
                form.setFieldsValue({ email: verifiedEmail });
                setNotice({ type: "success", text: "邮箱已验证，请输入密码登录。" });
            }
            if (mode === "reset") { clearAccountReturn(); setMode("login"); }
            if (mode === "login") onAuthenticated?.();
        } catch (failure) {
            setNotice({ type: "error", text: failure instanceof AccountError ? failure.message : "账户操作未完成，请检查连接后重试。" });
        } finally {
            setCaptcha("");
            setChallenge((value) => value + 1);
        }
    }
    async function signOut() {
        setNotice(null);
        try {
            await submit({ action: "sign-out" });
            form.resetFields();
            setMode("login");
            setNotice({ type: "success", text: "已退出当前账户。本机画布没有上传、迁移或删除。" });
        } catch (failure) {
            setNotice({ type: "error", text: failure instanceof AccountError ? failure.message : "尚未确认退出，请重新检查账户连接。" });
        }
    }
    async function revokeSessions() {
        setNotice(null);
        try {
            await submit({ action: "revoke-sessions" });
            form.resetFields();
            setMode("login");
            setNotice({ type: "success", text: "已退出所有设备。本机画布和草稿没有上传、迁移或删除。" });
        } catch (failure) {
            setNotice({ type: "error", text: failure instanceof AccountError ? failure.message : "尚未确认退出所有设备，请重新检查账户连接。" });
        }
    }

    return (
        <div className="flex flex-col gap-3" data-canvas-shortcuts-ignore onKeyDown={(event) => event.stopPropagation()}>
            {compact ? <h1 className="mb-5 mt-0 text-center text-2xl font-semibold">{user && mode !== "reset" ? "你已登录" : mode === "login" ? "欢迎登录" : mode === "signup" ? "创建账户" : titles[mode]}</h1> : <>
            {!security && <Alert type="info" showIcon title={site?.cloudCanvas ? "账户已接入 · 云画布已开放" : "账户接入阶段 · 画布仍在本机"}
                description={site?.cloudCanvas ? "云端画布按账号保存；本机作品仍需手动保存，不会自动迁移。" : "作品仍保存在本机，不会随账号隔离或云同步；请勿用于公用设备或公众运营。"} />}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <Typography.Text type="secondary">
                    {status === "idle" || status === "loading" ? "正在检查账户连接…" : status === "unavailable" ? "账户服务未接通" : !site?.captcha ? "账户服务未开放" : user ? `当前账户：${user.name}` : "账户服务已连接，尚未登录"}
                </Typography.Text>
                {user ? <Tag color={user.role === "admin" ? "gold" : "default"}>{user.role === "admin" ? "超级管理员" : "普通用户"}</Tag> : null}
                <Button size="small" loading={status === "loading"} disabled={busy} onClick={() => { setNotice(null); void refresh(); }}>重新检查</Button>
            </div>
            </>}
            {compact && (status === "idle" || status === "loading") && <p role="status" className="m-0 text-center text-sm text-muted-foreground">正在连接账户服务…</p>}
            {error && <Alert type="warning" showIcon title={error} action={compact ? <Button type="link" size="small" disabled={busy} onClick={() => { setNotice(null); void refresh(); }}>重新连接</Button> : undefined} />}
            {status === "ready" && !site?.captcha && <Alert type="warning" showIcon title="管理员尚未启用账户服务，当前不能注册或登录。" />}
            {notice && <div aria-live="polite"><Alert type={notice.type} showIcon title={notice.text} /></div>}
            {busy && <Typography.Paragraph type="secondary">{compact ? "正在处理，请稍候…" : "账户操作正在等待服务端回应。关闭窗口不会撤销已发送的请求，可重新打开查看状态。"}</Typography.Paragraph>}
            {user && mode !== "reset" ? (
                compact ? <div className="space-y-4 text-center">
                    <p className="break-words text-sm text-muted-foreground">{user.name}</p>
                    <Button block type="primary" className="h-12 text-base" disabled={busy} onClick={onAuthenticated}>继续</Button>
                    <UiButton asChild variant="link"><Link to="/account">管理账户</Link></UiButton>
                </div> :
                <div className="flex min-w-0 flex-col gap-3">
                    {security ? <dl className="my-2 divide-y divide-border text-sm">
                        <div className="grid gap-2 py-4 sm:grid-cols-[100px_minmax(0,1fr)]"><dt className="text-muted-foreground">昵称</dt><dd className="m-0 break-words">{user.name}</dd></div>
                        <div className="grid gap-2 py-4 sm:grid-cols-[100px_minmax(0,1fr)]"><dt className="text-muted-foreground">邮箱</dt><dd className="m-0 break-all">{user.email ?? "未提供邮箱"}</dd></div>
                    </dl> : <><Typography.Text>账户身份已由服务端确认。平台模型和余额会从服务端读取，供应商密钥不会下发到浏览器。</Typography.Text><PlatformOverview /></>}
                    <div className="flex flex-wrap gap-2">
                        {user.role === "admin" && (owned ? <UiButton asChild variant="outline"><a href="/admin">打开管理后台</a></UiButton> : <Button href="/admin">打开管理后台</Button>)}
                        <Button onClick={() => void signOut()} loading={busy}>退出登录</Button>
                        {owned ? <Button danger loading={busy} onClick={() => modal.confirm({
                            title: "退出所有设备？", content: "当前页面也会退出；本机画布和草稿不会删除。",
                            okText: "退出所有设备", cancelText: "取消", okType: "danger", onOk: () => revokeSessions(),
                        })}>退出所有设备</Button> : <Popconfirm
                            title="退出所有设备？"
                            description="当前页面也会退出；本机画布和草稿不会删除。"
                            okText="退出所有设备"
                            cancelText="取消"
                            okButtonProps={{ danger: true }}
                            onConfirm={() => void revokeSessions()}
                        >
                            <Button danger loading={busy}>退出所有设备</Button>
                        </Popconfirm>}
                    </div>
                </div>
            ) : (
                <AccountModeTabs mode={mode} busy={busy} onChange={changeMode} compact={compact}>
                    {!compact && (owned ? <h2 className="m-0 text-base font-semibold">{titles[mode]}</h2> : <AntTypography.Title level={5} className="!my-0">{titles[mode]}</AntTypography.Title>)}
                    {mode === "signup" && canUse && !site?.registration && <Alert type="warning" title="当前注册已关闭，已有账户仍可登录。" />}
                    <AccountForm form={form} layout="vertical" preserve={false} disabled={!canUse || busy} onFinish={onFinish}
                        onValuesChange={() => setNotice(null)} requiredMark={false}>
                        {mode === "signup" && <AccountField compact={compact} label="昵称" name="name" rules={[{ required: true, whitespace: true, message: "请输入昵称" }]}>
                            <Input autoComplete="nickname" placeholder={compact ? "昵称" : undefined} className={compact ? "h-12 px-3.5" : undefined} />
                        </AccountField>}
                        {mode === "verify" && <AccountField compact={compact} label="待验证邮箱"><Input value={pendingEmail ?? ""} className={compact ? "h-12 px-3.5" : undefined} disabled /></AccountField>}
                        {mode !== "reset" && mode !== "verify" && <AccountField compact={compact} label="邮箱" name="email" preserve rules={[{ required: true, message: "请输入邮箱" }, { type: "email", message: "请输入有效邮箱" }]}>
                            <Input type="email" autoComplete="email" placeholder={compact ? "请输入邮箱" : undefined} className={compact ? "h-12 px-3.5" : undefined} />
                        </AccountField>}
                        {(mode === "login" || mode === "signup") && <AccountField compact={compact} label="密码" name="password" rules={passwordRules}>
                            <AccountPasswordInput compact={compact} autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder={compact ? mode === "signup" ? "设置密码（8–128 个字符）" : "请输入密码" : undefined} />
                        </AccountField>}
                        {mode === "reset" && <>
                            <AccountField compact={compact} label="新密码" name="newPassword" rules={[{ required: true, message: "请输入新密码" }, { min: 8, max: 128, message: "密码长度需为 8–128 个字符" }]}>
                                <AccountPasswordInput compact={compact} autoComplete="new-password" placeholder={compact ? "新密码（8–128 个字符）" : undefined} />
                            </AccountField>
                            <AccountField compact={compact} label="确认新密码" name="confirmPassword" dependencies={["newPassword"]} rules={[
                                { required: true, message: "请再次输入新密码" },
                                ({ getFieldValue }) => ({ validator: (_, value) => !value || value === getFieldValue("newPassword") ? Promise.resolve() : Promise.reject(new Error("两次输入的密码不一致")) }),
                            ]}><AccountPasswordInput compact={compact} autoComplete="new-password" placeholder={compact ? "再次输入新密码" : undefined} /></AccountField>
                        </>}
                        {mode === "verify" && <AccountField compact={compact} label="邮箱验证码" name="otp" rules={[{ required: true, message: "请输入邮件中的 6 位验证码" }, { pattern: /^\d{6}$/, message: "验证码必须是 6 位数字" }]}>
                            <Input inputMode="numeric" maxLength={6} autoComplete="one-time-code" placeholder={compact ? "6 位邮箱验证码" : undefined} className={compact ? "h-12 px-3.5" : undefined} />
                        </AccountField>}
                        {canUse && site?.captcha && needsCaptcha && <Turnstile key={challenge} siteKey={site.captcha.siteKey} onToken={onToken} compact={compact} />}
                        <Button block type="primary" htmlType="submit" loading={busy} className={compact ? "h-12 text-base" : undefined}
                            disabled={!canUse || (needsCaptcha && !captcha) || (mode === "signup" && !site?.registration) || (mode === "reset" && !link?.resetToken)}>
                            {mode === "forgot" ? "申请密码重置邮件" : mode === "resend" ? "重新发送验证码" : titles[mode]}
                        </Button>
                    </AccountForm>
                    {compact ? <div className="mt-3 space-y-4 text-center text-sm text-muted-foreground">
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                            <Button type="link" size="small" className="px-0 text-xs text-muted-foreground" disabled={busy} onClick={() => changeMode("forgot")}>忘记密码</Button>
                            {mode !== "resend" && <Button type="link" size="small" className="px-0 text-xs text-muted-foreground" disabled={busy} onClick={() => changeMode("resend")}>未收到验证邮件</Button>}
                        </div>
                        <div>{mode === "login" ? <>还没有账号？<Button type="link" className="px-1 text-foreground" disabled={busy} onClick={() => changeMode("signup")}>注册</Button></> : <Button type="link" className="text-foreground" disabled={busy} onClick={() => changeMode("login")}>{mode === "signup" ? "已有账号？登录" : "返回登录"}</Button>}</div>
                    </div> : <div className="flex flex-wrap gap-x-3 gap-y-1">
                        {mode !== "login" && <Button size="small" type="link" disabled={busy} onClick={() => changeMode("login")}>返回登录</Button>}
                        <Button size="small" type="link" disabled={busy} onClick={() => changeMode("forgot")}>忘记密码</Button>
                        <Button size="small" type="link" disabled={busy} onClick={() => changeMode("resend")}>未收到验证邮件</Button>
                    </div>}
                </AccountModeTabs>
            )}
        </div>
    );
}
