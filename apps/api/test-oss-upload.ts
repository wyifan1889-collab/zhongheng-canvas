import { createStorageAdapter, objectKey } from "@infinite-canvas/storage";

const names = [
    "ALIYUN_OSS_REGION",
    "ALIYUN_OSS_ACCESS_KEY_ID",
    "ALIYUN_OSS_ACCESS_KEY_SECRET",
    "ALIYUN_OSS_BUCKET",
] as const;
const missing = names.filter((name) => !process.env[name]);

if (missing.length > 0) {
    console.log(`SKIP: 未配置真实 OSS 凭据（缺少 ${missing.join("、")}），未发起网络请求。`);
    process.exit(0);
}

const storage = createStorageAdapter({
    provider: "aliyun-oss",
    region: process.env.ALIYUN_OSS_REGION!,
    accessKeyId: process.env.ALIYUN_OSS_ACCESS_KEY_ID!,
    accessKeySecret: process.env.ALIYUN_OSS_ACCESS_KEY_SECRET!,
    bucket: process.env.ALIYUN_OSS_BUCKET!,
});
const key = objectKey(`test/infinite-canvas-${Date.now()}.txt`);
const body = new TextEncoder().encode("Hello from Infinite Canvas");

try {
    console.log("开始测试 OSS 私有 Bucket 上传（不会输出密钥或签名 URL）...");
    const saved = await storage.put({ key, body, contentType: "text/plain; charset=utf-8" });
    const loaded = await storage.get(key);
    if (!loaded || new TextDecoder().decode(loaded.body) !== "Hello from Infinite Canvas") {
        throw new Error("下载后的内容与上传内容不一致");
    }
    console.log(`上传/下载通过：${saved.sizeBytes} bytes`);
    await storage.delete(key);
    if (await storage.get(key) !== null) throw new Error("删除后仍能读取对象");
    console.log("删除验证通过；测试对象已清理。");
} catch (error) {
    console.error("OSS 测试失败：", error instanceof Error ? error.message : "未知错误");
    process.exitCode = 1;
}
