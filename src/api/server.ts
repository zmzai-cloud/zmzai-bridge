import type { Server, IncomingMessage, ServerResponse } from "node:http";
import { ToolName, RiskLevel } from "../shared/protocol.js";
import { ClientRegistry, type DispatchError, type DispatchRequest } from "../bridge/registry.js";
import { AuditSink } from "../bridge/audit-sink.js";
import type { BridgeConfig } from "../config.js";

interface JsonBody {
  id?: string;
  tool?: string;
  params?: unknown;
  risk?: string;
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function isDispatchError(e: unknown): e is DispatchError {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { code?: string }).code !== undefined
  );
}

function statusForError(e: DispatchError): number {
  switch (e.code) {
    case "client_offline":
      return 409;
    case "send_failed":
      return 502;
    case "timeout":
      return 504;
    case "rate_limited":
      return 429;
  }
}

/**
 * 内部 Agent 调度 API（与 WebSocket 共用同一端口）。
 *
 * 鉴权：Bearer INTERNAL_API_TOKEN。ALLOW_INSECURE_LOCAL=true 时跳过（仅本机联调）。
 * 调用方：zmzai-relay 等云端 Agent 后端，当需要把某次工具执行落到用户本机时，
 * 调用 POST /v1/users/:userId/tool（生产主入口），云端按 userId 路由到该用户当前
 * 在线的桌面客户端，经反向隧道下发，等其执行（含本地审批）后把 tool_result 回传，
 * 作为 HTTP 响应返回。
 *
 * 执行边界：云端沙箱（zmzai-sandbox）在云端容器内执行，不经过本桥；
 * 本桥只服务「用户本机」能力。
 */
export function attachApi(
  server: Server,
  config: BridgeConfig,
  registry: ClientRegistry,
  auditSink: AuditSink,
): void {
  server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;

    // 健康检查
    if (req.method === "GET" && p === "/healthz") {
      return sendJson(res, 200, { ok: true, ts: Date.now() });
    }

    // 鉴权（本机非安全模式除外）
    if (!config.allowInsecureLocal) {
      const auth = req.headers["authorization"] ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (token !== config.internalApiToken) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
    }

    try {
      // 列出客户端
      if (req.method === "GET" && p === "/v1/clients") {
        return sendJson(res, 200, {
          clients: registry.listClients().map((c) => ({
            clientId: c.clientId,
            userId: c.userId,
            sessionId: c.sessionId,
            connectedAt: c.connectedAt,
            lastSeen: c.lastSeen,
          })),
        });
      }

      // 列出会话
      if (req.method === "GET" && p === "/v1/sessions") {
        return sendJson(res, 200, { sessions: registry.listSessions() });
      }

      // 审计查询：GET /v1/audit?limit=100（客户端经 audit_report 上送，用于跨端复盘）
      if (req.method === "GET" && p === "/v1/audit") {
        const limit = Number(url.searchParams.get("limit") ?? "100");
        return sendJson(res, 200, {
          total: auditSink.count(),
          records: auditSink.recent(Number.isFinite(limit) ? limit : 100),
        });
      }

      // 查询用户当前绑定的客户端：GET /v1/users/:userId
      const userGetMatch = p.match(/^\/v1\/users\/([^/]+)$/);
      if (req.method === "GET" && userGetMatch) {
        const userId = decodeURIComponent(userGetMatch[1]);
        const clientId = registry.getClientIdByUser(userId);
        if (!clientId) {
          return sendJson(res, 404, { error: "user_not_bound", message: `用户 ${userId} 未绑定在线客户端` });
        }
        const conn = registry.listClients().find((c) => c.clientId === clientId);
        return sendJson(res, 200, {
          userId,
          clientId,
          sessionId: conn?.sessionId,
          connectedAt: conn?.connectedAt,
          lastSeen: conn?.lastSeen,
        });
      }

      // 按用户下发工具请求：POST /v1/users/:userId/tool（生产主入口）
      const userMatch = p.match(/^\/v1\/users\/([^/]+)\/tool$/);
      if (req.method === "POST" && userMatch) {
        const userId = decodeURIComponent(userMatch[1]);
        const body = await readBody(req);
        const json = body ? (JSON.parse(body) as JsonBody) : {};
        const result = await doDispatch(registry, "user", userId, json);
        return sendJson(res, 200, result);
      }

      // 向 session 下发工具请求：POST /v1/sessions/:sessionId/tool
      const sessMatch = p.match(/^\/v1\/sessions\/([^/]+)\/tool$/);
      if (req.method === "POST" && sessMatch) {
        const sessionId = decodeURIComponent(sessMatch[1]);
        const body = await readBody(req);
        const json = body ? (JSON.parse(body) as JsonBody) : {};
        const result = await doDispatch(registry, "session", sessionId, json);
        return sendJson(res, 200, result);
      }

      // 向 clientId 下发工具请求：POST /v1/clients/:clientId/tool
      const clientMatch = p.match(/^\/v1\/clients\/([^/]+)\/tool$/);
      if (req.method === "POST" && clientMatch) {
        const clientId = decodeURIComponent(clientMatch[1]);
        const body = await readBody(req);
        const json = body ? (JSON.parse(body) as JsonBody) : {};
        const result = await doDispatch(registry, "client", clientId, json);
        return sendJson(res, 200, result);
      }

      return sendJson(res, 404, { error: "not found" });
    } catch (e) {
      if (isDispatchError(e)) {
        return sendJson(res, statusForError(e), { error: e.code, message: e.message });
      }
      const message = e instanceof Error ? e.message : String(e);
      return sendJson(res, 400, { error: "bad_request", message });
    }
  });
}

async function doDispatch(
  registry: ClientRegistry,
  target: "session" | "client" | "user",
  id: string,
  json: JsonBody,
): Promise<unknown> {
  // 校验 tool
  const toolParsed = ToolName.safeParse(json.tool);
  if (!toolParsed.success) {
    throw { code: "send_failed", message: `非法 tool: ${String(json.tool)}` } as DispatchError;
  }
  // 校验 risk
  const risk = json.risk === undefined ? "medium" : RiskLevel.safeParse(json.risk);
  const riskVal = risk === "medium" ? "medium" : risk.success ? risk.data : "medium";

  const req: DispatchRequest = {
    id: json.id,
    tool: toolParsed.data,
    params: json.params,
    risk: risk === "medium" ? "medium" : riskVal,
  };

  if (target === "session") return registry.dispatchToSession(id, req);
  if (target === "user") return registry.dispatchToUser(id, req);
  return registry.dispatchToClient(id, req);
}
