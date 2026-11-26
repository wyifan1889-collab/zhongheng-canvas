import { useEffect, useRef, useState } from "react";
import { AudioLines, Download, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from "lucide-react";
import { Button, Slider } from "@/components/creation/ui";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const time = (seconds: number) => Number.isFinite(seconds) && seconds >= 0 ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "—";

export function AudioPlayer({ url, title, disabled, isCurrent, onPrevious, onNext, onDownload }: {
    url?: string; title?: string; disabled: boolean; isCurrent: () => boolean;
    onPrevious?: () => void; onNext?: () => void; onDownload: () => void;
}) {
    const audio = useRef<HTMLAudioElement>(null);
    const [playing, setPlaying] = useState(false), [position, setPosition] = useState(0), [duration, setDuration] = useState(0);
    const [volume, setVolume] = useState(1), [muted, setMuted] = useState(false), [error, setError] = useState("");
    const ready = !!url;
    useEffect(() => {
        const element = audio.current;
        setPlaying(false); setPosition(0); setDuration(0); setError("");
        return () => { if (element) { element.pause(); element.removeAttribute("src"); element.load(); } };
    }, [url]);
    useEffect(() => { if (audio.current) { audio.current.volume = volume; audio.current.muted = muted; } }, [volume, muted, url]);
    const toggle = async () => {
        const element = audio.current;
        if (!element || !ready || !isCurrent()) return;
        if (!element.paused) { element.pause(); return; }
        setError("");
        try { await element.play(); } catch { if (isCurrent() && element === audio.current && element.src === url) setError("播放未开始，请重新读取音频后再试。"); }
    };
    return <footer aria-label="音频播放器" className="grid shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t border-border bg-card px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 sm:grid-cols-[minmax(8rem,1fr)_auto_minmax(10rem,2fr)_auto] sm:gap-5 sm:px-6 sm:py-4">
        <audio key={url ?? "empty"} ref={audio} src={url} preload="metadata"
            onLoadedMetadata={event => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
            onTimeUpdate={event => setPosition(event.currentTarget.currentTime)} onPlay={event => { if (isCurrent()) setPlaying(true); else event.currentTarget.pause(); }}
            onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
            onError={() => { if (url && isCurrent()) { setPlaying(false); setError("音频暂时无法播放，请重新读取原音频。"); } }} />
        <div className="col-span-2 min-w-0 sm:col-span-1">
            <div className="flex min-w-0 items-center gap-2 text-sm font-medium"><AudioLines className="size-4 shrink-0 text-primary" /><span className="truncate">{title || "选择一段语音"}</span></div>
            <p role="status" className="mt-1 truncate text-xs text-muted-foreground">{error || (url ? playing ? "正在播放" : "音频已就绪，点击播放" : "从我的音频中选择并读取作品")}</p>
        </div>
        <div className="row-start-2 flex items-center gap-0.5 sm:row-start-auto">
            <Button type="text" shape="circle" aria-label="上一段" disabled={disabled || !onPrevious} onClick={() => { if (isCurrent()) onPrevious?.(); }} icon={<SkipBack className="size-4" />} />
            <Button type="primary" shape="circle" aria-label={playing ? "暂停" : "播放"} disabled={!ready} onClick={() => void toggle()} icon={playing ? <Pause className="size-4" /> : <Play className="size-4" />} />
            <Button type="text" shape="circle" aria-label="下一段" disabled={disabled || !onNext} onClick={() => { if (isCurrent()) onNext?.(); }} icon={<SkipForward className="size-4" />} />
        </div>
        <div className="col-span-2 row-start-2 flex min-w-0 items-center gap-2 sm:col-span-1 sm:row-start-auto">
            <Slider aria-label="播放进度" className="flex-1 [&>span:first-child]:bg-border" min={0} max={duration || 1} step={0.1} value={Math.min(position, duration)} disabled={!ready || duration <= 0}
                onChange={value => { if (audio.current && isCurrent()) { audio.current.currentTime = value; setPosition(value); } }} />
            <span className="whitespace-nowrap text-[10px] text-muted-foreground tabular-nums sm:text-xs">{url ? time(position) : "—"} / {duration > 0 ? time(duration) : "—"}</span>
        </div>
        <div className="col-start-3 row-start-1 flex items-center sm:col-start-auto sm:row-start-auto">
            <Popover><PopoverTrigger asChild><button type="button" aria-label="音量设置" disabled={!ready} className="grid size-9 place-items-center rounded-md hover:bg-accent disabled:opacity-50">{muted || volume === 0 ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />}</button></PopoverTrigger>
                <PopoverContent side="top" align="end" className="z-[1300] w-56" data-canvas-shortcuts-ignore>
                    <div className="flex items-center gap-3"><Button type="text" shape="circle" aria-label={muted ? "取消静音" : "静音"} onClick={() => { if (isCurrent()) setMuted(!muted); }} icon={muted ? <VolumeX className="size-4" /> : <Volume2 className="size-4" />} />
                        <Slider aria-label="音量" className="flex-1 [&>span:first-child]:bg-border" min={0} max={1} step={0.01} value={muted ? 0 : volume} onChange={value => { if (isCurrent()) { setVolume(value); setMuted(false); } }} /></div>
                </PopoverContent>
            </Popover>
            <Button type="text" shape="circle" aria-label="下载当前音频" disabled={!ready} onClick={() => { if (isCurrent()) onDownload(); }} icon={<Download className="size-4" />} />
        </div>
    </footer>;
}
