# F-48 PRD：MCP 能力补全（resources / prompts / streamable HTTP）

> 编号口径说明：仓库早期 `prd-f41-f53-next-round.md` 的 F-48 为「代码符号索引」，与交付线编号冲突。
> 本文件是交付线（issue PASI-16）口径下的 F-48 成对 PRD；符号索引功能此后另起编号。

## 背景

MCP 客户端当前仅支持 stdio transport 与 tools 一个能力面（`packages/core/src/mcp/client.ts`，M2 范围）。
远程 MCP 服务（streamable HTTP）与 resources / prompts 能力缺失，限制了可接入的服务器范围。

## 需求

1. **streamable HTTP transport**：接入 spec 稳定子集（JSON-RPC over HTTP，单响应模式），支持 header 鉴权。
2. **header 加密存储**：header 值写入（CLI / Web）即加密为 `enc:v1:` 密文（keychain 机器派生密钥），
   展示一律掩码，明文不落盘不回显。
3. **resources**：列表 + 显式读取（等价 @ 引用语义），不自动轮询、不自动注入。
4. **prompts**：列表 + 取模板装配为消息文本，供用户显式选用。
5. **F-44 口径统一**：MCP 工具描述、工具结果、resource 正文、prompt 装配文本全部经
   `wrapUntrusted` 包裹入上下文（与 F-44 D2 收口点约定一致）。
6. **配置入口同步**：`delta mcp` 子命令与 Web 设置页 MCP 卡片均支持两种 transport。

## 非目标

- 不做 OAuth 流程（header 静态鉴权已覆盖稳定子集场景）。
- 不做 resources 订阅 / 轮询 / 自动注入。
- 不做 SSE 旧 transport（streamable HTTP 为现行标准）。

## 验收标准（对应 issue AC）

- AC-48-1 streamable HTTP 接入；header 值 `enc:v1:` 加密存储不回显
- AC-48-2 resources 列表+读取，显式注入，不自动轮询
- AC-48-3 prompts 列表+选择后装配为消息模板
- AC-48-4 MCP 工具描述/结果按 F-44 untrusted 口径入上下文
- AC-48-5 `delta mcp add --transport http --header K=V`；Web 设置页 MCP 卡片同步
- AC-48-6 单测覆盖 transport 握手/列取/调用与异常降级
