# file-chat — OpenClaw HTTP 文件问答插件

给 OpenClaw 加一条**自有的 HTTP 路由**，在保持 OpenAI 文本对话形状的前提下补上文件能力：

- **入站**：请求里带文件（base64 或下载链接），插件把文件落到本地磁盘，并把绝对路径交给模型
- **出站**：模型产出的文件写到出站目录，正文里返回**相对路径**，前端自己拼下载接口
- 不依赖任何第三方存储，也不需要渠道（channel）存储

> 这是**第一阶段：跑通流程**。接口形状、目录约定、返回值都刻意保持简单可预测，方便先验证链路。

---

## 1. 它和内置 `/v1/*` 的区别

| 能力 | 内置 `/v1/chat/completions` | 本插件 |
|---|---|---|
| 提问带文件 | ✗（`image_url` 之外的 content part 被静默丢弃） | ✓ base64 / 下载链接 / multipart |
| 回答带文件 | ✗ | ✓ 出站目录 + 正文相对路径 |
| 文件类型 | 仅图片 | 任意类型（非图片不入模型上下文，落盘后由模型用文件工具读取） |
| 流式 | ✓ | ✓ SSE（含 `reasoning_content`） |

---

## 2. 目录约定

默认根目录：`~/.openclaw/file-chat/files`（即容器里通常是 `/home/node/.openclaw/file-chat/files`）

```
<filesRoot>/
├── inbound/
│   └── <session>/
│       └── contract.pdf          # 入站：按会话隔离
└── outbound/
    └── <session>/
        └── report.md             # 出站：模型产出的文件
```

- `<session>` 由 `sessionKey` 派生（`sessionScopedDirs: false` 可关掉这一层，变成 `inbound/` 和 `outbound/` 两个平铺目录）
- 返回给客户端的 `path` 是**相对 `filesRoot`** 的 POSIX 路径，例如 `outbound/file-chat-user-alice/report.md`
- `publicPathPrefix` 可给这些相对路径加统一前缀，方便对齐你已有的下载接口

---

## 3. 安装

```bash
# 1) 构建（本机）
cd openclaw-file-chat
npm install
npm run build

# 2) 拷到 claw 机器
#    推荐放到 ~/.openclaw/extensions/file-chat
scp -r openclaw-file-chat node@<claw-host>:~/.openclaw/extensions/file-chat
```

然后在 `openclaw.json` 里启用（`config` 块会原样成为插件的 `pluginConfig`）：

```json
{
  "plugins": {
    "entries": {
      "file-chat": {
        "enabled": true,
        "config": {
          "path": "/api/v1/file-chat",
          "filesRoot": "/home/node/.openclaw/file-chat/files",
          "publicPathPrefix": ""
        }
      }
    }
  }
}
```

改完重启网关。启动日志里应该出现：

```
[file-chat] route /api/v1/file-chat registered (filesRoot=..., auth=gateway)
```

**加载不出来时按顺序检查**（这几条都是 OpenClaw 的真实门槛）：

1. `plugins.entries["file-chat"].enabled` 是否为 `true`
2. 有没有 `plugins.allow` 白名单把插件挡在外面
3. 插件目录里 `dist/index.js` 是否存在（`openclaw.plugin.json` + `package.json.openclaw.runtimeExtensions` 都指向它）
4. 不要往插件目录里放 `node_modules/openclaw`——那会遮蔽宿主真实的 `openclaw` 包

---

## 4. 请求

`POST <path>`，**认证完全交给网关**：路由以 `auth: "gateway"` 注册，网关的 HTTP 鉴权中间件
（`Authorization: Bearer <gateway-token>`）会先于本插件执行，未通过鉴权的请求根本到不了 handler。
插件自身**没有 API Key**——一把实例级网关凭据覆盖全部路由，不引入第二份需要轮换的密钥，
这也正是 `openclaw-controller` 调用插件的方式。

> ⚠️ 网关鉴权的强度取决于实例配置：`gateway.auth.mode` 为 `token` / `password` 时有效；
> 若显式配成 `none`，该路由就是完全开放的。生产实例请勿使用 `none`。

