# Infinite Canvas API

这是独立 SaaS 后端。已实现可配置启用的邮箱账户、云草稿和账号级全媒体 HTTP 接口、SMTP/Turnstile 适配器、共享数据库限流和草稿审计；默认仍只开放探针和网站配置，尚未对公众开放。云画布正文与媒体使用独立开关。

## 本地运行

在仓库根目录执行：

```powershell
bun install --frozen-lockfile
bun run dev:api
```

默认监听 `http://127.0.0.1:4000`，可用环境变量 `HOST` 和 `PORT` 调整。

生产通过 Nginx 在回环地址反代时，将 `SAAS_TRUSTED_PROXY=true` 与 `X-Forwarded-Proto: https` 配套使用，以恢复 API 的 HTTPS 同源检查；API 端口必须只绑定宿主机回环地址，不能直接暴露公网。直连 API 或本地开发保持 `false`。

### QQ SMTP 本地预检

复制 `apps/api/.env.example` 为本机 `apps/api/.env`，先填写 QQ 邮箱完整地址、授权码、发件地址和 SMTP 超时；`SMTP_PASSWORD` 必须是 QQ 邮箱授权码，不是登录密码。QQ 的常用组合是 `smtp.qq.com`、465、隐式 TLS。`SAAS_ORIGIN` 填浏览器访问的地址（本地默认 `http://127.0.0.1:4180`），API 仍监听 4000；启动 web 时设置 `VITE_API_TARGET=http://127.0.0.1:4000`，让 `/api` 通过同源代理转发。真正启动账户服务时，再补齐数据库、Turnstile 和 `SAAS_AUTH_SECRET`。

配置完成后，在仓库根目录运行：

```powershell
bun run --cwd apps/api smtp:check
```

该命令只验证 SMTP 连接和认证，成功后关闭连接，不发送测试邮件，也不会自动重试；它不要求账户数据库或 Turnstile 配置。预检通过后再补齐完整账户配置，启动 API 和 web，使用账户入口做一次明确的注册/验证码邮件联调；发信结果未知时不要重复注册，先查收 6 位验证码或使用重新发送入口。

本机账户联调可以使用 Cloudflare 官方测试用 Turnstile 密钥：site key `1x00000000000000000000AA` 和 secret key `1x0000000000000000000000000000000AA`，它们只适用于本地测试，不能用于生产。生产环境必须替换成自己的密钥，并按部署域名配置允许的 hostname。

项目根目录的 `scripts/saas/start-account-local.ps1` 会创建独立临时 PostgreSQL、执行迁移并启动 API 4011 与 web 4181；`stop-account-local.ps1` 只停止该实例。现有模拟预览 4180 不会被脚本改动。

## 当前接口

- `GET /health`：服务健康状态和当前开发阶段。
- `GET /api/v1/meta`：当前 API 版本、实际开启的 `capabilities` 和完整的 `supportedCapabilities` 词汇；能力开关关闭时不会把计划中的生成能力报告为已可用。
- `GET /api/v1/site`：公开品牌和明暗主题配置、能力开关；现有账户入口读取账户相关字段，品牌主题尚未接入。
- `GET /api/v1/admin/model-price-publications`：管理员同源只读价格预览。携带完整的 `modelId`、`draftVersion`、`priceVersion`、`aspectRatio`、`imageSize`、`budgetCredits` 时，按已保存的 Gemini 草稿试算；`priceVersion=0` 表示暂无已发布版本。需当前会话的 `x-canvas-account-id`，应答 `trial_only` 不可用于任务受理。完整例子和验证见[原生规格试算](../../docs/test-results/gemini-image-price-trial/README.md)。

