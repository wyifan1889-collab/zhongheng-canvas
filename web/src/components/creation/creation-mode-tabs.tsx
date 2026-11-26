import { AudioLines, Bot, Image, Video } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type CreationKind = "agent" | "image" | "video" | "audio";
export const creationKinds = [{ value: "image", label: "图片", icon: Image }, { value: "video", label: "视频", icon: Video }, { value: "audio", label: "音频", icon: AudioLines }, { value: "agent", label: "Agent", icon: Bot }] as const;

export function CreationModeTabs({ value, onChange }: { value: CreationKind; onChange: (value: CreationKind) => void }) {
    const change = (next: string) => { if (creationKinds.some(kind => kind.value === next)) onChange(next as CreationKind); };
    return <Tabs value={value} onValueChange={change} className="w-full shrink-0 sm:w-auto">
            <TabsList aria-label="创作模式" className="grid h-10! w-full grid-cols-4 rounded-full border border-border bg-background p-0 sm:flex sm:w-auto">
                {creationKinds.map(({ value: kind, label }) => <TabsTrigger key={kind} value={kind} aria-label={`${label}模式`} title={`${label}模式`} className="h-10 min-w-0 rounded-full px-3 text-xs data-active:bg-primary! data-active:text-primary-foreground! sm:min-w-14 lg:min-w-[70px]">{label}</TabsTrigger>)}
            </TabsList>
        </Tabs>;
}
