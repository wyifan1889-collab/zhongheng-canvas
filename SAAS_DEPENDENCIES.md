# SaaS 基础依赖与验证记录

本文件记录实际采用情况。产品方案见 `SAAS_DEVELOPMENT_PLAN.md`，不将先前调研候选自动记成已接入。

## 本批固定版本

根 `package.json` 和 `bun.lock` 管理新增 SaaS workspace。原版 web 运行依赖保持原样，本机并发保护批次仅新增固定开发测试依赖 fake-indexeddb 6.2.5，见下文；Agent/插件包与锁不变。使用 Bun 1.4.2，安装命令为 `bun install --frozen-lockfile`。

| 包 | 版本 | 用途 | 许可声明 |
| --- | --- | --- | --- |
| better-auth | 1.7.6 | 认证、会话、邮箱验证和重置密码工厂 | MIT |
| @better-auth/drizzle-adapter | 1.7.6 | 连接 PostgreSQL schema，启用事务 | MIT |
| drizzle-orm | 0.45.3 | 稳定版 SQL schema/数据访问；采用 relations v1 | Apache-2.0 |
| pg | 8.23.0 | 独立 PostgreSQL 连接池及真实网络测试 | MIT |
| pg-boss | 12.35.0 | 事务入队与数据库任务领取基础；未接收费 worker | MIT |
| rate-limiter-flexible | 11.2.1 | PostgreSQL 原子限流，无进程内故障兜底 | ISC |
| nodemailer | 10.0.11 | 强制 TLS 的 SMTP 发信适配器 | MIT-0 |
| @types/nodemailer | 7.0.11 | 发信适配器开发类型 | MIT |
| zod | 4.6.5 | HTTP 输入、配置及验证码响应校验 | MIT |
| drizzle-kit | 0.31.11 | 开发工具，生成 SQL 迁移 | MIT |
| @electric-sql/pglite | 0.5.8 | 仅开发测试的内存 PostgreSQL 引擎 | Apache-2.0 |
| @types/pg / @types/bun | 8.23.1 / 1.4.2 | 开发类型 | MIT |
| fake-indexeddb（web devDependency） | 6.2.5 | 隔离执行真实 IndexedDB 事务适配器，不进入产品运行代码 | Apache-2.0 |
| @embedded-postgres/windows-x64 | 18.4.0-beta.17 | 仅开发的 Windows x64 便携二进制；服务实测 PostgreSQL 18.4 | npm 包声明 MIT；原生 PostgreSQL 与随带库须按各自许可证核对 |