### 4.1 JSON（OpenAI 风格）

```jsonc
{
  "message": "帮我总结这份合同，并输出一份要点表格",
  "user": "alice",              // 可选：同一 user 稳定落在同一会话
  "sessionKey": "xxx",          // 可选：显式指定会话（优先级高于 user）
  "agentId": "default",         // 可选
  "provider": "custom-local",   // 可选：per-run 覆盖
  "model": "kimi-k2.6",         // 可选
  "thinking": "high",           // 可选
  "stream": true,               // 可选，默认 true
  "files": [
    { "name": "contract.pdf", "mimeType": "application/pdf", "content": "<base64 或 data:application/pdf;base64,xxx>" },
    { "name": "plan.xlsx", "url": "https://example.com/plan.xlsx" }
  ],
  "urls": ["https://example.com/another.pdf"]   // 只要链接、不要元数据时的简写
}
```

### 4.2 multipart（浏览器表单）

```
POST /api/v1/file-chat
Authorization: Bearer <gateway-token>
Content-Type: multipart/form-data

message = 帮我总结这份合同
user    = alice
stream  = true
files   = <文件1>
files   = <文件2>
urls    = https://example.com/a.pdf   # 可选，JSON 数组或换行分隔
```

### 4.3 会话规则

| 请求里带什么 | 得到的 sessionKey |
|---|---|
| `sessionKey` | 原样使用 |
| header `x-openclaw-session-key` | 原样使用 |
| `user` | `file-chat-user-<user>`（同一 user 稳定同会话） |
| 都没有 | `file-chat-<uuid>`（每次请求新会话） |

预留命名空间 `subagent:` / `cron:` / `acp:` 会被拒绝（400）。

---

## 5. 响应

保持 OpenAI 形状，**额外字段都是新增的顶层字段**，用 OpenAI SDK 的客户端读 `choices[0]` 不会受影响。

### 非流式

```jsonc
{
  "id": "chatcmpl_...",
  "object": "chat.completion",
  "created": 1786000000,
  "model": "openclaw/file-chat",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "……正文，内含 outbound/<session>/report.md\n\n[file-chat outbound files]\n- outbound/<session>/report.md",
      "reasoning_content": "……"
    },
    "finish_reason": "stop"
  }],
  "sessionKey": "file-chat-user-alice",
  "sessionGenerated": false,
  "files": {
    "inbound": [
      { "name": "contract.pdf", "path": "inbound/<session>/contract.pdf",
        "absolutePath": "/home/node/.openclaw/file-chat/files/inbound/<session>/contract.pdf",
        "size": 12345, "mimeType": "application/pdf", "source": "base64" }
    ],
    "outbound": [
      { "name": "report.md", "path": "outbound/<session>/report.md",
        "absolutePath": "/home/node/.openclaw/file-chat/files/outbound/<session>/report.md",
        "size": 2048, "modifiedAt": "2026-10-09T09:00:00.000Z" }
    ]
  }
}
```

### 流式（SSE）

标准 `chat.completion.chunk` 序列，最后一块带 `files`，然后 `data: [DONE]`：

```
data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}], ...}
data: {"choices":[{"index":0,"delta":{"reasoning_content":"…"},"finish_reason":null}], ...}
data: {"choices":[{"index":0,"delta":{"content":"…"},"finish_reason":null}], ...}
data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"files":{...},"sessionKey":"…"}
data: [DONE]
```

出站文件清单也会以文本形式追加在正文末尾（`appendOutboundFooter`，默认开）：

```
[file-chat outbound files]
- outbound/<session>/report.md
```

前端可以直接按 `outbound/` 前缀正则匹配正文里的路径。

---

