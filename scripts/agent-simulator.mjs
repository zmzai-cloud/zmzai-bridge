/**
 * Agent 仿真器（手动联调用）：调用桥接内部 API 向某客户端/会话下发工具请求。
 * 运行：先起桥接 + 客户端仿真器，再 `node scripts/agent-simulator.mjs`
 *
 * 用法：
 *   node scripts/agent-simulator.mjs <clientId> <tool> '<jsonParams>'
 *   node scripts/agent-simulator.mjs --session <sessionId> <tool> '<jsonParams>'
 * 环境变量：PORT / INTERNAL_API_TOKEN
 */
const PORT = process.env.PORT ?? "8787";
const TOKEN = process.env.INTERNAL_API_TOKEN ?? "dev-internal-token-change-me";

const args = process.argv.slice(2);
let target = "client";
let clientOrSession = "demo-client";
let tool = "notify";
let params = { title: "Hello", body: "from agent-sim" };

if (args[0] === "--session") {
  target = "session";
  clientOrSession = args[1];
  tool = args[2] ?? tool;
  if (args[3]) params = JSON.parse(args[3]);
} else if (args.length > 0) {
  clientOrSession = args[0];
  tool = args[1] ?? tool;
  if (args[2]) params = JSON.parse(args[2]);
}

const base = `http://localhost:${PORT}`;
const path =
  target === "session"
    ? `/v1/sessions/${encodeURIComponent(clientOrSession)}/tool`
    : `/v1/clients/${encodeURIComponent(clientOrSession)}/tool`;

console.log(`[sim-agent] POST ${base}${path}  tool=${tool}`);
const res = await fetch(`${base}${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ tool, params, risk: "medium" }),
});
const json = await res.json();
console.log(`[sim-agent] HTTP ${res.status}`);
console.log(JSON.stringify(json, null, 2));
