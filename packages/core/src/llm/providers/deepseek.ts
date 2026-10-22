import { OpenAICompatibleProvider } from './openai-compatible.js';

/**
 * DeepSeek (OpenAI-compatible endpoint).
 * deepseek-reasoner streams chain-of-thought in `reasoning_content`.
 */
export class DeepSeekProvider extends OpenAICompatibleProvider {
  constructor(opts: { apiKey: string; baseUrl?: string; model?: string }) {
    const model = opts.model ?? 'deepseek-chat';
    super({
      id: 'deepseek',
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? 'https://api.deepseek.com/v1',
      model,
      thinkingField: model.startsWith('deepseek-reasoner') ? 'reasoning_content' : '',
    });
  }
}