## 6. 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `path` | `/api/v1/file-chat` | 路由路径 |
| `filesRoot` | `~/.openclaw/file-chat/files` | 入站/出站根目录 |
| `inboundDirName` / `outboundDirName` | `inbound` / `outbound` | 子目录名 |
| `sessionScopedDirs` | `true` | 是否按会话再分一层 |
| `publicPathPrefix` | `""` | 返回路径的统一前缀 |
| `maxFileBytes` | `20971520`（20 MiB） | 单文件上限 |
| `maxFilesPerRequest` | `10` | 单请求文件数上限 |
| `allowUrlFetch` | `true` | 是否允许下载链接入站 |
| `appendOutboundFooter` | `true` | 是否在正文追加出站文件清单 |
| `defaultProvider` / `defaultModel` | 无 | 请求未指定时的默认覆盖 |
| `defaultThinking` | 无 | 请求未指定时的 thinking 档位 |
| `outboundInstruction` | 内置 | 覆盖告诉模型「写到哪」的系统提示片段 |

---

## 7. 测试

```bash
curl -s http://<claw-host>:<port>/api/v1/file-chat \
  -H 'Authorization: Bearer <gateway-token>' -H 'Content-Type: application/json' \
  -d '{
    "message": "读取附件，然后把要点写成 report.md 放到出站目录，并在正文里给出相对路径",
    "user": "smoke",
    "stream": false,
    "files": [{"name":"a.txt","mimeType":"text/plain","content":"'$(printf 'hello file-chat' | base64)'"}]
  }' | head -c 2000
```

本地回归（不需要 OpenClaw，用打桩宿主跑通全链路）：

```bash
npm run smoke     # 55 项断言：JSON/multipart/流式/路径穿越/网关鉴权/URL 入站/出站 diff
```

`.smoke/run.mjs` 与 `.smoke/node_modules/openclaw/**` 是**手写的测试桩**（不是依赖），
会随仓库一起提交，这样 `git clone` 后直接就能跑回归。
只有 `.smoke/dist/`（构建产物副本）和 `.smoke/workspace/`（fixture 目录）被忽略——它们每次运行都会重建。
测试桩位于子目录中，Node 解析依赖只向上查祖先目录，所以不会影响宿主对 `openclaw` 包的解析；
`package.json` 的 `files` 不含 `.smoke`，也不会进 npm 打包产物。

---

## 8. 首次上机要重点确认的三件事

源码层面已逐条核对（OpenClaw v2026.9.4），但**没有在你的实例上实跑过**：

1. **出站目录是否真的被模型写入**——指令走 `extraSystemPrompt`（已确认会并入系统提示词）。若模型不听话，可改用 `publish_file` 工具方案。
2. **模型是否在正文里给出相对路径**——即便它没给，`files.outbound` 与正文脚注仍会兜底，链路不会断。
3. **`agentCommandFromIngress` 在插件里的运行权限**——你现有的 `custom-chat` 用的是同一个入口，已证明可用。

---

## 9. 已知边界

- **不做并发/限流/TTL 清理**：出站目录会持续增长，需要你自己定期清理
- **没有 per-user 身份**：插件不携带任何凭据，鉴权是实例级的（网关 token）；多租户要靠前端自己隔离 `user`
- **没有请求级超时**：agent 跑多久，SSE 连接就开多久（与 `custom-chat` 一致）
- **单请求体上限 64 MiB**：base64 会带来约 33% 膨胀，超大文件请走下载链接
- **`url` 入站依赖宿主 SSRF 守卫**：默认策略会拦截内网/回环目标，若你的文件服务在内网需要单独放通
- **出站点检测基于目录快照 diff**：同一会话内**内容未变**的旧文件不会重复上报；同名文件被覆盖会重新上报

---

## 10. 源码依据（v2026.9.4）

