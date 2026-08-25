# zmzai-bridge

zmzai 云端桥接端点（**b.zmzai.cloud 侧**）。它是桌面客户端 `zmzai-client` 在云端的对应物：

- 终止桌面客户端主动建立的**反向隧道 WebSocket**（客户端在 NAT/防火墙后也能被触达）；
- 做**握手鉴权**（HMAC 校验 `hello`）；
- 维护**客户端注册表 + 会话路由**（`clientId ↔ sessionId ↔ ws`）；
- 暴露**内部调度 API**，让 `zmzai-relay` 等云端 Agent 后端把工具请求下发到用户本机；
- 关联客户端回传的 `tool_result`，作为 HTTP 响应返回给发起请求的 Agent。

```
┌──────────────┐   出站 WS /bridge    ┌────────────────┐   内部 HTTP /v1/*   ┌────────────────┐
│ zmzai-client │ ───────────────────► │  zmzai-bridge  │ ◄───────────────── │  relay / agent │
│ (本机, Electron)│  hello→welcome      │  (本仓库)       │  POST /sessions/:id │  (Agent 后端)   │
│              │ ◄── tool_request      │  注册表+路由    │  /tool             │                 │
│              │ ─── tool_result ───►  │                │                    │                 │
└──────────────┘   (id 透传关联)        └────────────────┘                    └────────────────┘
```

> 安全模型：云端**只能下发请求**，无法绕过客户端的本地审批。`fs.write` / `shell.exec` 在客户端必弹用户审批；`fs.read` 低风险自动放行；`notify` 自动。每次执行都落本地审计日志（见 `zmzai-client`）。

---

## 目录结构

```
zmzai-bridge/
├─ src/
│  ├─ shared/protocol.ts     # 桥接协议契约（与 zmzai-client 必须一致）
│  ├─ config.ts              # .env 解析
│  ├─ bridge/
│  │  ├─ sign.ts             # HMAC 握手签名/校验 + welcome 签名
│  │  ├─ secrets.ts          # 客户端密钥存储（SecretStore 接口，当前读 env）
│  │  ├─ registry.ts         # 客户端注册表 + 会话路由 + 请求关联（pending 超时）
│  │  └─ bridge-ws.ts        # 反向隧道 WS 服务端：握手/心跳/路由 tool_result
│  ├─ api/server.ts          # 内部调度 API（dispatch + 管理查询）
│  └─ index.ts               # 启动入口
├─ sdk/bridge-sdk.ts         # 供 relay 等云端后端 vendored 的轻量调用客户端
├─ scripts/
│  ├─ client-simulator.mjs   # 仿真桌面客户端（手动联调）
│  ├─ agent-simulator.mjs    # 仿真 Agent 调用（手动联调）
│  └─ e2e.ts                 # 自包含端到端测试（无需 Electron）
└─ package.json
```

---

## 本地运行

```bash
pnpm install
cp .env.example .env        # 按需修改
pnpm dev                    # 启动桥接（tsx watch），默认 :8787
```

另开终端，用仿真器联调：

```bash
node scripts/client-simulator.mjs          # 模拟桌面客户端连上
node scripts/agent-simulator.mjs           # 模拟 Agent 下发 notify 到 demo-client
node scripts/agent-simulator.mjs --session <sessionId> fs.read '{"path":"~/x.txt"}'
```

或用真实桌面客户端：把 `zmzai-client` 的 `BRIDGE_URL` 指向 `ws://localhost:8787/bridge`，
并在本仓库 `.env` 的 `CLIENT_SECRETS` 里为它配置相同 `clientId/clientSecret`。

### 自包含 E2E（推荐，无需 Electron）

```bash
pnpm e2e
```

进程内起桥接 + 仿真客户端，验证：握手→会话路由→经 clientId 下发→经 sessionId 下发→离线 409。

---

## 内部 API

