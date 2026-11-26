import { useEffect, useState, type ReactNode } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "antd";
import { useTranslation } from "react-i18next";

import { ImageSettingsPanel, imageQualityLabel, imageSizeLabel } from "@/components/image-settings-panel";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { AiConfig } from "@/stores/use-config-store";

type CanvasImageSettingsPopoverProps = {
    config: AiConfig;
    onConfigChange?: (key: keyof AiConfig, value: string) => void;
    summary?: string;
    settingsPanel?: ReactNode;
    disabled?: boolean;
    onMissingConfig?: () => void;
    onOpenChange?: (open: boolean) => void;
    buttonClassName?: string;
    getPopupContainer?: (triggerNode: HTMLElement) => HTMLElement;
    placement?: "topLeft" | "top" | "topRight" | "bottomLeft" | "bottom" | "bottomRight";
    autoAdjustOverflow?: boolean;
};

export function CanvasImageSettingsPopover({ config, onConfigChange, onOpenChange, summary, settingsPanel, disabled, buttonClassName, placement = "topLeft" }: CanvasImageSettingsPopoverProps) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [open, setOpen] = useState(false);
    const quality = config.quality || "auto";
    const count = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const activeSize = config.size || "auto";

    useEffect(() => {
        if (disabled && open) {
            setOpen(false);
            onOpenChange?.(false);
        }
    }, [disabled, open, onOpenChange]);

    return <Popover open={open && !disabled} onOpenChange={next => { setOpen(next); onOpenChange?.(next); }}>
        <PopoverTrigger asChild>
            <Button size="small" type="text" aria-label={t("canvasImageSettings.trigger")} disabled={disabled}
                className={buttonClassName || "!h-8 !max-w-[180px] !justify-start !rounded-full !px-2.5"}
                style={{ background: open && !disabled ? theme.toolbar.activeBg : undefined, color: theme.node.text }}
                icon={<Settings2 className="size-3.5" />}>
                <span className="truncate">{summary ?? <>{imageQualityLabel(quality)} · {imageSizeLabel(activeSize)} · {t("canvas.controls.images", { count })}</>}</span>
            </Button>
        </PopoverTrigger>
        <PopoverContent
            side={placement.startsWith("top") ? "top" : "bottom"}
            align={placement.endsWith("Right") ? "end" : placement.endsWith("Left") ? "start" : "center"}
            sideOffset={8} collisionPadding={12}
            aria-label={t("canvasImageSettings.trigger")} data-canvas-no-zoom data-canvas-shortcuts-ignore
            className="z-[1200] w-[356px] max-w-[calc(100vw-24px)] overflow-y-auto overscroll-contain rounded-xl border p-3 shadow-xl motion-reduce:animate-none"
            style={{ maxHeight: "var(--radix-popover-content-available-height)", background: theme.node.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
            {settingsPanel ?? <ImageSettingsPanel config={config} onConfigChange={(key, value) => onConfigChange?.(key, value)} theme={theme} className="space-y-4" />}
        </PopoverContent>
    </Popover>;
}
