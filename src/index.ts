import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { EnvSecretStore } from "./bridge/secrets.js";
import { ClientRegistry } from "./bridge/registry.js";
import { AuditSink } from "./bridge/audit-sink.js";
import { attachApi } from "./api/server.js";
import { attachBridgeWs } from "./bridge/bridge-ws.js";

function main(): void {
  const config = loadConfig();
  const secrets = new EnvSecretStore(config.clientSecretsJson);
  const registry = new ClientRegistry(config.dispatchTimeoutMs, config.dispatchRateLimitPerMinute);
  const auditSink = new AuditSink(config.auditFilePath);

  const server = createServer(); // 请求处理由 attachApi 通过 'request' 事件挂载
  attachApi(server, config, registry, auditSink);
  attachBridgeWs(server, config, registry, secrets, auditSink);

  server.listen(config.port, () => {
    console.log(`[bridge] zmzai-bridge 已启动`);
    console.log(`[bridge]   WS    : ws://localhost:${config.port}${config.bridgePath}`);
    console.log(`[bridge]   API   : http://localhost:${config.port}/v1/*`);
    console.log(`[bridge]   鉴权  : ${config.allowInsecureLocal ? "关闭(本机非安全模式)" : "Bearer INTERNAL_API_TOKEN"}`);
    console.log(`[bridge]   已加载客户端密钥数: ${secrets.count()}`);
    console.log(`[bridge]   限流  : ${config.dispatchRateLimitPerMinute > 0 ? `${config.dispatchRateLimitPerMinute} 次/分钟/client` : "未启用（生产请配置 DISPATCH_RATE_LIMIT_PER_MINUTE）"}`);
    console.log(`[bridge]   审计  : ${config.auditFilePath ? `落盘 ${config.auditFilePath}` : "仅内存（生产请配置 AUDIT_FILE_PATH）"}`);
  });

  const shutdown = () => {
    console.log("\n[bridge] 正在关闭…");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
