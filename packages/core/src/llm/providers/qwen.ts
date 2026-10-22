import { OpenAICompatibleProvider } from './openai-compatible.js';

/**
 * Qwen via DashScope OpenAI-compatible mode.
 * qwen3 open-thinking series streams CoT in `reasoning_content`.
 */
export class QwenProvider extends OpenAICompatibleProvider {
  constructor(opts: { apiKey: string; baseUrl?: string; model?: string }) {
    const model = opts.model ?? 'qwen-plus';
    super({
      id: 'qwen',
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model,
      thinkingField: /^qwen3|.*-thinking/.test(model) ? 'reasoning_content' : '',
    });
  }
}
