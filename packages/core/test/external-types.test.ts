import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatRequest } from '@delta/shared';
import { UnavailableProvider } from '../src/llm/placeholders.js';
import type {
  ExternalAgentAdapter,
  ExternalAgentSpec,
  ExternalEvent,
  ExternalTier,
} from '../src/external/types.js';

/** F-55：external 类型契约 + UnavailableProvider 占位（docs/design-f55-external-cli-agents.md §3） */
describe('UnavailableProvider', () => {
  it('id 等于构造时注入的虚拟 id', () => {
    const p = new UnavailableProvider('cli:claude-code');
    expect(p.id).toBe('cli:claude-code');
  });

  it('chat() 返回的 AsyncIterable 在迭代时 reject，错误信息含 external_agent_no_llm', async () => {
    const p = new UnavailableProvider('cli:codex');
    const req: ChatRequest = { messages: [], tools: [], model: 'cli:codex' };
    const iter = p.chat(req)[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/external_agent_no_llm/);
  });

  it('estimateTokens() 恒返回 0（任意 ChatMessage[] 入参）', () => {
    const p = new UnavailableProvider('acp:acp-connector');
    const messages: ChatMessage[] = [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '世界' },
    ];
    expect(p.estimateTokens(messages)).toBe(0);
    expect(p.estimateTokens([])).toBe(0);
  });
});

describe('ExternalEvent 类型窄化', () => {
  // compile-only + 运行时构造样例：各变体构造合法即可
  it('各变体均可构造并赋值给 ExternalEvent', () => {
    const events: ExternalEvent[] = [
      { type: 'text', text: '你好' },
      { type: 'thinking', text: '思考中' },
      { type: 'tool_use', id: 'call-1', name: 'read_file', argsJson: '{"path":"a.ts"}' },
      { type: 'tool_result', id: 'call-1', ok: true, content: 'ok' },
      {
        type: 'permission_request',
        id: 'perm-1',
        tool: 'bash',
        argsJson: '{"cmd":"ls"}',
        options: ['allow', 'deny'],
      },
      { type: 'plan', steps: [{ title: '步骤一', status: 'pending' }] },
      { type: 'usage', input: 100, output: 20 },
      { type: 'external_session', id: 'sess-123' },
      { type: 'error', message: '进程退出', fatal: true },
      { type: 'done', exitCode: 0 },
    ];
    expect(events).toHaveLength(10);
    expect(events.every((e) => typeof e.type === 'string')).toBe(true);
  });

  it('ExternalAgentSpec / ExternalAgentAdapter 结构合法（契约消费前哨）', async () => {
    const tier: ExternalTier = 'A';
    const spec: ExternalAgentSpec = {
      id: 'cli:claude-code',
      kind: 'stream-json-jsonl',
      command: '/usr/local/bin/claude',
      args: [],
      tier,
      version: '1.0.0',
      permissionArgs: { plan: [], default: [], yolo: [] },
      resumeArgs: (sessionId: string) => ['--resume', sessionId],
      mcpArgs: (configPath: string) => ['--mcp-config', configPath],
    };
    const adapter: ExternalAgentAdapter = {
      spec,
      run: async function* () {
        yield { type: 'done', exitCode: 0 };
      },
    };
    expect(adapter.spec.id).toBe('cli:claude-code');
    for await (const ev of adapter.run({
      prompt: 'hi',
      cwd: '/tmp',
      permissionMode: 'plan',
      signal: new AbortController().signal,
    })) {
      expect(ev.type).toBe('done');
    }
  });
});
