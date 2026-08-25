import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type { AuditRecord, RiskLevel, ToolName } from "../shared/protocol.js";
import { PROTOCOL_VERSION } from "../shared/protocol.js";

export interface ClientConn {
  clientId: string;
  /** 客户端 hello 中声明的归属用户（被签名覆盖） */
  userId: string;
  ws: WebSocket;
  sessionId: string;
  connectedAt: number;
  lastSeen: number;
}

/** Agent 下发的工具请求体（云端构造，转发给客户端） */
export interface DispatchRequest {
  id?: string;
  tool: ToolName;
  params: unknown;
  risk?: RiskLevel;
}

/** 客户端回传的结果（云端关联后返回给 Agent） */
export interface DispatchResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  audit: AuditRecord;
}

export type DispatchError =
  | { code: "client_offline"; message: string }
  | { code: "timeout"; message: string }
  | { code: "send_failed"; message: string };

type Pending = {
  clientId: string;
  resolve: (r: DispatchResult) => void;
  reject: (e: DispatchError) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * 客户端注册表 + 会话路由 + 请求关联。
 *
 * 内存实现（单实例）。多副本横向扩展时需改为 Redis 等共享存储，
 * 并在 dispatch 时做「定向转发到持有该 session 的实例」（见 README 扩展点）。
 */
export class ClientRegistry {
  private clients = new Map<string, ClientConn>();
  private sessions = new Map<string, string>(); // sessionId -> clientId
  private users = new Map<string, string>(); // userId -> clientId（一个用户当前在线的客户端，最新生效）
  private pending = new Map<string, Pending>();

  constructor(private dispatchTimeoutMs: number) {}

  /** 客户端完成握手后注册，返回分配的 sessionId；userId 建立用户绑定（最新连接覆盖旧绑定） */
  register(clientId: string, userId: string, ws: WebSocket): string {
    const sessionId = randomUUID();
    this.clients.set(clientId, {
      clientId,
      userId,
      ws,
      sessionId,
      connectedAt: Date.now(),
      lastSeen: Date.now(),
    });
    this.sessions.set(sessionId, clientId);
    const prev = this.users.get(userId);
    if (prev && prev !== clientId) {
      console.log(`[bridge] 用户 ${userId} 的绑定从 ${prev} 切换到 ${clientId}`);
    }
    this.users.set(userId, clientId);
    return sessionId;
  }

  unregister(clientId: string): void {
    const conn = this.clients.get(clientId);
    if (!conn) return;
    this.clients.delete(clientId);
    this.sessions.delete(conn.sessionId);
    // 仅当该 userId 仍指向本 clientId 时才清除绑定（避免误删新连接的绑定）
    if (this.users.get(conn.userId) === clientId) {
      this.users.delete(conn.userId);
    }
    // 该客户端上所有未决请求判为离线
    for (const [id, p] of this.pending) {
      if (p.clientId !== clientId) continue;
      clearTimeout(p.timer);
      p.reject({
        code: "client_offline",
        message: `客户端 ${clientId} 已断开，请求 ${id} 无法完成`,
      });
      this.pending.delete(id);
    }
  }

  /** 心跳更新 */
  touch(clientId: string): void {
    const conn = this.clients.get(clientId);
    if (conn) conn.lastSeen = Date.now();
  }

  getSessionId(clientId: string): string | undefined {
    return this.clients.get(clientId)?.sessionId;
  }

  getClientIdBySession(sessionId: string): string | undefined {
    return this.sessions.get(sessionId);
  }

  /** 查询某用户当前在线的客户端（未绑定 / 离线返回 undefined） */
  getClientIdByUser(userId: string): string | undefined {
    const clientId = this.users.get(userId);
    if (!clientId) return undefined;
    return this.clients.has(clientId) ? clientId : undefined;
  }

  listClients(): ClientConn[] {
    return [...this.clients.values()];
  }

  listSessions(): { sessionId: string; clientId: string }[] {
    return [...this.sessions.entries()].map(([sessionId, clientId]) => ({
      sessionId,
      clientId,
    }));
  }

  /** 向指定 session 下发工具请求，等待客户端回传结果 */
  async dispatchToSession(sessionId: string, req: DispatchRequest): Promise<DispatchResult> {
    const clientId = this.sessions.get(sessionId);
    if (!clientId) {
      throw { code: "client_offline", message: `会话 ${sessionId} 未连接` } as DispatchError;
    }
    return this.dispatchToClient(clientId, req);
  }

  /** 按用户路由（生产主入口）：下发到该用户当前在线的客户端 */
  async dispatchToUser(userId: string, req: DispatchRequest): Promise<DispatchResult> {
    const clientId = this.getClientIdByUser(userId);
    if (!clientId) {
      throw {
        code: "client_offline",
        message: `用户 ${userId} 当前没有在线的桌面客户端`,
      } as DispatchError;
    }
    return this.dispatchToClient(clientId, req);
  }

  /** 向指定 clientId 的活跃 session 下发工具请求 */
  async dispatchToClient(clientId: string, req: DispatchRequest): Promise<DispatchResult> {    const conn = this.clients.get(clientId);
    if (!conn) {
      throw { code: "client_offline", message: `客户端 ${clientId} 未连接` } as DispatchError;
    }
    const id = req.id ?? randomUUID();
    const issuedAt = Date.now();

    return new Promise<DispatchResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({
          code: "timeout",
          message: `请求 ${id} 在 ${this.dispatchTimeoutMs}ms 内无响应（可能用户在审批或客户端卡死）`,
        });
      }, this.dispatchTimeoutMs);

      this.pending.set(id, { clientId, resolve, reject, timer });

      const envelope = {
        kind: "tool_request",
        v: PROTOCOL_VERSION,
        id,
        tool: req.tool,
        params: req.params,
        risk: req.risk ?? "medium",
        issuedAt,
      };
      try {
        if (conn.ws.readyState === conn.ws.OPEN) {
          conn.ws.send(JSON.stringify(envelope));
        } else {
          clearTimeout(timer);
          this.pending.delete(id);
          reject({ code: "send_failed", message: `客户端 ${clientId} 连接已不可用` } as DispatchError);
        }
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject({
          code: "send_failed",
          message: `下发失败: ${e instanceof Error ? e.message : String(e)}`,
        } as DispatchError);
      }
    });
  }

  /** 客户端回传 tool_result 时由 WS 层调用，关联并解决对应 Promise */
  onToolResult(id: string, result: DispatchResult): void {
    const p = this.pending.get(id);
    if (!p) return; // 未知 / 已超时
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(result);
  }
}
