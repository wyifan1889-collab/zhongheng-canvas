# 新电脑本地开发环境

主项目：`E:\codex-画布\codex-zh-cavanas\infinite-canvas`。旁边的 `infinite-canvas-upgrade-dab19ad` 是历史升级工作树，日常开发使用主项目。

## 打开页面

本次恢复已在后台启动两项服务，均只监听本机：

- 原版画布：[http://127.0.0.1:4174/canvas](http://127.0.0.1:4174/canvas)。
- SaaS 隔离模拟：[http://127.0.0.1:4180/canvas](http://127.0.0.1:4180/canvas)。账号和云稿均为模拟，内存云稿会随服务停止丢失。

重启电脑后，双击 `E:\codex-画布\启动画布.cmd`，再打开上面的原版画布地址。需要模拟账号/保存流程时，双击同目录的 `启动SaaS模拟预览.cmd`。启动窗口需保持打开，按 Ctrl+C 停止对应服务。服务已运行时不要重复启动；端口占用时不要随意终止其他进程。

启动脚本为 `scripts/saas/start-local.ps1`，固定本机地址和端口，Bun 使用 `--no-env-file`，不主动启动账户 API、生产数据库或执行迁移。原版前端仍可能按用户配置请求供应商；模拟页才带有夹具的外联限制。

## 工具与依赖

本地便携工具位于已忽略的 `.tools`，没有更改系统或用户 PATH：

- Bun 1.4.2：`.tools\bun-1.4.2\bun-windows-x64\bun.exe`。
- Git 2.56.0.windows.1（MinGit）：`.tools\git-2.56.0\cmd\git.exe`。
- Node.js：现有系统版本 v24.21.0。

安装包取自 [Bun 官方发行页](https://github.com/oven-sh/bun/releases/tag/bun-v1.4.2) 和 [Git for Windows 官方发行页](https://github.com/git-for-windows/git/releases/tag/v2.56.0.windows.1)，下载后与发布接口的 SHA-256 一致。工具安装包和依赖缓存保留在 `.tools/downloads`、`.tools/bun-cache`。

根目录与 `web` 已分别执行 `bun --no-env-file install --frozen-lockfile --ignore-scripts`。根依赖安装 69 包，前端 925 包；两份锁文件与迁移包完全一致。安装脚本未执行；已通过实际 Vite/模拟夹具启动验证此次所需依赖可用。

从主项目 PowerShell 使用便携 Git：

```powershell
& '.\.tools\git-2.56.0\cmd\git.exe' status --short
```

## 恢复和验证记录

- 解压文件逐项检查：1288/1288 与迁移清单相符。原 ZIP 和配套文件保留在 `E:\codex-画布\codex-zh-cavanas-migration\20261004-135919`。
- 整理工作目录后，分支仍为 `feature/saas-foundation`，HEAD 为 `dec3088cb54bdde000518b8d1bd15c48a0b2dfd2`。新增本次交付文件之前，130 条 Git 状态与原清单逐项一致。
- `git fsck --full` 成功，无缺失或损坏对象；报告一个 dangling blob，予以保留。历史升级工作树的两个旧路径引用已通过 `git worktree repair` 修复，原引用备份在 `.tools/migration-before`。
- 本机前端行为测试：13 文件、154 通过、0 失败、3889 断言。完整输出在 `.tools/migration-web-tests.log`。
- 本机后端测试：10 文件、94 通过、11 跳过、0 失败、963 断言。使用内存 PGlite 和模拟服务；跳过项是需要独立真实 PostgreSQL 的队列测试及相关 hook。
- 首次在沙箱内运行后端测试出现依赖目录链接访问和回环连接错误；获准在沙箱外按原命令重跑后通过。没有通过修改依赖或测试代码消除这些环境错误。
- Vite 日志显示 4174 服务 ready，4180 夹具正常启动；宿主机端口检查确认两者只监听 127.0.0.1。两个启动错误日志为空。日志位于 `.tools/canvas-server*.log` 和 `.tools/preview-server*.log`。
- 用户确认没有需要迁移的旧浏览器作品，因此本次未执行作品/素材导入，不宣称完成媒体迁移测试。
- 浏览器工具返回用户拒绝访问本地页面，未改用其他浏览器或自动化方式绕过。创建、编辑、刷新留存、导入导出及模拟保存的页面交互验证仍待完成。

这次只恢复本地开发环境；没有修改产品业务代码，没有构建、提交、推送、部署或迁移真实数据库。公众账户和正式云画布开关仍关闭。多标签旧快照覆盖风险仍待修复，单页启动和行为测试通过不能替代真实双标签回归。后续开发仍按方案 0.22 推进。

## 后续开发更新：本机多窗口保护

环境恢复后已实现本机保存事务保护，方案为0.23；上面的154项及锁文件一致性描述属于环境恢复批次。当前web仅新增fake-indexeddb 6.2.5开发测试依赖，179项相关回归通过，日志.tools/multitab-web-tests.log，根锁未改变。

真实双窗口页面仍未验收。先保留/导出当前内容，再让全部相关旧标签加载新版；旧代码窗口不受新保护约束，HMR不能当作全部升级。完整行为、局限和验收步骤见LOCAL_STORAGE_CHECK.md。公众账户/正式云保存仍关闭。

## QQ SMTP 本地预检

真实 SMTP 不由现有 4174/4180 模拟启动脚本自动开启。需要预检时，在 `apps/api/.env` 从 `.env.example` 复制模板，填写本机 QQ 完整邮箱、QQ 授权码（不是登录密码）和发件地址；授权码不要发送到聊天或提交到 Git。SMTP 常用值为 `smtp.qq.com`、465、隐式 TLS。

在主项目目录运行：

```powershell
bun run --cwd apps/api smtp:check
```

该命令只连接并认证 SMTP，成功后关闭连接，不发送测试邮件、不自动重试，也不要求数据库或 Turnstile。通过后若要做账户注册邮件联调，仍需补齐独立 PostgreSQL、Turnstile 和 `SAAS_AUTH_SECRET`，启动 API 4000，并用 `VITE_API_TARGET=http://127.0.0.1:4000` 启动 web 4180；这一步不会自动开启公开账户或云画布。

本机账户联调已准备 Cloudflare 官方测试用 Turnstile 密钥；它们只适用于本地测试，生产环境必须替换为自己的密钥。账户开关目前仍为 `SAAS_ACCOUNTS_ENABLED=false`。

需要启动真实账户联调时，在主项目目录运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/saas/start-account-local.ps1`。它会创建独立临时 PostgreSQL、执行账户迁移，启动 API `4011` 和 web `4181`；现有原版 `4174` 与模拟 `4180` 保持不动。停止时运行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/saas/stop-account-local.ps1`，只停止本次实例并保留运行目录供排错。该入口不会发送邮件，注册页面发送验证邮件需用户主动提交注册。
