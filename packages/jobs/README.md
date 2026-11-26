# 任务队列基础

基于固定版 pg-boss 12.35.0，独立 namespace 为 `canvas_jobs`。目前只验证数据库任务传递，不运行生成、支付、退款、定时任务或生产 worker。

- `createJobQueue(url, onError)`：返回尚未启动的客户端；调用方负责 `start()` / `stop()` 和错误处理。启动只检查已有 schema，不执行安装或升级。未安装时拒绝启动。
- `getJobSchemaSql()`：取得该固定版本的首次安装 SQL，仅在独立迁移步骤执行；不是反复执行或升级已有 schema 的脚本。正式部署前还需迁移审核与角色分权。
- `fromDrizzle(tx, sql)`：pg-boss 官方事务适配器，用在 `queue.send(name, payload, { db: fromDrizzle(tx, sql) })`。必须传同一个业务事务 tx；不传 db 就可能出现业务回滚但任务已入队。

生成任务边界还提供固定的 `generation` 队列名、版本化 `GenerationJobPayload`（只含 `taskId`、`ownerId`、`requestId`）和 `createGenerationWorker` 生命周期工厂。API 的 `generation-dispatch` 接缝会在同一数据库事务里创建 `GenerationTask` 并发送该消息；相同幂等键重放不会再次入队，入队失败会回滚任务。该接缝仍不连接供应商、不决定重试/超时/计费策略，也不会在 API 启动时自动拉起 worker。

当前关闭后台维护、超时恢复扫描和定时调度，没有在 API 启动时连接队列、创建业务队列或挂载 worker。**不能把本客户端直接接到收费生成接口。** 开放前必须确认每类任务的重试、超时、保留、并发和费用处理策略，再补齐运行与恢复生命周期。pg-boss 自身默认参数不是已获确认的产品政策。

队列取走一个任务不代表外部模型只被调用一次。进程可能在供应商成功后、写入结果前退出；仍需平台任务 ID、供应商幂等/查询能力、用量证据与待核实状态。队列表不能替代永久账本或审计记录。

验收入口：仓库根目录 `bun run test:postgres`。已验证同事务提交/回滚、入队失败回滚业务写入、独立连接竞争领取、客户端重建和数据库正常停止/启动后的持久化。断电、强杀 worker、分布式多机及供应商去重尚未验收。
