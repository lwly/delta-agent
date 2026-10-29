# F-48 设计：MCP 能力补全（resources / prompts / streamable HTTP）

配套 PRD：`docs/prd-f48-mcp.md`。

## 1. 配置形状（mcp.json）

```json
{ "mcpServers": {
    "local-fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "env": {}, "timeoutMs": 60000 },
    "remote":   { "url": "https://example.com/mcp", "headers": { "Authorization": "enc:v1:…" }, "timeoutMs": 60000 }
} }
```

- `command`（stdio）与 `url`（streamable HTTP）**二选一**；`headers` 仅 url 条目合法。
- 两级文件不变：全局 `~/.delta/mcp.json` + 项目级 `<root>/.delta/mcp.json`（同名项目覆盖全局）。

## 2. 模块落点

| 关注点 | 位置 |
| --- | --- |
| config 扩展（url/headers）、双 transport connect、resources/prompts 方法、header 加解密 | `core/src/mcp/client.ts` |
| 单作用域精确读写（CLI add/remove 用，避免合并视图回写污染） | `readMcpConfigFile` / `saveMcpConfig`（core/mcp/client.ts） |
| Web 写入校验 + header 明文加密收口 | `server/config-store.ts` `validateMcpServers` |
| CLI 子命令 | `cli/src/mcp.ts`（list/add/remove/resources/resource-read/prompts/prompt-show） |
| Web 设置页卡片 | `web/src/components/settings/McpPanel.vue` |

## 3. streamable HTTP transport

- SDK `StreamableHTTPClientTransport`（`@modelcontextprotocol/sdk/client/streamableHttp.js`），连接时把
  `decryptMcpHeaders(headers)` 结果放入 `requestInit.headers`。
- 握手沿用 SDK：initialize → notifications/initialized → 能力列取/调用；无 session 保持逻辑（稳定子集）。
- 连接失败直接抛错（`McpManager.connect` 不重试），会话启动时该服务器缺席即为降级。

## 4. header 加密（AC-48-1）

- 复用 F-04a keychain（`llm/keychain.ts`）的机器派生密钥与 `enc:v1:` 前缀，不另起格式。
- 写入收口：CLI `mcp add` 与 Web PUT 路径统一经 `encryptMcpHeaders`（明文→密文，已加密原样保留）。
- 读取收口：连接前 `decryptMcpHeaders`；无法解密（换机器）抛错并给「重新配置该 header」指引。
- 展示：CLI list 与 Web 面板一律掩码 `********`；Web 保存时未修改的掩码还原为原密文。

## 5. resources / prompts（AC-48-2/3）

- 仅显式通道：`McpManager.listResources/readResource/listPrompts/getPrompt`；无轮询、无定时器、无自动注入。
- CLI：`delta mcp resources <server>` / `resource-read <server> <uri>` / `prompts <server>` /
  `prompt-show <server> <name> [--arg k=v]`，读取即连即断。
- 内容一律 `wrapUntrusted`，source 口径：`mcp:<server>/resource:<uri>`、`mcp:<server>/prompt:<name>`、
  `mcp:<server>/tool/<name>`（描述）。

## 6. F-44 口径（AC-48-4）

`toAgentTool` 的工具描述改为 `[MCP:server] <untrusted_content source="mcp:server/tool/name">…</untrusted_content>`；
工具结果包裹维持既有实现（F-44 已落）。

## 7. 测试（AC-48-6）

- InMemory 配对（真实 SDK server）：resources/prompts 列取与读取、描述 untrusted 标记。
- 本地假 JSON-RPC HTTP 服务：streamable HTTP 握手 → listTools/callTool/readResource/getPrompt 全链 +
  解密后的 header 断言 + 连接失败降级。
- header 加解密往返、外来密文报错、`validateMcpServers` 形状校验（二选一 / headers 限 http / 明文加密）。
