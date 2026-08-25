import { WebSocketServer, type WebSocket } from "ws";
import { Envelope, PROTOCOL_VERSION } from "../shared/protocol.js";
import { signWelcome, signWelcomeECDSA, verifyHello } from "./sign.js";
import { ClientRegistry } from "./registry.js";
import { SecretStore } from "./secrets.js";
import { AuditSink } from "./audit-sink.js";
import type { BridgeConfig } from "../config.js";

const HEARTBEAT_MS = 25_000;
const HELLO_TIMEOUT_MS = 10_000;
/** 超过该时间未收到 pong 则判定连接已死 */
const DEAD_AFTER_MS = HEARTBEAT_MS * 2 + 5_000;

/**
 * 把桥接 WebSocket 挂到已有的 HTTP server 上（同一端口同时承载 /bridge 与 /v1/*）。
 * 仅接受 BRIDGE_PATH 的升级请求；其余升级直接销毁。
 */
export function attachBridgeWs(
  server: import("node:http").Server,
  config: BridgeConfig,
  registry: ClientRegistry,
  secrets: SecretStore,
  auditSink: AuditSink,
): void {
  const wss = new WebSocketServer({ noServer: true });
  const pathname = config.bridgePath;

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== pathname) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    let clientId: string | undefined;
    let authed = false;
    let lastPong = Date.now();
    const hb = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      if (Date.now() - lastPong > DEAD_AFTER_MS) {
        ws.terminate();
        return;
      }
      ws.ping();
    }, HEARTBEAT_MS);
    const helloTimer = setTimeout(() => {
      if (!authed) ws.terminate();
    }, HELLO_TIMEOUT_MS);

    ws.on("pong", () => {
      lastPong = Date.now();
    });

    ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const parsed = Envelope.safeParse(msg);
      if (!parsed.success) {
        console.warn(`[bridge] 丢弃非法信封: ${parsed.error.message}`);
        return;
      }
      const env = parsed.data;
      switch (env.kind) {
        case "hello": {
          if (authed) return; // 只接受一次握手
          const secret = secrets.getSecret(env.clientId);
          if (!secret) {
            console.warn(`[bridge] 未知 clientId: ${env.clientId}`);
            ws.close(4001, "unknown client");
            return;
          }
          const v = verifyHello(
            env.clientId,
            env.userId,
            env.nonce,
            env.ts,
            env.signature,
            secret,
            config.helloMaxAgeMs,
          );
          if (!v.ok) {
            console.warn(`[bridge] hello 校验失败 (${env.clientId}): ${v.reason}`);
            ws.close(4003, v.reason);
            return;
          }
          clientId = env.clientId;
          authed = true;
          clearTimeout(helloTimer);
          const sessionId = registry.register(clientId, env.userId, ws);
          const ts = Date.now();
          // 生产：ECDSA 私钥签 welcome（防伪造云端端点）；未配置私钥时退化 HMAC（本机联调）。
          const signature = config.signingPrivateKeyPem
            ? signWelcomeECDSA(sessionId, env.userId, env.nonce, ts, config.signingPrivateKeyPem)
            : signWelcome(sessionId, env.userId, env.nonce, ts, secret);
          ws.send(
            JSON.stringify({
              kind: "welcome",
              v: 3,
              sessionId,
              userId: env.userId,
              nonce: env.nonce,
              ts,
              signature,
            }),
          );
          console.log(
            `[bridge] 客户端已连接 clientId=${clientId} userId=${env.userId} session=${sessionId} ` +
              (config.signingPrivateKeyPem ? "(welcome=ECDSA)" : "(welcome=HMAC dev)"),
          );
          break;
        }
        case "pong":
          lastPong = Date.now();
          break;
        case "ping":
          ws.send(JSON.stringify({ kind: "pong", v: PROTOCOL_VERSION, ts: Date.now() }));
          break;
        case "tool_result": {
          if (!authed) return;
          registry.onToolResult(env.id, {
            id: env.id,
            ok: env.ok,
            data: env.data,
            error: env.error,
            audit: env.audit,
          });
          break;
        }
        case "audit_report": {
          if (!authed) return;
          auditSink.append(env.audit);
          break;
        }
        default:
          break;
      }
    });

    ws.on("close", () => {
      clearInterval(hb);
      clearTimeout(helloTimer);
      if (clientId) {
        console.log(`[bridge] 客户端断开 clientId=${clientId}`);
        registry.unregister(clientId);
      }
    });

    ws.on("error", (err) => {
      console.warn(`[bridge] ws error: ${err.message}`);
    });
  });
}
