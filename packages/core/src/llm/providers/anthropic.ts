import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  StreamEvent,
  ToolDefinition,
} from '@y-zero/shared';
import { parseSse, parseDataFrames } from '../sse.js';

/** rough client-side estimate: CJK 1 tok/char, latin 3 chars/tok */
function estimateTokens(messages: ChatMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += 4 + countTokensOf(m.content);
    for (const c of m.toolCalls ?? []) total += countTokensOf(c.argsJson) + 8;
  }
  return total;
}

function countTokensOf(text: string): number {
  const cjk = (text.match(/[\u3200-\u9FFF\uF900-\uFAFF]/g) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 3);
}

interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string; // default https://api.anthropic.com
  model?: string;
  version?: string;
}

/**
 * Anthropic Messages API provider (M1 single provider).
 * Normalizes Anthropic SSE into the unified StreamEvent model.
 */
export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private version: string;

  constructor(opts: AnthropicOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
    this.defaultModel = opts.model ?? 'claude-sonnet-4-5-20250929';
    this.version = opts.version ?? '2023-06-01';
  }

  estimateTokens(messages: ChatMessage[]): number {
    return estimateTokens(messages);
  }

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const converted = convertMessages(req.messages.filter((m) => m.role !== 'system'));

    const body: Record<string, unknown> = {
      model: req.model || this.defaultModel,
      max_tokens: req.maxTokens ?? 8192,
      stream: true,
      messages: converted,
    };
    if (system) body.system = system;
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.tools.length > 0) body.tools = convertTools(req.tools);

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.version,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      yield {
        type: 'error',
        message: `anthropic http ${res.status}: ${text.slice(0, 300)}`,
        retriable: res.status === 429 || res.status >= 500,
      };
      return;
    }

    // block index -> tool_use id/name (from content_block_start)
    const blocks = new Map<number, { id: string; name: string }>();

    for await (const frame of parseSse(res.body)) {
      for (const ev of parseDataFrames(frame.data)) {
        const raw = ev as unknown as Record<string, unknown>;
        const type = raw.type as string;
        switch (type) {
          case 'message_start': {
            const msg = raw.message as { usage?: { input_tokens?: number } } | undefined;
            const input = msg?.usage?.input_tokens ?? 0;
            if (input > 0) yield { type: 'usage', input, output: 0 };
            break;
          }
          case 'content_block_start': {
            const idx = raw.index as number;
            const block = raw.content_block as { type: string; id?: string; name?: string };
            if (block.type === 'tool_use') {
              blocks.set(idx, { id: block.id ?? '', name: block.name ?? '' });
              yield { type: 'tool_call_delta', index: idx, id: block.id, name: block.name, argsDelta: '' };
            }
            break;
          }
          case 'content_block_delta': {
            const idx = raw.index as number;
            const delta = raw.delta as {
              type: string;
              text?: string;
              thinking?: string;
              partial_json?: string;
            };
            if (delta.type === 'text_delta' && delta.text) {
              yield { type: 'text_delta', text: delta.text };
            } else if (delta.type === 'thinking_delta' && delta.thinking) {
              yield { type: 'thinking_delta', text: delta.thinking };
            } else if (delta.type === 'input_json_delta') {
              yield { type: 'tool_call_delta', index: idx, argsDelta: delta.partial_json ?? '' };
            }
            break;
          }
          case 'message_delta': {
            const usage = raw.usage as { output_tokens?: number } | undefined;
            if (usage?.output_tokens) yield { type: 'usage', input: 0, output: usage.output_tokens };
            break;
          }
          case 'message_stop':
            yield { type: 'done' };
            return;
          case 'error': {
            const err = raw.error as { message?: string } | undefined;
            yield { type: 'error', message: err?.message ?? 'anthropic stream error', retriable: true };
            return;
          }
          default:
            break;
        }
      }
    }
    yield { type: 'done' };
  }
}

function convertTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

/** Map unified messages to Anthropic content blocks. */
function convertMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content });
    } else if (m.role === 'assistant') {
      const content: unknown[] = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: c.id, name: c.name, input: safeParse(c.argsJson) });
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
    } else if (m.role === 'tool') {
      // tool result rides in a user message as tool_result block
      const last = out[out.length - 1] as { role: string; content: unknown[] } | undefined;
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId ?? '',
        content: m.content,
      };
      if (last && last.role === 'user' && Array.isArray(last.content) && (last.content[0] as { type?: string })?.type === 'tool_result') {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    }
  }
  return out;
}

function safeParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
