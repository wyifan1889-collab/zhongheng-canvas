import type { PublishedVideoSpecPrice } from "../../../../packages/shared/src/model-price-publications";

/** A published row is a complete combination, priced per delivered video. */
export function VideoSpecPriceLines({ price }: { price: PublishedVideoSpecPrice }) {
    return <div className="space-y-1 tabular-nums">
        <div>视频规格与单条价</div>
        <ul aria-label="视频规格与单条价" className="m-0 list-none space-y-1 p-0">
            {price.videoSpecs.map(({ parameters, creditsPerVideo }) => <li key={[parameters.mode, parameters.resolution, parameters.durationSeconds, parameters.generateAudio, parameters.aspectRatio ?? ""].join(":")}>
                {parameters.mode === "text" ? "文生视频" : "单张首帧"} · {parameters.resolution} · {parameters.durationSeconds}秒 · {parameters.generateAudio ? "带声音" : "无声音"}{parameters.aspectRatio ? ` · ${parameters.aspectRatio}` : ""}：{creditsPerVideo} 积分 / 条
            </li>)}
        </ul>
    </div>;
}
