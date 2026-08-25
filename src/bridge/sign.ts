import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as ecdsaSign,
  timingSafeEqual,
  verify as ecdsaVerify,
} from "node:crypto";

/**
 * 握手签名 / 校验（云端侧）。
 *
 * hello 方向（客户端 → 云端）：客户端用 CLIENT_SECRET 对 `${clientId}:${userId}:${nonce}:${ts}`
 * 做 HMAC-SHA256；云端用同一密钥校验。userId 与 nonce 被签名覆盖，防中间人篡改归属与重放。
 *
 * welcome 方向（云端 → 客户端）：配置了 BRIDGE_SIGNING_PRIVATE_KEY_PEM 时用 ECDSA(P-256) 私钥对
 * `${sessionId}:${userId}:${nonce}:${ts}` 签名，客户端用预置的云端公钥验签——即使握手密钥泄露，
 * 攻击者也无法伪造云端端点（没有私钥）。未配置私钥时退化 HMAC（仅限本机联调）。
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

/** 校验客户端 hello 签名（覆盖 clientId + userId + nonce），并拒绝过期（防重放） */
export function verifyHello(
  clientId: string,
  userId: string,
  nonce: string,
  ts: number,
  signature: string,
  secret: string,
  maxAgeMs: number,
): { ok: true } | { ok: false; reason: string } {
  const now = Date.now();
  if (Math.abs(now - ts) > maxAgeMs) {
    return { ok: false, reason: "hello timestamp 过期（疑似重放）" };
  }
  const expected = sign(`${clientId}:${userId}:${nonce}:${ts}`, secret);
  if (!safeEqual(expected, signature)) {
    return { ok: false, reason: "hello 签名校验失败" };
  }
  return { ok: true };
}

/** welcome 的 HMAC 签名（dev 退化路径，未配置私钥时使用） */
export function signWelcome(
  sessionId: string,
  userId: string,
  nonce: string,
  ts: number,
  secret: string,
): string {
  return sign(`${sessionId}:${userId}:${nonce}:${ts}`, secret);
}

/** welcome 的 ECDSA(P-256) 签名（生产路径）。返回 base64 编码的 DER 签名。 */
export function signWelcomeECDSA(
  sessionId: string,
  userId: string,
  nonce: string,
  ts: number,
  privateKeyPem: string,
): string {
  const key = createPrivateKey(privateKeyPem);
  const signature = ecdsaSign("sha256", Buffer.from(`${sessionId}:${userId}:${nonce}:${ts}`), key);
  return signature.toString("base64");
}

/** 校验 welcome 的 ECDSA 签名（客户端预置云端公钥；也用于测试/仿真器）。 */
export function verifyWelcomeECDSA(
  sessionId: string,
  userId: string,
  nonce: string,
  ts: number,
  signature: string,
  publicKeyPem: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return ecdsaVerify(
      "sha256",
      Buffer.from(`${sessionId}:${userId}:${nonce}:${ts}`),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}