所有 `/v1/*` 需 `Authorization: Bearer <INTERNAL_API_TOKEN>`（本机联调可设 `ALLOW_INSECURE_LOCAL=true` 跳过）。

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/v1/users/:userId/tool` | **按用户下发**（生产主入口）：路由到该用户当前在线的客户端 |
| POST | `/v1/sessions/:sessionId/tool` | 向某会话下发工具请求，阻塞等待结果 |
| POST | `/v1/clients/:clientId/tool` | 向某客户端的活跃会话下发 |
| GET  | `/v1/users/:userId` | 查询用户当前绑定的客户端（在线/离线） |
| GET  | `/v1/clients` | 列出已连接客户端（含 userId） |
| GET  | `/v1/sessions` | 列出会话 |
| GET  | `/healthz` | 健康检查 |

请求体：`{ "id"?: string, "tool": "fs.read"\|"fs.write"\|"shell.exec"\|"notify", "params": {...}, "risk"?: "low"\|"medium"\|"high" }`
响应（成功 200）：`{ "id", "ok", "data"? , "error"?, "audit": {...} }`
错误：`409` 客户端离线 / `504` 超时 / `502` 下发失败 / `401` 未授权。

> `id` 全程透传：Agent 可自带 id 以便关联；不传则由桥接生成。客户端回传 `tool_result` 时原样带回，桥接据此 resolve 对应 HTTP 请求。

---

## 执行边界（重要）

- **云端执行**：`zmzai-sandbox` 的代码/命令在**云端沙箱容器内**执行，**不经过本桥**，也不需要走到用户机器。
- **本机执行**：只有当 Agent 需要操作**用户自己的真实机器**（本机文件读写 / 本机命令 / 系统通知）时，
  才由 `zmzai-relay` 等云端 Agent 后端经本桥下发到桌面客户端，由用户在本地审批后执行。

一句话：**沙箱留在云端，桥只服务「用户本机」这一条路径。**

---

## 与 relay 的对接

`zmzai-relay` 等云端 Agent 后端在需要「把工具执行落到用户本机」时，调用本服务的调度 API：

1. 把 `sdk/bridge-sdk.ts` 整文件复制到调用方仓库（无额外依赖）。
2. 用内部 Token 构造 `new BridgeClientSdk("https://b.zmzai.cloud", BRIDGE_TOKEN)`。
3. 在 Agent 会话里拿到目标 `userId`（用户在 relay 侧登录即有），直接调用
   `bridge.dispatchToUser(userId, "fs.read", { path })` —— 桌面客户端连接时已在 hello 中
   声明归属 `userId`（签名覆盖，防篡改），桥接据此路由到该用户当前在线的客户端。
4. 若需更细粒度控制（多设备 / 指定会话），也可用 `dispatchToSession(sessionId, ...)` 或
   `dispatchToClient(clientId, ...)`。

**职责边界**：本服务只做「路由 + 关联 + 鉴权」，不执行业务逻辑、不碰用户文件。真正的受限执行在用户桌面客户端（`zmzai-client` 的 capabilities + 审批 + 审计）。云端 Agent 即使被攻破，也无法绕过客户端的本地审批。

---

## 安全模型

- **握手**：客户端用 `CLIENT_SECRET` 对 `clientId:userId:ts` 做 HMAC；桥接校验签名 + 时间戳（拒绝 `>HELLO_MAX_AGE_MS` 的重放）。`userId` 被签名覆盖，防中间人篡改归属。
- **welcome 签名**：桥接用同一密钥对 `sessionId:ts` 签名（预留升级为云端私钥 + 客户端公钥验签）。
- **密钥存储**：当前从 `CLIENT_SECRETS` env 读取，生产应改为对接 relay 的 apikey / 密钥管理服务（实现 `SecretStore` 接口）。
- **内部 API**：Bearer Token 鉴权；仅限内部网络可达（前置网关 / VPC）。
- **本地审批不可绕过**：见上方安全模型说明。

---

## 生产化待办

- [ ] 多副本横向扩展：用 Redis 存 registry，dispatch 时定向转发到持有该 session 的实例。
- [ ] 非对称握手：云端私钥签 welcome，客户端预置云端公钥验签（防伪造云端端点）。
- [ ] 客户端密钥对接 relay apikey 体系，支持用户自助创建/吊销桥接密钥。
- [x] 客户端声明归属 `userId`（hello 携带、签名覆盖）→ 云端按用户路由（`/v1/users/:userId/tool`）。
- [ ] 与 relay 用户会话打通：relay 在用户登录时把 `userId ↔ agent 会话` 关联，需要本机能力时调用 `dispatchToUser`。
- [ ] dispatch 超时默认拒绝 + Agent 侧可配重试/兜底策略。
- [ ] 审计归集：把客户端审计日志异步上送云端存储，便于跨端复盘。
- [ ] wss 强制 + 证书校验（生产部署必选）。
- [ ] 限流 / 配额（按 clientId 限 dispatch 频率，防滥用）。
