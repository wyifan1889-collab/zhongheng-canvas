import { Alert, Checkbox, Space, Typography } from "antd";
import { VIDEO_PROTOCOL, VIDEO_USAGE_POLICY, type VideoPricePolicy } from "../../../../../packages/shared/src/generation-video";
import type { PublishedVideoSpecPrice } from "../../../../../packages/shared/src/model-price-publications";

/** This explicit administrator assertion is saved in the immutable draft, never inferred from an adapter. */
export function VideoPricePolicyEditor({ value, disabled, onChange }: {
    value?: VideoPricePolicy; disabled: boolean; onChange: (value: VideoPricePolicy | undefined) => void;
}) {
    return <Space orientation="vertical" className="w-full">
        <Checkbox disabled={disabled} checked={!!value} onChange={event => onChange(event.target.checked
            ? { schemaVersion: 1, protocol: VIDEO_PROTOCOL, usagePolicy: VIDEO_USAGE_POLICY } : undefined)}>
            我已核对当前渠道支持 Grok JSON 视频任务协议（版本 1）
        </Checkbox>
        <Alert type="info" showIcon title="视频价目须明确协议和完整规格" description="本批仅支持文生视频或一张首帧、每次一条视频。逐档填写模式、分辨率、整数时长、是否生成声音；文生另填比例，首帧比例随图片且不可指定。按成功私有交付条数收取正整数积分；按秒或无法无损表达的售价继续不可发布。配置成本、请求时长和媒体探测时长都不是供应商收费凭据。发布价目仍须另过运行配置与资源门槛。" />
    </Space>;
}

export default function VideoPricePublication({ price }: { price: PublishedVideoSpecPrice }) {
    return <Space orientation="vertical" className="w-full" size="small">
        <Typography.Text type="secondary">Grok JSON 视频任务协议 v1 · 按成功私有交付条数收费</Typography.Text>
        {price.videoSpecs.map((spec, index) => <div key={index} className="tabular-nums">
            {spec.parameters.mode === "text" ? "文生视频" : "一张首帧"} · {spec.parameters.resolution} · {spec.parameters.durationSeconds} 秒 · {spec.parameters.generateAudio ? "生成声音" : "不生成声音"} · {spec.parameters.aspectRatio ?? "比例随首帧"}：{spec.creditsPerVideo} 积分 / 条
        </div>)}
        <Typography.Text type="secondary">确认正式报价后才冻结积分；受理或供应商完成均不等于已交付。未知保留冻结，只核对原任务。</Typography.Text>
    </Space>;
}
