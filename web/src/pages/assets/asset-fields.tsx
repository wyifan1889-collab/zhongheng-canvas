import { useState, type ComponentProps } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/** Free-entry tags keep the original comma/Chinese comma token separators. */
export function AssetTagsInput({ value, onChange, ...props }: Omit<ComponentProps<typeof Input>, "value" | "onChange"> & { value: string[]; onChange: (value: string[]) => void }) {
    const [pending, setPending] = useState("");
    const add = (text: string, remainder = "") => {
        const additions = text.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean);
        onChange([...new Set([...value, ...additions])]);
        setPending(remainder);
    };
    return <div className="space-y-2">
        {value.length ? <ul className="flex flex-wrap gap-2" aria-label="已选标签">{value.map((tag) => <li key={tag} className="max-w-full"><Badge variant="secondary" className="h-auto min-h-9 max-w-full gap-1 pr-0"><span className="truncate">{tag}</span><Button type="button" variant="ghost" size="icon-sm" aria-label={`移除标签 ${tag}`} onClick={() => onChange(value.filter((item) => item !== tag))}><X className="size-3" /></Button></Badge></li>)}</ul> : null}
        <Input {...props} value={pending} onChange={(event) => {
            const text = event.target.value;
            if (!(event.nativeEvent as InputEvent).isComposing && /[,，]/.test(text)) {
                const parts = text.split(/[,，]/);
                const remainder = parts.pop() || "";
                add(parts.join(","), remainder);
            }
            else setPending(text);
        }} onBlur={() => { if (pending.trim()) add(pending); }} onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") { event.preventDefault(); if (pending.trim()) add(pending); }
            if (event.key === "Backspace" && !pending && value.length) onChange(value.slice(0, -1));
        }} />
        <p className="text-xs text-muted-foreground">按回车或输入逗号添加标签。</p>
    </div>;
}

export function AssetPagination({ current, pageSize, total, onChange }: { current: number; pageSize: number; total: number; onChange: (page: number, pageSize: number) => void }) {
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const jump = (input: HTMLInputElement) => {
        const next = Math.min(pages, Math.max(1, Math.trunc(Number(input.value)) || 1));
        input.value = String(next);
        onChange(next, pageSize);
    };
    return <nav aria-label="本机素材分页" className="flex flex-wrap items-center justify-center gap-2 text-sm text-muted-foreground">
        <Button type="button" variant="outline" size="icon" aria-label="上一页" disabled={current <= 1} onClick={() => onChange(current - 1, pageSize)}><ChevronLeft /></Button>
        <label className="flex items-center gap-2">第<Input key={current} type="number" aria-label="页码" min={1} max={pages} defaultValue={current} className="h-9 w-16 text-center" onBlur={(event) => jump(event.currentTarget)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); jump(event.currentTarget); } }} />/ {pages} 页</label>
        <Button type="button" variant="outline" size="icon" aria-label="下一页" disabled={current >= pages} onClick={() => onChange(current + 1, pageSize)}><ChevronRight /></Button>
        <Select value={String(pageSize)} onValueChange={(value) => { const size = Number(value); onChange(Math.min(current, Math.max(1, Math.ceil(total / size))), size); }}><SelectTrigger aria-label="每页条数" className="h-9"><SelectValue /></SelectTrigger><SelectContent position="popper" className="z-[1300]">{[10, 20, 50, 100].map((size) => <SelectItem key={size} value={String(size)}>{size} 条/页</SelectItem>)}</SelectContent></Select>
        <span>共 {total} 条</span>
    </nav>;
}
