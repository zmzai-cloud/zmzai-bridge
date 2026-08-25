/**
 * 自包含 E2E：在进程内启动桥接服务，用一个「仿真客户端」连上，
 * 再通过内部 HTTP API 下发工具请求，验证 会话路由 + 请求关联 全链路通。
 * 无需 Electron GUI，可在任意 Node 环境运行： `pnpm e2e`
 */
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.js";
import { EnvSecretStore } from "../src/bridge/secrets.js";
import { ClientRegistry } from "../src/bridge/registry.js";
import { attachApi } from "../src/api/server.js";
import { attachBridgeWs } from "../src/bridge/bridge-ws.js";
import { sign } from "../src/bridge/sign.js";

const CLIENT_ID = "e2e-client";
const CLIENT_SECRET = "e2e-secret";
const PORT = 8799;

process.env.ALLOW_INSECURE_LOCAL = "true";
process.env.CLIENT_SECRETS = JSON.stringify({ [CLIENT_ID]: CLIENT_SECRET });
process.env.PORT = String(PORT);
process.env.HELLO_MAX_AGE_MS = "600000";
process.env.DISPATCH_TIMEOUT_MS = "10000";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`断言失败: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function waitFor<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`等待超时: ${label}`)), ms)),
  ]);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const secrets = new EnvSecretStore(config.clientSecretsJson);
  const registry = new ClientRegistry(config.dispatchTimeoutMs);
  const server = createServer();
  attachApi(server, config, registry);
  attachBridgeWs(server, config, registry, secrets);

  await new Promise<void>((res) => server.listen(PORT, res));
  console.log(`[e2e] 桥接服务已在 :${PORT} 启动`);

  // ---- 仿真客户端：连上、握手、自动批准并回传 ----
  const welcomeP = new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}${config.bridgePath}`);
    ws.on("open", () => {
      const ts = Date.now();
      ws.send(
        JSON.stringify({
          kind: "hello",
          v: 1,
          clientId: CLIENT_ID,
          ts,
          signature: sign(`${CLIENT_ID}:${ts}`, CLIENT_SECRET),
        }),
      );
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.kind === "welcome") {
        console.log(`[e2e] 仿真客户端已连接，session=${msg.sessionId}`);
        resolve(msg.sessionId);
      }
      if (msg.kind === "tool_request") {
        // 自动批准（模拟用户点击「允许」），回传结果
        const audit = {
          id: msg.id,
          clientId: CLIENT_ID,
          tool: msg.tool,
          risk: msg.risk,
          approved: true,
          decidedBy: "auto" as const,
          startedAt: msg.issuedAt,
          finishedAt: Date.now(),
          summary: `sim ${msg.tool}`,
        };
        ws.send(
          JSON.stringify({
            kind: "tool_result",
            v: 1,
            id: msg.id,
            ok: true,
            data: { echoed: msg.tool, params: msg.params },
            audit,
          }),
        );
      }
    });
    ws.on("error", reject);
  });

  const sessionId = await waitFor(welcomeP, 5000, "welcome");

  // ---- 测试 1：经 clientId 下发 notify ----
  console.log("[e2e] 测试1: POST /v1/clients/e2e-client/tool (notify)");
  const r1 = await fetch(`http://localhost:${PORT}/v1/clients/${CLIENT_ID}/tool`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "notify", params: { title: "hi", body: "from e2e" } }),
  });
  const j1 = (await r1.json()) as { ok: boolean; audit: { decidedBy: string } };
  assert(r1.status === 200, "返回 200");
  assert(j1.ok === true, "ok=true");
  assert(j1.audit.decidedBy === "auto", "审计 decidedBy=auto");

  // ---- 测试 2：经 sessionId 下发 fs.read ----
  console.log("[e2e] 测试2: POST /v1/sessions/:sessionId/tool (fs.read)");
  const r2 = await fetch(`http://localhost:${PORT}/v1/sessions/${sessionId}/tool`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "fs.read", params: { path: "~/notes.txt" }, risk: "low" }),
  });
  const j2 = (await r2.json()) as { ok: boolean; data: { echoed: string } };
  assert(r2.status === 200, "返回 200");
  assert(j2.ok === true && j2.data.echoed === "fs.read", "回传 data 正确关联");

  // ---- 测试 3：向离线客户端下发应得 409 ----
  console.log("[e2e] 测试3: 向离线 client 下发");
  const r3 = await fetch(`http://localhost:${PORT}/v1/clients/nobody/tool`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool: "notify", params: { title: "x", body: "y" } }),
  });
  assert(r3.status === 409, "返回 409 client_offline");

  server.close();
  console.log("\n[e2e] 全部通过 ✅");
  process.exit(0);
}

main().catch((e) => {
  console.error("\n[e2e] 失败 ❌:", e);
  process.exit(1);
});
