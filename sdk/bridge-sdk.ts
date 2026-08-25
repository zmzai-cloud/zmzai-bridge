/**
 * Bridge SDK —— 供 zmzai-relay / zmzai-sandbox 等云端服务调用桥接端点。
 *
 * 这是「可 vendored 的轻量客户端」：把它整文件复制到调用方仓库即可（无额外依赖，仅用 fetch）。
 * 使用方式：
 *   const bridge = new BridgeClientSdk("https://b.zmzai.cloud", process.env.BRIDGE_TOKEN);
 *   const res = await bridge.dispatchToSession(sessionId, "fs.read", { path: "~/notes.txt" });
 *   if (res.ok) console.log(res.data);
 *
 * 注意：即使云端成功下发，客户端本地仍可能弹出用户审批（fs.write / shell.exec 必审），
 * 因此 dispatch 可能耗时较长 —— 调用方应设合理的客户端超时（HTTP 侧由桥接的 DISPATCH_TIMEOUT_MS 控制）。
 */
import type { AuditRecord, RiskLevel, ToolName } from "../src/shared/protocol.js";

export interface DispatchResult {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
  audit: AuditRecord;
}

export interface DispatchOptions {
  id?: string;
  risk?: RiskLevel;
  /** 覆盖底层 fetch 超时（毫秒） */
  timeoutMs?: number;
}

export class BridgeError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export class BridgeClientSdk {
  constructor(
    private baseUrl: string,
    private token: string,
  ) {}

  private async post(path: string, body: unknown, timeoutMs?: number): Promise<DispatchResult> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs ?? 120_000);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        throw new BridgeError(
          res.status,
          String(json.error ?? "error"),
          String(json.message ?? res.statusText),
        );
      }
      return json as unknown as DispatchResult;
    } finally {
      clearTimeout(t);
    }
  }

  async dispatchToSession(
    sessionId: string,
    tool: ToolName,
    params: unknown,
    opts: DispatchOptions = {},
  ): Promise<DispatchResult> {
    return this.post(
      `/v1/sessions/${encodeURIComponent(sessionId)}/tool`,
      { id: opts.id, tool, params, risk: opts.risk },
      opts.timeoutMs,
    );
  }

  async dispatchToClient(
    clientId: string,
    tool: ToolName,
    params: unknown,
    opts: DispatchOptions = {},
  ): Promise<DispatchResult> {
    return this.post(
      `/v1/clients/${encodeURIComponent(clientId)}/tool`,
      { id: opts.id, tool, params, risk: opts.risk },
      opts.timeoutMs,
    );
  }

  async listClients(): Promise<{ clients: unknown[] }> {
    const res = await fetch(`${this.baseUrl}/v1/clients`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    return (await res.json()) as { clients: unknown[] };
  }

  async listSessions(): Promise<{ sessions: { sessionId: string; clientId: string }[] }> {
    const res = await fetch(`${this.baseUrl}/v1/sessions`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    return (await res.json()) as { sessions: { sessionId: string; clientId: string }[] };
  }
}
