import type { PlatformPriceAmount } from "@/services/saas/platform";
import { GEMINI_IMAGE_PROTOCOL } from "../../../../packages/shared/src/generation-gemini-image";

/** Each row is one published combination; omitted dimensions stay omitted. */
export function ImageSpecPriceLines({ price }: { price: Extract<PlatformPriceAmount, { billingUnit: "image_specs" }> }) {
    if (price.protocol === GEMINI_IMAGE_PROTOCOL) return <div className="space-y-1 tabular-nums">
        <div>图片规格与每张价格</div>
        <ul aria-label="图片规格与每张价格" className="m-0 list-none space-y-1 p-0">
            {price.imageSpecs.map(({ parameters, creditsPerImage }) => <li key={`${parameters.aspectRatio}/${parameters.imageSize}`}>
                {parameters.aspectRatio} · {parameters.imageSize}：{creditsPerImage} 积分 / 张
            </li>)}
        </ul>
    </div>;
    return <div className="space-y-1 tabular-nums">
        <div>图片规格与单次价</div>
        <ul aria-label="图片规格与单次价" className="m-0 list-none space-y-1 p-0">
            {price.imageSpecs.map(({ parameters, creditsPerRequest }) => <li key={`${parameters.size ?? ""}:${parameters.quality ?? ""}`}>
                {[parameters.size === undefined ? null : `尺寸 ${parameters.size}`, parameters.quality === undefined ? null : `质量 ${parameters.quality}`].filter(Boolean).join(" · ")}：{creditsPerRequest} 积分 / 次
            </li>)}
        </ul>
    </div>;
}
