import { describe, expect, it } from 'vitest';
import { PROVIDER_DEFAULT_MODELS, defaultModelFor } from '../src/llm/defaults.js';
import { DeepSeekProvider } from '../src/llm/providers/deepseek.js';

/** 默认模型跟随 Provider：避免 Claude 模型名被发给 OpenAI 兼容端点（model_not_found）。 */
describe('defaultModelFor', () => {
  it('已知 provider 返回各自默认模型（与 providers/*.ts 内置兜底一致）', () => {
    expect(defaultModelFor('anthropic')).toBe('claude-sonnet-4-5-20250929');
    expect(defaultModelFor('deepseek')).toBe('deepseek-chat');
    expect(defaultModelFor('qwen')).toBe('qwen-plus');
    expect(defaultModelFor('openai')).toBe('gpt-4o');
  });

  it('未知 provider id（openai-compatible 自定义网关）回退 anthropic 默认', () => {
    expect(defaultModelFor('my-gateway')).toBe('claude-sonnet-4-5-20250929');
  });

  it('空值安全', () => {
    expect(defaultModelFor(undefined)).toBe(PROVIDER_DEFAULT_MODELS.anthropic!);
    expect(defaultModelFor(null)).toBe(PROVIDER_DEFAULT_MODELS.anthropic!);
    expect(defaultModelFor('')).toBe(PROVIDER_DEFAULT_MODELS.anthropic!);
  });

  it('DeepSeekProvider 未显式指定模型时使用 deepseek-chat（而非 claude 默认）', () => {
    // 通过 protected defaultModel 验证：与 PROVIDER_DEFAULT_MODELS 深度一致
    const p = new DeepSeekProvider({ apiKey: 'sk-test' });
    expect((p as unknown as { defaultModel: string }).defaultModel).toBe(
      PROVIDER_DEFAULT_MODELS.deepseek,
    );
  });
});
