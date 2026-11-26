import { useState } from "react";
import { Cpu } from "lucide-react";
import { resolveModelBrand } from "@/lib/model-brand";
import { cn } from "@/lib/utils";

export function ModelBrandIcon({ model, label, brand, className }: { model: string; label?: string; brand?: string; className?: string }) {
    const icon = resolveModelBrand(model, label, brand);
    const [failed, setFailed] = useState<string>();
    const dimensions = cn("size-4 shrink-0", className);
    return icon && failed !== icon.icon ? <img src={icon.icon} width={16} height={16} alt={icon.name} title={icon.name}
        data-model-brand={icon.id} draggable={false} className={cn(dimensions, "object-contain", icon.monochrome && "dark:invert")}
        onError={() => setFailed(icon.icon)} /> : <Cpu aria-hidden="true" className={cn(dimensions, "opacity-70")} />;
}