默认 `meta.authentication` 为 `foundation-only`，注册/云画布/云媒体等均为 false，私有路径为 404。按 `apps/api/.env.example` 完整配置并显式启用账户后，认证为 `enabled`，提供登录/验证/找回密码、会话、草稿创建/分页/读取/版本化保存。`cloudCanvas` 仍可单独保持 false；`SAAS_MEDIA_ENABLED=true` 才会开放账号级 1 GB 初始额度的手动全媒体上传、私有读取和删除，JSON 草稿仍不是完整画布正文云同步。充值和生成仍关闭，健康检查仍只证明进程响应。示例已填入用户确认的验证码 10 秒、SMTP 连接/握手 10 秒、发送无响应 30 秒；没有自动启用或重试。

完整接口、已确认限制、失败处理和部署边界见 [账户接口说明](../../SAAS_ACCOUNT_API.md)。默认不接受浏览器任意转发 IP 头；真实域名、TLS/可信反代、SMTP/Turnstile、素材真实页面和扩容支付仍需联调。

原版菜单已接“我的云稿”账号隔离目录：打开目录本身不请求，用户主动读取首页或下一页才调用列表API，仅显示摘要；用户点选“打开并准备挂载”后，才会按账号 GET 正文并读取私有媒体，写入独立的账号草稿隔离区，严格校验通过后仍需“准备正式挂载”与“确认挂载到当前画布”两步确认。账号/epoch/项目/开关/关闭后旧结果失效，失败不显示为空目录；挂载前会保留当前画布恢复副本，媒体和生成任务不自动恢复。合成页面回归与 staging 真实目录证据分别见验收记录；生产 `cloudCanvas=false`、accounts默认关闭，不能把 staging 结果当成生产开通。用户已确认后续分账号保留新账号工作区的本机正文，退出隐藏但不自动清理，旧本机作品不自动归属；与三字段回执分开，非本机加密。

草稿全部读写请求须带 `x-canvas-account-id`，与真实会话账户严格匹配；它不是认证或 ownerId 来源。缺失返回 400，换号不符返回 409，不读取/写入草稿，旧客户端不能省略此条件。现有预算、续期 cookie 与仓库归属校验仍执行。

`POST /api/v1/canvases` 必填 `creationId` UUID（服务端转小写），连同 `title`、`documentVersion: 1`、`document` 提交；`PUT` 使用 `expectedRevision`，不接收 `creationId`。同 ID 在记录存在期间只插入一次：本人已有记录返回 `409 creation_exists`，他人占用返回 `404 not_found`，重复请求不覆盖正文或版本。只有实际插入写一条成功审计，且与草稿同事务；不是重复返回首次响应的完整幂等服务。

前端低层 `prepareCreate()` 固定内存快照与 UUID，`submit()` 显式提交，`recoverCreate(id)` 构造只读引用；这些低层接口不存编号。回执协调层先向独立 IndexedDB 写账号/本地项目/创建 ID，再允许 POST；恢复的只有主动核对入口，不重建旧正文/提交、不自动请求。`create()` 不能用于重试旧意图。原版首次保存显式准备快照后确认提交，已有回执阻止新编号，未知结果仅主动核对，404不解锁重传。现已接本页明确POST成功后的PUT再次保存：只用该页内存基准，显式固定快照/expectedRevision；尝试失败或冲突后只读，关窗/GET不解锁，GET版本增长不是该次更新成功证明。刷新或换作用域不恢复续存，不增加持久字段；生产 `cloudCanvas` 仍为 false，真实账户、完整冲突处理和云正文重开未完成。上一批135项相关前端行为测试及原版模拟版本更新/冲突/503场景已有证据，局部独立只读复核无阻断项；当前版本/暂未查到及未来硬删除防重用边界见账户接口说明。

`bun run db:migrate` 是显式写库命令，只读 `SAAS_DATABASE_URL`；核对独立目标并完成备份/迁移审查后再运行。API 启动不自动迁移，本轮未给现有数据库执行此命令，不要填入 Sub2API 生产配置。

## 隔离验证

```powershell
bun run test:saas
bun run test:postgres
bun run db:generate
bun audit
```

