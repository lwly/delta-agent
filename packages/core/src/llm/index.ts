/** `@delta/core/llm` 公开入口。主桶 `@delta/core` 仍再导出这些符号。 */
export { parseSse, parseDataFrames } from './sse.js';
export { ToolCallAccumulator, parseLenientJson } from './accumulator.js';
export { AnthropicProvider } from './providers/anthropic.js';
export { OpenAICompatibleProvider } from './providers/openai-compatible.js';
export { OpenAIProvider } from './providers/openai.js';
export { DeepSeekProvider } from './providers/deepseek.js';
export { QwenProvider } from './providers/qwen.js';
export { ProviderManager, type ProviderView } from './manager.js';
export { ScriptedFakeProvider, type FakeProviderMode } from './fake-provider.js';
export { UnavailableProvider } from './placeholders.js';
export { PROVIDER_DEFAULT_MODELS, defaultModelFor } from './defaults.js';
export {
  ModelRouter,
  KNOWN_TASK_KINDS,
  type RoutingTaskKind,
  type RoutedTarget,
} from './router.js';
export {
  encryptKey,
  decryptKey,
  decryptKeyDetailed,
  maskKey,
  loadModelsFile,
  saveModelsFile,
  modelsConfigPath,
  type StoredProvider,
  type ModelsFile,
  type RoutingRule,
  type RoutingConfig,
} from './keychain.js';
export {
  EmbeddingClient,
  resolveEmbedding,
  VENDOR_EMBEDDING,
  type EmbeddingOptions,
} from './embeddings.js';
