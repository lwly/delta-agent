import { OpenAICompatibleProvider } from './openai-compatible.js';

/** OpenAI official endpoint. */
export class OpenAIProvider extends OpenAICompatibleProvider {
  constructor(opts: { apiKey: string; baseUrl?: string; model?: string }) {
    super({
      id: 'openai',
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? 'https://api.openai.com/v1',
      model: opts.model ?? 'gpt-4o',
    });
  }
}
