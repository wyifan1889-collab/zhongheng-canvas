# 独立 PostgreSQL 本地验收（仅开发）

在仓库根目录运行：

```powershell
bun install --frozen-lockfile
bun run test:postgres
```

当前入口只支持已验收的 Windows x64 / Bun 1.4.2。固定 `@embedded-postgres/windows-x64` 18.4.0-beta.17，实际服务报告 PostgreSQL 18.4。包约 109 MB（解包后），这是便携开发工具，**不是生产数据库部署方案**。其他平台、容器、TLS 和生产角色分权另行验收。

如果工作目录包含中文等非 ASCII 字符，Windows `initdb` 可能误读路径；入口会自动把本次集群放到系统临时目录。需要指定其他位置时可先设置 `SAAS_POSTGRES_RUN_ROOT`，目录必须是 ASCII 路径并且可写。

每次运行会：

1. 在 gitignored `.tools/postgres-tests/run-*`（非 ASCII 工作目录则为系统临时目录）建立全新的独立集群，分配临时回环端口；不读取现有数据库地址、不连接 Sub2API。
2. 使用 PostgreSQL 自带 `initdb` / `pg_ctl`，只监听 `127.0.0.1`，启用 SCRAM；不建系统账号/服务、不改防火墙。两个随机数据库口令不输出；initdb 所需的临时口令文件在初始化后删除，应用口令仅经测试子进程环境传递。Windows 文件权限沿用本机账户/目录 ACL，不宣称沙箱隔离同机用户。
3. 用无 superuser、CREATEDB、CREATEROLE 权限的专用数据库所有者跑固定的账户/草稿/API/适配器/运行入口回归测试和真实队列检查；当前真实数据库进程明确列出这 13 个稳定测试文件。后续 provider/catalog、wallet、generation、worker、readiness 与新增隔离约束测试留在 PGlite API 全量回归和独立 staging 演练；这些夹具使用固定公共 ID，不能与共享数据库进程混跑。迁移只应用到本次新数据库。邮件和验证码用模拟适配器，不调用真实服务。角色仍是库所有者，不等同于生产最小权限验收。
4. 在独立测试子进程中运行 2 项 readiness 故障检查：事务内移除邮箱索引、事务只读均不应就绪，回滚后应恢复就绪。仅操作本次合成数据库，不更改线上权限或配置。
5. 关闭、重启整个 PostgreSQL 服务，再执行 2 项持久化/错误凭据检查，最后正常关闭服务。正常成功和测试失败都会走停止清理；不自动删除数据目录。

历史基线为 **106 + 2 通过，0 失败，1000 个断言**；最新结果为 **138 + 2 + 2 通过，0 失败，1235 个断言**（13 个 API 文件：1221；readiness 故障：7；重启/错误凭据：7），证据见 `docs/test-results/draft-concurrency-body-timeout-20261020.md`。生成配置/Provider/worker 仍由 API PGlite 全量回归和 staging 演练单独覆盖。默认 `bun run test:saas` 仍跑内存 PGlite；没有测试地址时真实数据库组显式跳过。两个入口均关闭 `.env` 自动加载；测试从不以 `DATABASE_URL` 作为迁移目标。

平台包只带初始化/启动工具，未附带 `pg_dump` / `pg_restore`。当前入口不执行备份恢复，不得把重启和 DDL 事务回滚写成备份恢复或版本回滚已通过。

Gemini 按张结算专项执行 `bun --no-env-file --no-install run packages/test-postgres/src/run.ts --gemini-image-settlement`。运行器创建全新回环数据库，安装真实队列，以合成响应和私有内存对象验证报价、资金、图库和并发恢复。[专项回执](../../docs/test-results/gemini-image-settlement/README.md)

文本预算同 key 并发验收使用独立新库，单独运行：

```powershell
bun --no-env-file run packages/test-postgres/src/run.ts --text-budget
```

此组复用现有便携 PostgreSQL 和显式队列安装器，使用两个真实 API/数据库连接及 `pg_blocking_pids` 观察同 key 插入等待；验证相同请求返回创建/回放、不同预算返回冲突，每组仅一份任务、冻结、流水及真实 pg-boss 作业。只创建合成账号、渠道、双项文本价目和预算，不启动 worker、不调用模型；不作为真实模型生成或实际计费验收。运行器拒绝已有 `DATABASE_URL` / `SAAS_TEST_DATABASE_URL`，测试还会拒绝已有应用或队列 schema。2026-10-25 本组结果为 2 通过、0 失败、26 个断言。

测试数据与 PostgreSQL 日志保留在打印的唯一目录中，含合成账号和合成会话；不会复用为开发/生产数据。反复运行会占用磁盘，清理时只能选择已停止的具体 `run-*` 目录，不删 `.tools` 或工作区根目录。强制终止整个运行器、停电等情况不保证执行 finally；可用包内 `pg_ctl.exe status -D <本次明确的数据目录>` 检查，再用 `stop -D <同一目录> -m fast -w` 停止该集群，不批量结束 postgres 进程。

测试启动/停止等待上限 30 秒和测试队列 `retryLimit: 0` 仅用于验收工具，不是产品的超时/重试承诺。正常停止/启动通过不等于进程崩溃恢复、备份恢复或付费模型恰好一次。

初次安装使用 `--ignore-scripts` 检查依赖：平台包 postinstall 只用于恢复 native symlink，本版 Windows 清单为空，测试无需运行它，也未扩大 Bun 脚本信任列表。没有使用 embedded-postgres 包装器（其 Windows stop 使用强杀进程树）。封装包的 npm MIT 声明不能替代 PostgreSQL 二进制及随带库的各自许可证；生产制品不应包含此测试包、原生工具或测试数据。
