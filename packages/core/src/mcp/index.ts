/** `@delta/core/mcp` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
export {
  McpManager,
  loadMcpConfig,
  readMcpConfigFile,
  saveMcpConfig,
  decryptMcpHeaders,
  encryptMcpHeaders,
  maskMcpHeaderValue,
  type McpServerConfig,
} from './client.js';
