import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { EnvSecretStore } from "./bridge/secrets.js";
import { ClientRegistry } from "./bridge/registry.js";
import { attachApi } from "./api/server.js";
import { attachBridgeWs } from "./bridge/bridge-ws.js";

function main(): void {
  const config = loadConfig();
  const secrets = new EnvSecretStore(config.clientSecretsJson);
  const registry = new ClientRegistry(config.dispatchTimeoutMs);

  const server = createServer(); // 请求处理由 attachApi 通过 'request' 事件挂载
  attachApi(server, config, registry);
  attachBridgeWs(server, config, registry, secrets);

  server.listen(config.port, () => {
    console.log(`[bridge] zmzai-bridge 已启动`);
    console.log(`[bridge]   WS    : ws://localhost:${config.port}${config.bridgePath}`);
    console.log(`[bridge]   API   : http://localhost:${config.port}/v1/*`);
    console.log(`[bridge]   鉴权  : ${config.allowInsecureLocal ? "关闭(本机非安全模式)" : "Bearer INTERNAL_API_TOKEN"}`);
    console.log(`[bridge]   已加载客户端密钥数: ${secrets.count()}`);
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
