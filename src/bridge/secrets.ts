/**
 * 客户端密钥存储。
 *
 * 当前实现从环境变量 CLIENT_SECRETS（JSON: { clientId: secret }）读取。
 * 生产应替换为从密钥管理服务 / 数据库读取（实现同一 SecretStore 接口即可），
 * 例如对接 zmzai-relay 的 apikey 体系，让桌面客户端的 clientId/secret
 * 与用户在 relay 后台创建的「桥接密钥」一致。
 */
export interface SecretStore {
  getSecret(clientId: string): string | undefined;
}

export class EnvSecretStore implements SecretStore {
  private map: Map<string, string>;

  constructor(json: string) {
    this.map = new Map();
    try {
      const parsed = JSON.parse(json) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && v.length > 0) this.map.set(k, v);
      }
    } catch {
      // 忽略非法 JSON，仅以空存储运行（所有握手都会失败，便于尽早暴露配置问题）
    }
  }

  getSecret(clientId: string): string | undefined {
    return this.map.get(clientId);
  }

  count(): number {
    return this.map.size;
  }
}
