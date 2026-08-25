/**
 * 生成握手用 ECDSA(P-256) 密钥对（welcome 签名，防伪造云端端点）。
 *
 * 用法：node scripts/generate-keypair.mjs
 * 输出两段 PEM，分别配置到：
 *   - bridge .env  ：BRIDGE_SIGNING_PRIVATE_KEY_PEM=<私钥>（云端持有，绝不外泄）
 *   - client .env  ：BRIDGE_PUBLIC_KEY_PEM=<公钥>（桌面客户端预置，用于验签 welcome）
 *
 * 注意：生产环境私钥应通过密钥管理服务（KMS/Vault）注入，不要写死在 .env 里入库。
 */
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});

console.log("=== bridge .env: BRIDGE_SIGNING_PRIVATE_KEY_PEM ===");
console.log(privateKey.export({ type: "pkcs8", format: "pem" }));
console.log("=== client .env: BRIDGE_PUBLIC_KEY_PEM ===");
console.log(publicKey.export({ type: "spki", format: "pem" }));
