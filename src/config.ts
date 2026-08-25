import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 极简 .env 解析器（与 zmzai-client 一致，无需额外依赖） */
function loadDotEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      out[key] = val;
    }
  } catch {
    /* 无 .env 也可运行（全部走 env 变量） */
  }
  return out;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

function int(v: string | undefined, fallback: number): number {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export interface BridgeConfig {
  port: number;
  bridgePath: string;
  internalApiToken: string;
  allowInsecureLocal: boolean;
  clientSecretsJson: string;
  helloMaxAgeMs: number;
  dispatchTimeoutMs: number;
  /** ECDSA(P-256) 私钥 PEM，用于签 welcome（防伪造云端端点）。缺省退化 HMAC（仅本机联调）。 */
  signingPrivateKeyPem: string | null;
  /** 每 clientId 每分钟最大 dispatch 次数；0 = 不限（默认，生产务必显式配置） */
  dispatchRateLimitPerMinute: number;
  /** 审计上送的可选 JSONL 落盘路径；null = 仅内存 */
  auditFilePath: string | null;
}

export function loadConfig(envFile = ".env"): BridgeConfig {
  const file = loadDotEnv(resolve(process.cwd(), envFile));
  const get = (k: string, fallback?: string) =>
    process.env[k] ?? file[k] ?? fallback ?? "";

  return {
    port: int(process.env.PORT ?? file.PORT, 8787),
    bridgePath: get("BRIDGE_PATH", "/bridge"),
    internalApiToken: get("INTERNAL_API_TOKEN", "dev-internal-token-change-me"),
    allowInsecureLocal: bool(get("ALLOW_INSECURE_LOCAL", "false"), false),
    clientSecretsJson: get("CLIENT_SECRETS", '{"demo-client":"demo-secret"}'),
    helloMaxAgeMs: int(get("HELLO_MAX_AGE_MS", "300000"), 300_000),
    dispatchTimeoutMs: int(get("DISPATCH_TIMEOUT_MS", "120000"), 120_000),
    signingPrivateKeyPem: get("BRIDGE_SIGNING_PRIVATE_KEY_PEM", "") || null,
    dispatchRateLimitPerMinute: int(get("DISPATCH_RATE_LIMIT_PER_MINUTE", "0"), 0),
    auditFilePath: get("AUDIT_FILE_PATH", "") || null,
  };
}
