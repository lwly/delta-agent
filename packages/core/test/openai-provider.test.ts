import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../src/llm/providers/openai-compatible.js';
import { DeepSeekProvider } from '../src/llm/providers/deepseek.js';
import { convertMessages } from '../src/llm/providers/openai-compatible.js';
import type { ChatMessage } from '@delta/shared';

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(encoder.encode(f));
      c.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

async function collect(provider: OpenAICompatibleProvider, res: Response) {
  vi.stubGlobal('fetch', vi.fn(async () => res));
  const events: unknown[] = [];
  for await (const ev of provider.chat({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    model: '',
  })) {
    events.push(ev);
  }
  vi.unstubAllGlobals();
  return events;
}

describe('OpenAICompatibleProvider', () => {
  it('normalizes text / reasoning / tool_call deltas / usage / done', async () => {
    const provider = new OpenAICompatibleProvider({
      id: 'openai',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    });
    const events = await collect(
      provider,
      sseResponse([
        chunk({
          choices: [{ index: 0, delta: { role: 'assistant', content: '你好' } }],
        }),
        chunk({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } },
                  { index: 1, id: 'call_2', function: { name: 'list_dir', arguments: '{}' } },
                ],
              },
            },
          ],
        }),
        chunk({
          choices: [
            { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th": "a.ts"}' } }] }, finish_reason: null,
          },
        ],
        }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        chunk({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 42 } }),
        'data: [DONE]\n\n',
      ]),
    );

    const types = events.map((e) => (e as { type: string }).type);
    expect(types).toContain('text_delta');
    expect(types).toContain('usage');
    expect(types[types.length - 1]).toBe('done');

    const toolDeltas = events.filter((e) => (e as { type: string }).type === 'tool_call_delta');
    expect(toolDeltas).toHaveLength(3);
    expect(toolDeltas[0]).toMatchObject({ index: 0, id: 'call_1', name: 'read_file', argsDelta: '{"pa' });
    expect(toolDeltas[1]).toMatchObject({ index: 1, id: 'call_2', name: 'list_dir', argsDelta: '{}' });
    expect(toolDeltas[2]).toMatchObject({ index: 0, argsDelta: 'th": "a.ts"}' });
    const usage = events.find((e) => (e as { type: string }).type === 'usage');
    expect(usage).toMatchObject({ input: 100, output: 42 });
  });

  it('maps reasoning_content to thinking_delta for deepseek-reasoner', async () => {
    const provider = new DeepSeekProvider({ apiKey: 'k', model: 'deepseek-reasoner' });
    const events = await collect(
      provider,
      sseResponse([
        chunk({ choices: [{ delta: { reasoning_content: '先想一想' } }] }),
        chunk({ choices: [{ delta: { content: '答案' } }] }),
        'data: [DONE]\n\n',
      ]),
    );
    expect(events).toContainEqual({ type: 'thinking_delta', text: '先想一想' });
    expect(events).toContainEqual({ type: 'text_delta', text: '答案' });
  });

  it('plain deepseek-chat does not emit thinking deltas', async () => {
    const provider = new DeepSeekProvider({ apiKey: 'k' });
    expect(provider.id).toBe('deepseek');
    const events = await collect(
      provider,
      sseResponse([chunk({ choices: [{ delta: { reasoning_content: 'nope' } }] }), 'data: [DONE]\n\n']),
    );
    expect(events.some((e) => (e as { type: string }).type === 'thinking_delta')).toBe(false);
  });

  it('converts http errors into retriable stream errors', async () => {
    const provider = new OpenAICompatibleProvider({ id: 'qwen-test', apiKey: 'k' });
    const events = await collect(provider, new Response('rate limited', { status: 429 }));
    expect(events[0]).toMatchObject({ type: 'error', retriable: true });
  });

  it('converts unified messages to OpenAI chat format', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{"path":"a"}' }],
      },
      { role: 'tool', content: 'file body', toolCallId: 'c1' },
    ];
    const out = convertMessages(messages) as Array<Record<string, unknown>>;
    expect(out[0]).toEqual({ role: 'system', content: 'sys' });
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
    expect(out[2]!.tool_calls).toEqual([
      { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a"}' } },
    ]);
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'file body' });
  });
});
