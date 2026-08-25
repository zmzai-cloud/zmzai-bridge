import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * 握手签名 / 校验（云端侧）。
 *
 * 客户端用 CLIENT_SECRET 对 `${clientId}:${ts}` 做 HMAC-SHA256；云端用同一密钥校验。
 * welcome 用同一密钥对 `${sessionId}:${ts}` 签名（客户端当前未强制验签，预留升级空间）。
 *
 * 生产化建议（见 README）：升级为非对称签名 —— 客户端持有云端公钥验签 welcome，
 * 云端用私钥签名；CLIENT_SECRET 仅在客户端 -> 云端方向用于身份声明。
 */
export function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** 时序安全比较，防时序侧信道 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** 校验客户端 hello 签名，并拒绝过期（防重放） */
export function verifyHello(
  clientId: string,
  ts: number,
  signature: string,
  secret: string,
  maxAgeMs: number,
): { ok: true } | { ok: false; reason: string } {
  const now = Date.now();
  if (Math.abs(now - ts) > maxAgeMs) {
    return { ok: false, reason: "hello timestamp 过期（疑似重放）" };
  }
  const expected = sign(`${clientId}:${ts}`, secret);
  if (!safeEqual(expected, signature)) {
    return { ok: false, reason: "hello 签名校验失败" };
  }
  return { ok: true };
}

/** 云端对 welcome 的签名 */
export function signWelcome(sessionId: string, ts: number, secret: string): string {
  return sign(`${sessionId}:${ts}`, secret);
}
