import { Button, Modal } from "antd";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { CanvasSaveCheck } from "@/services/saas/canvas-save-check";

export function CanvasSaveCheckModal({ result, onClose }: { result: CanvasSaveCheck | null; onClose: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    return (
        <Modal title="保存检查 · 仅本机" open={result !== null} onCancel={onClose} footer={<Button onClick={onClose}>返回画布</Button>} centered>
            <div className="space-y-4 text-sm leading-6" style={{ color: theme.node.text }}>
                <section>
                    <p className="font-medium">当前为本地保存模式，云保存尚未接通</p>
                    <p style={{ color: theme.node.muted }}>原版自动本地保存机制保持不变。本次检查不上传、不修改作品，也不确认浏览器是否已写入成功。</p>
                </section>
                {result?.status === "checked" ? (
                    <section aria-label="本次检查结果">
                        <p className="font-medium">点击检查时的内容概况</p>
                        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 mt-2">
                            <dt>节点</dt><dd>{result.nodes}</dd>
                            <dt>连线</dt><dd>{result.connections}</dd>
                            <dt>助手会话</dt><dd>{result.chats}</dd>
                            <dt>未归属媒体/任务引用位置</dt><dd>{result.localMediaReferences}</dd>
                            <dt>按格式省略的可选空字段</dt><dd>{result.omittedOptionalFields}</dd>
                        </dl>
                        <p className="mt-2" style={{ color: theme.node.muted }}>引用位置数不等于文件数；未检查素材是否存在、归属或可跨设备读取，也未验证完整节点关系。即使数量为 0，也不代表可以云保存。</p>
                    </section>
                ) : result?.status === "unavailable" ? (
                    <p role="alert">本次检查未完成：内容无法完整生成检查快照。未因本次检查修改或覆盖作品，请保留当前页面。</p>
                ) : null}
                <p style={{ color: theme.node.muted }}>当前本地作品未按平台账号隔离，登录不代表作品已归入账号或已云备份。后续云保存采用手动保存，旧作品不自动上传，冲突不自动覆盖。</p>
            </div>
        </Modal>
    );
}
