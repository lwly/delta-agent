/**
 * 各 Provider 的默认模型（与 providers/*.ts 内置兜底保持同一事实来源）。
 * 会话未显式指定模型（-m / DELTA_MODEL）时按解析出的 Provider 取默认，
 * 避免把 Claude 模型名发给 DeepSeek 等 OpenAI 兼容端点导致 model_not_found。
 */
export const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-5-20250929',
  openai: 'gpt-4o',
  deepseek: 'deepseek-chat',
  qwen: 'qwen-plus',
};

/**
 * 按已解析 Provider 的 id 取默认模型。
 * 未知 id（openai-compatible 自定义网关）沿用 anthropic 默认，与历史行为一致。
 */
export function defaultModelFor(providerId: string | undefined | null): string {
  return (providerId && PROVIDER_DEFAULT_MODELS[providerId]) || PROVIDER_DEFAULT_MODELS.anthropic!;
}
