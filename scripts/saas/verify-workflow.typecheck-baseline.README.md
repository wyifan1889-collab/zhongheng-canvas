# Typecheck 基线门禁

Round15 已审 Web 类型检查使用 Bun 1.4.2 与 `tsc --noEmit --incremental false --pretty false`，规范化结果为 69 条诊断、33 个 `file + code + 首行 message` 键，原始进程 exit 2。根 `typecheck-baseline.txt` 保存这份 69 条输出，`typecheck-baseline.allowlist.tsv` 按键计数重建；旧 187 条/64 键额度不再参与门禁。

运行 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/saas/verify-workflow.typecheck-baseline.test.ps1` 可验证精确 69 条通过，并证明新键、同键次数增加、Round15 已消除诊断回归都会失败；有诊断却 exit 0 失败，零诊断 exit 0 仍通过。

本测试只提取并调用 `verify-workflow.ps1` 的现有类型门禁函数，不启动 API、数据库、浏览器或完整工作流。实际复跑原件及摘要在 `E:\codex-画布\evidence\quality-gate-r1`。
