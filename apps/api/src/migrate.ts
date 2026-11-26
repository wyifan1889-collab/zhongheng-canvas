import { createDatabase } from "@infinite-canvas/database";
import { migrateDatabase } from "@infinite-canvas/database/migrate";

// Explicit CLI operation only. Review the target and back it up before invoking against existing data.
const url = process.env.SAAS_DATABASE_URL;
if (!url) throw new Error("请先配置独立画布数据库 SAAS_DATABASE_URL；不使用 DATABASE_URL 或 Sub2API 配置");
let database: ReturnType<typeof createDatabase> | undefined;
try {
    database = createDatabase(url);
    await migrateDatabase(database.db);
    console.log("画布应用迁移完成（不包含 pg-boss 安装/升级）");
} catch {
    console.error("画布应用迁移失败；请检查目标、连接权限和迁移版本，不要覆盖已有迁移。");
    process.exitCode = 1;
} finally { await database?.close(); }
