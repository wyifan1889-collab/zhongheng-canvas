# 合成媒体验收样本

`media-recovery.png` 仅用于开发验收。使用 Pillow 生成的 64×48 RGB 图片，左上红、右上绿、左下蓝、右下黄，中央白色矩形；无用户素材、元数据或外部链接。

- 文件长度：232 bytes。
- SHA-256：`d0284c7222f68c1a8e70ff8016f9c9a1e61a230ef1f2a4b8d86c983546776061`。
- 已通过 Pillow `verify()`、重新打开后的 `load()`、尺寸和五个色块取样检查；这不代表浏览器解码验收通过。
- `saas-first-save-browser.ts --media-recovery` 启动时固定校验长度和哈希。普通模式不读取此文件。

可用以下 Python/Pillow 代码重建图案；不同编码器版本可能产生不同 PNG 字节，替换样本时必须重新核验并更新固定哈希，不自动接受变化。

```python
from PIL import Image, ImageDraw
image = Image.new("RGB", (64, 48))
draw = ImageDraw.Draw(image)
draw.rectangle((0, 0, 31, 23), fill=(220, 38, 38))
draw.rectangle((32, 0, 63, 23), fill=(22, 163, 74))
draw.rectangle((0, 24, 31, 47), fill=(37, 99, 235))
draw.rectangle((32, 24, 63, 47), fill=(234, 179, 8))
draw.rectangle((26, 18, 37, 29), fill=(255, 255, 255))
image.save("media-recovery.png", format="PNG")
```

操作步骤与证据边界见 [媒体恢复隔离验收](../../../docs/test-results/media-recovery-browser-harness.md)。