通过包管理器使用依赖，未复制或翻译 Sub2API 业务代码。保留随包许可证；当前 drizzle-orm 发布包未发现独立 LICENSE 文件，正式制品需核对上游 [Apache-2.0 许可证](https://github.com/drizzle-team/drizzle-orm/blob/main/LICENSE)并随分发补齐必要许可证/声明。此表不替代发布制品的完整依赖许可清单和审查。

本机存储测试依赖核验：[fake-indexeddb 官方仓库](https://github.com/dumbmatter/fakeIndexedDB)、npm 官方 registry 的 6.2.5 元数据及已安装 package.json/LICENSE。无运行依赖，Node >=18，本机 Node/Bun 满足；项目维护 Web Platform Tests 覆盖，但不能代替浏览器事务/配额/页面验证。已检查 scripts，无 postinstall；使用 `bun --no-env-file add --dev --exact --ignore-scripts fake-indexeddb@6.2.5`，web 锁仅增加该条目，根锁未修改。未作完整安全公告审计，不宣称无漏洞。24项事务/队列测试和1项生产store子进程集成测试通过；连同原154项回归共179通过、0失败，详见开发日志。

来源：[Better Auth](https://github.com/better-auth/better-auth)、[Drizzle](https://github.com/drizzle-team/drizzle-orm)、[node-postgres](https://github.com/brianc/node-postgres)、[PGlite](https://github.com/electric-sql/pglite)。认证接入参考 [Drizzle adapter 文档](https://www.better-auth.com/docs/adapters/drizzle)、[邮箱密码文档](https://www.better-auth.com/docs/authentication/email-password)。

队列来源：[pg-boss](https://github.com/timgit/pg-boss)；事务连接直接使用该库的 `fromDrizzle(tx, sql)`，没有自写 SQL 占位符转换。pg-boss 声明 Node >=22.12；本次在 Bun 1.4.2 行为测试通过，本机 Node 为 24.19.0，但未将结果推广为所有 Bun/Node/生产平台兼容。

便携二进制来源：[embedded-postgres](https://github.com/leinelissen/embedded-postgres)，其说明指向 Zonky 提供的 PostgreSQL 二进制。选择固定 beta 发布包仅用于本机验收，不作为生产 PostgreSQL 发行与升级方案。未安装/使用该项目的运行包装器，因为其 Windows stop 会强制结束进程树；直接调用原生 `initdb` / `pg_ctl`。初次安装禁用脚本，检查平台 postinstall 和本版空 symlink 清单后，无需执行脚本即可运行；未新增信任脚本或系统服务。

## 本地验证结果

最新账号绑定修复（依赖未变）：前端账户/草稿/预检隔离行为测试 38 通过、416 断言；后端 PGlite 套件 80 通过、11 项真实 PostgreSQL 队列测试/hook 跳过、703 断言，均 0 失败。没有重跑真实 PostgreSQL、SMTP/Turnstile 或浏览器验收；本批命令、缺陷复现与独立复核见 `DEVELOPMENT_LOG.md` 最新记录。以下保留各历史批次证据，不累加成完整产品验收。

下面的 21 项及 30 + 2 项是前两批历史结果；“复盘修复补充验收”等后续小节也各按当时范围保留。

- `bun run test:saas`：21 项通过，0 失败；测试账号与验证/重置邮件只存在于内存，不真实发信。
- 覆盖：基础公开接口、真实回环 HTTP、关闭未实现路由、注册不能提权/跳过验证、密码哈希存储、验证后登录、无会话/禁用用户拒绝、来源检查、错误密码、篡改 cookie、外部重置跳转拒绝、跨用户草稿隔离、同版本竞争写入仅一方成功、非法版本、事务回滚、外键约束、密码重置/退出/过期会话失效。
- SQL 迁移应用到全新 PGlite 实例；schema 与迁移再次比较无变化。首次发现 namespace 未导出导致迁移缺少 CREATE SCHEMA，已在未部署前重新生成初始迁移并回归。
- Better Auth 测试环境默认放宽来源检查；认证工厂显式保持 Origin/CSRF 检查开启，测试与未来接入不依赖这个测试默认值。
- `bun install --frozen-lockfile` 成功。没有运行官方前端构建、类型检查或视觉验收。

### 真实 PostgreSQL 与队列补充验收

- `bun run test:postgres`：**30 + 2 通过 / 0 失败 / 98 个断言**。原有 21 项测试复用同一业务代码与迁移，改连真实 PostgreSQL；额外 9 项检查网络身份、显式队列安装、提交/回滚/入队失败、独立连接竞争、客户端重建和重启前持久化准备。正常停止/重启 PostgreSQL 后另有 2 项检查草稿/任务保留和错误/无口令拒绝。
- 服务只监听 `127.0.0.1`，SCRAM 认证；测试应用角色不是超级用户、不能建库/建角色，但仍是本次数据库所有者，不能声称已验证生产最小权限。随机凭据只用于本次新集群，临时初始化口令文件已删除。
- `packages/test-postgres` 每次在忽略目录中新建集群，不读取现有 `.env` 数据库目标或 `DATABASE_URL`，测试结束关闭服务但保留合成数据/日志。运行说明见该包 README。
- `packages/database` 增加显式 `migrateDatabase`，应用迁移日志 namespace 为 `canvas_migrations`；任务表为 `canvas_jobs`，由 pg-boss 固定版生成初次安装 SQL。API 和常规队列启动不自动执行迁移，没有迁移现有/生产数据。
- 默认 `bun run test:saas` 回归仍为 21 通过 / 0 失败；真实数据库组在此入口显式跳过（Bun 也将该组两个 hook 记为跳过项），完整队列测试必须用真实数据库入口。再次生成迁移无 schema 变化。

### 账户与云草稿 HTTP 补充验收（历史）

- `bun run test:saas`：**52 通过 / 11 跳过 / 0 失败 / 223 个断言**。跳过的是仅真实数据库入口执行的队列组（9 项及 2 个 hook），不是未通过的账户测试。
- `bun run test:postgres`：**61 + 2 通过 / 0 失败 / 253 个断言**。最新独立集群为 `.tools/postgres-tests/run-vXRUTb`；完整测试包含真实入口默认关闭检查，数据库重启后再执行 2 项持久化/凭据检查，最终正常停止。
- 新增 22 项账户/草稿 HTTP 与原子限流测试、8 项服务适配器/配置测试、1 项实际 API 入口子进程测试。覆盖严格来源/字段、可信连接 IP、验证码拒绝/故障、IP/邮箱预算、会话投影、禁用账户、重置/退出撤销、跨用户拒绝、409 竞争、微秒游标分页、超大分块正文不覆盖旧稿、审计失败回滚和限流存储故障关闭。
- Better Auth 在部分发信回调失败后仍可能返回成功；HTTP 层用请求隔离的 AsyncLocalStorage 记录失败并返回安全的 503。注册失败后的未验证账号不能登录；并发发送成功与失败互不污染。测试不包含真实 SMTP/Cloudflare 请求。
- 新增迁移 `0001_account_http.sql`（限流/草稿审计），初始迁移未改写；再次 `bun run db:generate` 无 schema 变化。显式 `bun run db:migrate` 只接收专用 `SAAS_DATABASE_URL`，本批没有对现有数据库执行。
- `bun install --frozen-lockfile`、`git diff --check` 通过；遵循项目约定，不执行前端构建、语法/类型检查或视觉验收。官方 web/Agent/代理/插件及其锁文件未改。
- 新适配依赖来源：[rate-limiter-flexible](https://github.com/animir/node-rate-limiter-flexible)、[Nodemailer](https://github.com/nodemailer/nodemailer)、[Zod](https://github.com/colinhacks/zod)。Nodemailer 声明 Node >=20，本机 Bun/Node 版本满足当前开发前提；真实 SMTP 兼容性仍须联调。

### 复盘修复补充验收（最新）

- 沿用 Better Auth v1.7.6 的 `returnHeaders` 和 `onAPIError`，没有新增/升级依赖或修改锁文件。已核对安装版 `dist/api/routes/session.mjs`、`dispatch.mjs`、`index.mjs` 及 better-call 1.4.0 的 `dist/router.mjs`，解决续期响应头遗漏、邮件/5xx 脱敏事件遗漏及底层原始错误日志回退。
- 新增 11 项行为回归，先复现缺陷再修复；`bun run test:saas` 为 **63 通过 / 11 跳过 / 0 失败 / 382 断言**，真实 `bun run test:postgres` 为 **72 + 2 通过 / 0 失败 / 412 断言**。最新集群 `.tools/postgres-tests/run-kSAzy1` 已正常停止。认证过期/禁用/撤销、业务限流、账户隔离、队列与重启测试保持通过。
- 原诊断脚本确认当前会话响应 cookie 数 1、发信失败事件数 1；R02 防刷仍未修复。没有新增迁移，没有真实邮件/验证码/模型/付款，也没有前端构建、类型检查或视觉验收。依赖未变，本轮未重跑安装/审计/迁移生成；上一批审计不能当本轮新结果。
- 回归使用合成时间戳和本机 HTTP；HTTPS cookie 属性检查不等于生产 TLS/浏览器长期验证。真实服务、用户验收与独立复核仍待完成，详见 `SAAS_FOUNDATION_REVIEW.md`。

## 安全公告与工具覆盖

初次 `bun audit` 检出 drizzle-kit 的旧加载器间接依赖 esbuild 0.18.20，涉及 [GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)（开发服务器来源读取问题）。新增 workspace 在根 overrides 将 esbuild 统一固定为 0.28.2，没有修改官方前端依赖。

覆盖后迁移生成可运行、schema 比较无变化；重新审计 81 个包，报告 0 条已知漏洞。该结论只针对当次新增 workspace 审计，不是全项目或产品安全认证。覆盖跨越部分工具的原 semver 范围，后续升级需复验 drizzle-kit/加载器，并在上游移除旧依赖后重新评估 override。

追加 pg-boss 与便携测试工具后曾检查 91 个包；本批加入 SMTP/限流适配器后，最新 `bun audit` 检查 **94 个包，0 条已知漏洞**。npm 公告审计不覆盖原生 PostgreSQL 所有随带库、供应链来源或实际部署安全；生产发行还需独立核查。

## 尚未通过的验证

- 生产数据库的 TLS、最小角色权限、连接池压力/容量、备份恢复及多进程/多机竞争；本次是单测试进程中的独立 pg-boss 连接，不是分布式压力验收。
- pg-boss 的强杀 worker/断电恢复、外部供应商去重与升级迁移尚未验证。正常停止/重启不是崩溃演练，队列不等于外部生成“恰好一次”。
- 对象存储厂商未选，SDK、上传安全、私有文件授权和云素材尚未接入。
- 账户/草稿 HTTP、确认过的初始业务限流、SMTP/Turnstile 适配器已实现并隔离测试；真实邮件投递/退信、Cloudflare 域名/防重放、可信反代/TLS/cookie、前端登录/云画布接入仍未验收。用户已确认验证码 10 秒、SMTP 连接/握手 10 秒、发送无响应 30 秒、不自动重试，非秘密示例已填写；运行配置缺失仍不能启用。
- 超管初始化、完整认证/管理员审计、遗漏端点防刷、限流表清理/容量、媒体归属与存储总额度仍待实现/验收。当前同事务草稿审计不代表完整风控；不能把初始限制确认扩大到其他业务边界值。
- ZPay 和模型均未调用，无真实用户、余额、付款或退款。

PGlite 是 PostgreSQL 引擎级本地测试；真实 PostgreSQL 补充了网络与持久化验证，但不替代部署验收。P0 只完成当前子集，不能整体标为完成。当前关闭任务维护/恢复扫描和调度，仅测试队列指定 `retryLimit: 0`；所有生产边界值仍须说明并确认，不能沿用库默认值后直接开放收费任务。

## 升级与回退

依赖升级单独提交版本清单与锁文件，复跑上述测试、迁移差异和审计；不自动升级所有依赖。正式数据库迁移单独审批执行，启动服务不自动迁移；已应用的迁移不得改写。

当前没有给生产/现有数据库执行迁移，API 认证/草稿写接口默认不挂载，必须显式开关和完整配置才能启用。如放弃本批，只需在审查后撤回本批新增源码及锁文件改动，保留用户之前的文档和所有官方目录；不清理现有浏览器数据、不重置整个仓库。