`test:saas` 默认使用内存 PGlite，真实数据库组显式跳过；`test:postgres` 在 Windows x64 自动建立新的本地 PostgreSQL，复跑账户/草稿/限流与事务队列测试，重启数据库检查持久化后停止服务。最新结果见 [开发日志](../../DEVELOPMENT_LOG.md)，依赖与运行方式见 [依赖记录](../../SAAS_DEPENDENCIES.md)和[本机数据库验收](../../packages/test-postgres/README.md)。

两个测试入口使用虚拟邮件及模拟 siteverify，不向外部 SMTP/Cloudflare 发请求，不调用收费模型，不读现有 `.env` 数据库目标或 `DATABASE_URL`。真实测试只给本次新集群执行迁移，保留合成数据与日志；`db:generate` 则仅生成 SQL，不应用迁移。这不是公开运营、备份恢复或多机部署验收。

原版保存的浏览器验收另用 `web/scripts/saas-first-save-browser.ts`（在 web 下 `bun --no-env-file run scripts/saas-first-save-browser.ts`）：固定 `127.0.0.1:4180`、底部默认折叠且持续可见的模拟标记、内存账号/云稿，无 `.env`/代理/外部服务，不启动本 API。POST/PUT共用正常/写入后503/未写入503场景，PUT实现expectedRevision CAS；“模拟另一窗口更新”只改最近写入的内存稿标题、文档标题与版本，不改本地原稿，用于验证旧基准冲突。上一批已在原版验证版本1→2、模拟远端推进版本后旧基准409、已写入503再GET仍不解锁、关闭重开只读和快捷键保护；刷新后四类空节点保留，不继承基准，旧回执阻止新创建/直接续存。仅深色正常视口，不是实际双窗口或真实账户/数据库联调，证据见开发日志。目录批增加模拟A/B账号、所有权过滤的摘要分页、显式51条合成种子及仅目录503开关；切号后刷新，由实际账户store重新确认，不注入前端身份，不自动造数据。复用既有API policy/Zod，不改依赖或生产规则。服务停止会丢失模拟云稿，浏览器测试作品/回执仍在4180独立来源。正式应用不可导入该脚本，不能据此宣称真实云备份可用。

## 接入顺序

账号工作区/云正文重开前还需处理原本机库的跨标签旧快照覆盖风险：4180合成测试项目在热更新后刷新消失，源码存在固定key整库延后写回路径，但此次最后写入者未确认。本批不改store、未执行删除，也未操作用户4176来源；必须补针对性修复与双标签回归，不能将目录测试视作A05/A06本机稳定性通过。

`packages/auth` 提供强制邮箱验证的认证工厂和服务端 `getPrincipal`；`packages/database` 提供 pg 连接工厂、schema、显式迁移和带所有者/版本条件的草稿仓库；`packages/shared` 只有安全共享类型。`packages/jobs` 提供默认不迁移、不自动维护/调度的队列客户端及事务适配器，当前 API 启动不连接或运行它。

QQ 授权码及真实发信/注册联调按用户要求后置，不依赖真实邮件的接入准备继续。原版“保存检查（仅本机）”仍只保留数量、不上传；首次与本页再次保存均受确认账号/项目/epoch和云保存门禁约束，不替换本地store。冲突保留的是本机当前稿与云端现有版本，不是两份都云端备份；无合并、覆盖、另存或历史版本。账号级全媒体上传/额度/私有读写已有独立接缝，仍需真实页面、旧素材迁移策略、云正文媒体引用绑定、扩容支付和跨设备验收。document仍不是完整授权上传协议；还缺同域/可信来源、全面审计和遗漏端点防刷，不可直接对公网开放。

版本与边界见 [依赖记录](../../SAAS_DEPENDENCIES.md)、[UI 准备](../../SAAS_UI_PREPARATION.md)和[开发方案](../../SAAS_DEVELOPMENT_PLAN.md)。
