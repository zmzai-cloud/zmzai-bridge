/**
 * zmzai 客户端 ↔ 云端桥接协议（云端侧副本）
 *
 * 此文件与 zmzai-client/src/shared/protocol.ts 必须保持【逐字节一致】的契约。
 * 当前两份独立维护（两个独立仓库）；后续可抽成 @zmzai/bridge-protocol 共享包。
 *
 * 关键约定：
 * - 客户端主动建立【出站】WebSocket 到云端 /bridge，云端经此下发工具请求（反向隧道）。
 * - 握手：客户端发 hello{HMAC(clientSecret, clientId:ts)}；云端校验后用同一密钥签 welcome。
 * - 云端发 tool_request{id, tool, params, risk}；客户端回 tool_result{id, ok, data?, error?, audit}，
 *   其中 id 全程透传，便于云端把结果关联回发起请求的 Agent。
 */
import { z } from "zod";

export const PROTOCOL_VERSION = 1 as const;

/** 本地可向云端暴露的能力 */
export const ToolName = z.enum(["fs.read", "fs.write", "shell.exec", "notify"]);
export type ToolName = z.infer<typeof ToolName>;

/** 风险分级：决定客户端是否需要本地用户审批 */
export const RiskLevel = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof RiskLevel>;

export const FsReadParams = z.object({
  path: z.string().min(1),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  maxBytes: z.number().int().positive().max(5_000_000).default(200_000),
});
export type FsReadParams = z.infer<typeof FsReadParams>;

export const FsWriteParams = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
});
export type FsWriteParams = z.infer<typeof FsWriteParams>;

export const ShellExecParams = z.object({
  command: z.string().min(1).max(2000),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().max(300_000).optional(),
});
export type ShellExecParams = z.infer<typeof ShellExecParams>;

export const NotifyParams = z.object({
  title: z.string().min(1).max(120),
  body: z.string().max(500),
  urgency: z.enum(["low", "normal", "critical"]).default("normal"),
});
export type NotifyParams = z.infer<typeof NotifyParams>;

export const AuditRecord = z.object({
  id: z.string(),
  clientId: z.string(),
  tool: ToolName,
  risk: RiskLevel,
  approved: z.boolean(),
  decidedBy: z.enum(["auto", "user", "policy"]),
  startedAt: z.number(),
  finishedAt: z.number(),
  summary: z.string(),
});
export type AuditRecord = z.infer<typeof AuditRecord>;

export const Envelope = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("hello"),
    v: z.literal(PROTOCOL_VERSION),
    clientId: z.string().min(1),
    ts: z.number().int().positive(),
    signature: z.string().min(1),
  }),
  z.object({
    kind: z.literal("welcome"),
    v: z.literal(PROTOCOL_VERSION),
    sessionId: z.string().min(1),
    ts: z.number().int().positive(),
    signature: z.string().min(1),
  }),
  z.object({
    kind: z.literal("tool_request"),
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().min(1),
    tool: ToolName,
    params: z.unknown(),
    risk: RiskLevel.default("medium"),
    issuedAt: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("tool_result"),
    v: z.literal(PROTOCOL_VERSION),
    id: z.string().min(1),
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: z.string().optional(),
    audit: AuditRecord,
  }),
  z.object({ kind: z.literal("ping"), v: z.literal(PROTOCOL_VERSION), ts: z.number().int().positive() }),
  z.object({ kind: z.literal("pong"), v: z.literal(PROTOCOL_VERSION), ts: z.number().int().positive() }),
]);
export type Envelope = z.infer<typeof Envelope>;

export function parseParams(tool: ToolName, params: unknown) {
  switch (tool) {
    case "fs.read":
      return FsReadParams.parse(params);
    case "fs.write":
      return FsWriteParams.parse(params);
    case "shell.exec":
      return ShellExecParams.parse(params);
    case "notify":
      return NotifyParams.parse(params);
  }
}
