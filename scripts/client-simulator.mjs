/**
 * 客户端仿真器（手动联调用）：模拟桌面客户端连上真实桥接服务，
 * 自动批准工具请求并执行（fs.read/fs.write 真实读写，shell.exec 真实执行，notify 仅打印）。
 * 运行：先 `pnpm dev` 起桥接，再 `node scripts/client-simulator.mjs`
 * 可用环境变量：PORT / BRIDGE_PATH / CLIENT_ID / CLIENT_SECRET / USER_ID
 */
import { WebSocket } from "ws";
import { createHmac } from "node:crypto";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const PORT = process.env.PORT ?? "8787";
const BRIDGE_PATH = process.env.BRIDGE_PATH ?? "/bridge";
const CLIENT_ID = process.env.CLIENT_ID ?? "demo-client";
const CLIENT_SECRET = process.env.CLIENT_SECRET ?? "demo-secret";
const USER_ID = process.env.USER_ID ?? "demo-user";

const execAsync = promisify(exec);
const expand = (p) => (p.startsWith("~") ? resolve(homedir(), p.slice(1)) : p);

const ws = new WebSocket(`ws://localhost:${PORT}${BRIDGE_PATH}`);

ws.on("open", () => {
  const ts = Date.now();
  ws.send(
    JSON.stringify({
      kind: "hello",
      v: 2,
      clientId: CLIENT_ID,
      userId: USER_ID,
      ts,
      signature: createHmac("sha256", CLIENT_SECRET)
        .update(`${CLIENT_ID}:${USER_ID}:${ts}`)
        .digest("hex"),
    }),
  );
  console.log(`[sim-client] 已发送 hello (clientId=${CLIENT_ID}, userId=${USER_ID})`);
});

ws.on("message", async (raw) => {
  const msg = JSON.parse(raw.toString());
  if (msg.kind === "welcome") {
    console.log(`[sim-client] 已连接，session=${msg.sessionId}`);
    return;
  }
  if (msg.kind === "ping") {
    ws.send(JSON.stringify({ kind: "pong", v: 1, ts: Date.now() }));
    return;
  }
  if (msg.kind === "tool_request") {
    console.log(`[sim-client] 收到工具请求 ${msg.tool} (risk=${msg.risk}) id=${msg.id}`);
    const startedAt = msg.issuedAt;
    let ok = true;
    let data;
    let error;
    try {
      // 仿真器中默认「用户点击允许」，直接执行
      if (msg.tool === "notify") {
        console.log(`  🔔 ${msg.params.title}: ${msg.params.body}`);
        data = { notified: true };
      } else if (msg.tool === "fs.read") {
        const buf = readFileSync(expand(msg.params.path));
        const content =
          msg.params.encoding === "base64" ? buf.toString("base64") : buf.toString("utf8");
        data = { content, bytes: buf.length };
      } else if (msg.tool === "fs.write") {
        writeFileSync(expand(msg.params.path), msg.params.content);
        data = { written: msg.params.content.length };
      } else if (msg.tool === "shell.exec") {
        const { stdout, stderr } = await execAsync(msg.params.command, {
          cwd: msg.params.cwd ? expand(msg.params.cwd) : undefined,
          timeout: msg.params.timeoutMs ?? 30000,
        });
        data = { stdout, stderr };
      }
    } catch (e) {
      ok = false;
      error = e instanceof Error ? e.message : String(e);
    }
    const audit = {
      id: msg.id,
      clientId: CLIENT_ID,
      tool: msg.tool,
      risk: msg.risk,
      approved: true,
      decidedBy: "user",
      startedAt,
      finishedAt: Date.now(),
      summary: `sim ${msg.tool}`,
    };
    ws.send(
      JSON.stringify({ kind: "tool_result", v: 2, id: msg.id, ok, data, error, audit }),
    );
    console.log(`[sim-client] 已回传结果 ok=${ok}`);
  }
});

ws.on("error", (e) => console.error("[sim-client] error:", e.message));
ws.on("close", () => {
  console.log("[sim-client] 连接关闭");
  process.exit(0);
});
