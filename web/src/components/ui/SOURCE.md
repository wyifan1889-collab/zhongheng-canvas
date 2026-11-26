# shadcn/ui 源码来源

S1 使用官方 `shadcn@4.7.0` CLI，基于官方固定提交
`1137b24a972f5d8d485ee0cadda97180585af851` 的 `radix-nova` registry 添加本批实际组件。

源码路径：`apps/v4/public/r/styles/radix-nova/{name}.json`。
来源：[官方固定提交](https://github.com/shadcn-ui/ui/tree/1137b24a972f5d8d485ee0cadda97180585af851)。
适用 MIT 许可保留在本目录 `LICENSE.shadcn.txt`。

CLI 转换 import aliases 和 lucide 图标；Sonner 适配既有 `useThemeStore`，Button 悬停沿用集中品牌变量，关闭文案采用中文。现有 Select 与两个动画组件没有覆盖。

原 registry、适配输入、包许可证/哈希、CLI dry-run/实际执行及保护文件前后摘要见
`docs/test-results/shadcn-s1/dependency-audit/`。Sonner/Command 所需依赖已使用 `--exact --ignore-scripts` 单独安装；CLI 输入移除已安装依赖，避免其安装子进程跳过脚本禁用选项。

图片预览手势使用固定 `react-zoom-pan-pinch@4.2.0`，其实际包、MIT 许可、脚本及 React peer 已单独审阅，缩放范围与原预览一致；运行验证另见交互证据。

本记录核验 shadcn、radix-ui、sonner、cmdk、react-zoom-pan-pinch 及选定组件的实际 MIT 许可，不是所有传递依赖均为 MIT 的断言。