| 结论 | 位置 |
|---|---|
| 插件可注册 HTTP 路由 | `api.registerHttpRoute` — `src/plugins/plugin-api.types.ts:222` |
| `auth: "gateway"` 会让网关先做鉴权 | `src/gateway/server/plugins-http/route-auth.ts:13-17`（`matchedPluginRoutesRequireGatewayAuth`） |
| `/api/...` 不在强制保护名单，`auth:"plugin"` 时网关确实不拦 | `PROTECTED_PLUGIN_ROUTE_PREFIXES` — `src/gateway/security-path.ts:113`（仅 `/api/channels`） |
| 无 token 时网关拒绝启动（所以 gateway 档不等于裸奔） | `src/gateway/auth.ts:167-174` |
| 入站选项面 = `AgentCommandOpts` 减私有字段 | `src/agents/command/types.ts:244-265` |
| `extraSystemPrompt` 并入系统提示词 | `src/agents/embedded-agent-runner/run/attempt-system-prompt-prepare.ts:212` |
| 宿主只把图片作为内联附件 | `AgentCommandOpts.images` — `src/agents/command/types.ts:66` |
| 原生附件文本注入格式 | `\n[media attached: <ref>]` — `src/gateway/chat-attachments.ts:471` |
| 正文里的本地路径**不会**被清洗 | 仅清洗结构化媒体字段与已登记 `MEDIA:` 引用 — `chat-display-projection.sanitize.ts` / `.helpers.ts` |
| 宿主自带 SSRF 守卫 | `fetchWithSsrFGuard` — `src/plugin-sdk/ssrf-runtime.ts:19` |

---

## 11. 提交到 GitHub：什么该提交，什么不该

忽略清单在 `.gitignore`，里面每条都写了原因。这里只讲**最容易搞错的一条**。

### `dist/` 必须提交（不要 ignore）

OpenClaw 的 git 安装在目标机器上只跑这一条命令（`docs/plugins/dependency-resolution.md:170-176`）：

```bash
npm install --omit=dev --ignore-scripts --no-audit --no-fund
#                           ^^^^^^^^^^^^^^^
```

`--ignore-scripts` 意味着 **build 永远不会在目标机器上执行**，而宿主要加载的入口是
`openclaw.runtimeExtensions` → `./dist/index.js`。所以 **`dist/` 缺失或过期 = 插件直接加载失败**。

> 改完任何 `.ts` 文件后，请 `npm run build`，并把 `dist/` 的改动**和源码放在同一个 commit 里**。

同理 `package-lock.json` 要提交（锁定 typescript / @types/node），而 `dependencies` 是空的
——运行时零依赖，正是因为 `--omit=dev` 不会装 devDependencies。

### 清单速查

| 提交 | 忽略 |
|---|---|
| `index.ts`、`src/**`、`types/**` | `/node_modules/`（根目录依赖） |
| `dist/**` ← 构建产物，必须提交 | `.smoke/dist/`（产物副本，每次重建） |
| `.smoke/run.mjs`、`.smoke/node_modules/openclaw/**` ← 测试桩 | `.smoke/workspace/`（测试 fixture） |
| `package.json`、`package-lock.json`、`tsconfig.json` | `*.tgz`（npm pack 产物） |
| `openclaw.plugin.json`、`README.md`、`.gitignore`、`.gitattributes` | `.env*`、日志、`.vscode/*`、`.idea/`、`*.tsbuildinfo` |

> ⚠️ `.gitignore` 里 `/node_modules/` 的开头斜杠是**故意的**。写成裸 `node_modules/` 会连
> `.smoke/node_modules/` 一起忽略，测试桩就没了，`npm run smoke` 在新克隆的仓库里直接跑不起来。

### 行尾：由 `.gitattributes` 固定为 LF

仓库里**全部文件都是 LF**（已实测，CR 字节数 = 0），`.gitattributes` 用
`* text=auto eol=lf` 把这件事固定下来，而不是依赖每台机器的 `core.autocrlf`。

需要它的原因：本机 `core.autocrlf` 是 **system 级**的 `true`，这会让 `git add` 对**每个** LF 文件
都打印 `LF will be replaced by CRLF the next time Git touches it`——而这台机器上 checkout
确实会把工作区悄悄改成 CRLF，跟仓库里的 LF 分叉。`eol=lf` 会覆盖 `autocrlf`，警告随之消失
（实测：加配置前 32 条，加配置后 0 条），且**不会改写已经干净的文件**，所以没有一次性的行尾改动。

目标运行时是 Linux 容器，强制 LF 也让"本地编辑的内容"和"容器实际加载的内容"逐字节一致。
`eol=lf` 只作用于文本；二进制类型（图片/压缩包/字体/wasm）单独列为 `binary`，避免被"规范化"损坏。

