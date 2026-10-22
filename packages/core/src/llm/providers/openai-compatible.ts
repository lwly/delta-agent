import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  MessageImage,
  StreamEvent,
  ToolDefinition,
  Usage,
} from '@y-zero/shared';
import { parseSse, openSseStream, isRetriableOpenError } from '../sse.js';
import { imageDimensions, estimateImageTokens } from '../../media/images.js';

/** rough client-side estimate: CJK 1 tok/char, latin 3 chars/tok (shared rule) */
export function estimateTokensOf(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += 4 + countTokensOf(m.content);
    for (const c of m.toolCalls ?? []) total += countTokensOf(c.argsJson) + 8;
    for (const img of m.images ?? []) total += imageTokenCost(img);
  }
  return total;
}

/** F-25：图片 token 计价（封顶面积/750；无尺寸按字节退化）。 */
export function imageTokenCost(img: MessageImage): number {
  return estimateImageTokens(img, imageDimensions(Buffer.from(img.base64, 'base64'), img.mediaType));
}

function countTokensOf(text: string): number {
  const cjk = (text.match(/[\u3200-\u9FFF\uF900-\uFAFF]/g) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 3);
}

export interface OpenAICompatibleOptions {
  /** provider id, e.g. 'openai' | 'deepseek' | 'qwen' */
  id: string;
  apiKey: string;
  /** default https://api.openai.com/v1 — must include the version path */
  baseUrl?: string;
  model?: string;
  /**
   * Field name carrying chain-of-thought deltas. deepseek-reasoner and
   * qwen3 thinking models use `reasoning_content`; empty disables it.
   */
  thinkingField?: 'reasoning_content' | '';
  /** extra headers (e.g. Qwen's X-DashScope-* options) */
  headers?: Record<string, string>;
}

/**
 * OpenAI Chat Completions SSE provider — one implementation covers
 * OpenAI / DeepSeek / Qwen (all OpenAI-compatible endpoints, decision #8).
 * Normalizes vendor SSE into the unified StreamEvent model.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  protected apiKey: string;
  protected baseUrl: string;
  protected defaultModel: string;
  protected thinkingField: string;
  protected extraHeaders: Record<string, string>;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id;
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.defaultModel = opts.model ?? 'gpt-4o';
    this.thinkingField = opts.thinkingField ?? '';
    this.extraHeaders = opts.headers ?? {};
  }

  estimateTokens(messages: ChatMessage[]): number {
    return estimateTokensOf(messages);
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const body: Record<string, unknown> = {
      model: req.model || this.defaultModel,
      stream: true,
      messages: convertMessages(req.messages),
      // ask the vendor to append a final usage-only chunk
      stream_options: { include_usage: true },
    };
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools.length > 0) body.tools = convertTools(req.tools);

    const init: RequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    };

    // 断流重连 (F-04): connection failures retry silently inside openSseStream;
    // a stream that breaks before producing any event gets one silent re-dial.
    for (let attempt = 0; attempt <= 1; attempt++) {
      let started = false;
      try {
        const res = await openSseStream(`${this.baseUrl}/chat/completions`, init, attempt === 0 ? 1 : 0);
        const usage: Usage = { inputTokens: 0, outputTokens: 0 };
        for await (const frame of parseSse(res.body!)) {
          const data = frame.data;
          if (!data || data === '[DONE]') break;
          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue; // tolerate keep-alive / partial frames; retries handled upstream
          }

          const u = chunk.usage as
            | { prompt_tokens?: number; completion_tokens?: number }
            | undefined;
          if (u) {
            if (u.prompt_tokens) usage.inputTokens = u.prompt_tokens;
            if (u.completion_tokens) usage.outputTokens = u.completion_tokens;
          }

          const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
          const choice = choices?.[0];
          if (!choice) continue; // usage-only final chunk

          const delta = choice.delta as
            | {
                content?: string | null;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              }
            | undefined;

          if (delta?.content) {
            started = true;
            yield { type: 'text_delta', text: delta.content };
          }

          if (this.thinkingField && delta) {
            const thinking = (delta as Record<string, unknown>)[this.thinkingField];
            if (typeof thinking === 'string' && thinking) {
              started = true;
              yield { type: 'thinking_delta', text: thinking };
            }
          }

          for (const tc of delta?.tool_calls ?? []) {
            started = true;
            yield {
              type: 'tool_call_delta',
              index: tc.index ?? 0,
              id: tc.id,
              name: tc.function?.name,
              argsDelta: tc.function?.arguments ?? '',
            };
          }
          // NOTE: do NOT break on finish_reason — the usage-only chunk arrives after it
        }

        if (usage.inputTokens || usage.outputTokens) {
          yield { type: 'usage', input: usage.inputTokens, output: usage.outputTokens };
        }
        yield { type: 'done' };
        return;
      } catch (e) {
        const aborted = req.signal?.aborted ?? false;
        const canRetry = !aborted && isRetriableOpenError(e);
        if (started || attempt >= 1 || !canRetry) {
          yield {
            type: 'error',
            message: `${this.id} stream failed: ${(e as Error).message}`,
            retriable: !aborted && isRetriableOpenError(e),
          };
          return;
        }
        // silent reconnect: nothing emitted yet, one extra dial
      }
    }
  }
}

/** Map unified messages to OpenAI chat format. */
export function convertMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'system') {
      out.push({ role: 'system', content: m.content });
    } else     if (m.role === 'user') {
      // F-25：带图片附件的 user 消息 → content part 数组（text + image_url data URL）
      if (m.images?.length) {
        const parts: unknown[] = [];
        if (m.content) parts.push({ type: 'text', text: m.content });
        for (const img of m.images) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
          });
        }
        out.push({ role: 'user', content: parts });
      } else {
        out.push({ role: 'user', content: m.content });
      }
    } else if (m.role === 'assistant') {
      const msg: Record<string, unknown> = { role: 'assistant', content: m.content || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.argsJson },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content });
    }
  }
  return out;
}

function convertTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
