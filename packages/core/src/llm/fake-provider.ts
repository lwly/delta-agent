/**
 * F-45 E2E 脚本化假 Provider（零网络、零密钥、确定性）。
 *
 * 仅供 E2E / 冒烟使用：`DELTA_FAKE_PROVIDER=scripted|error|burn` 时由
 * resolveProviderFromEnv 注入（service.ts 钩子），或测试/e2e-serve 直接构造。
 * 默认关闭，对生产链路零影响。
 *
 * 模式语义：
 * - scripted：确定性「工具调用 → 最终答案」两轮脚本——历史无 tool 消息 → 发起
 *   read_file(note.txt) 工具调用；已有 tool 结果 → 输出最终文本 E2E_FAKE_DONE。
 *   DELTA_FAKE_CHUNK_DELAY_MS 可放慢流式分片（SIGINT 竞态窗口用）。
 * - error：每次调用立即产出不可重试错误（引擎致命错误 → headless 退出码 2）。
 * - burn：每次调用产出大用量（usage 计价走会话模型牌价，配 --model gpt-4o-mini
 *   + --max-cost 触发预算耗尽 → 退出码 4）。
 */
import type {
  ChatMessage,
  ChatRequest,
  LLMProvider,
  StreamEvent,
  ToolCall,
} from '@delta/shared';

export type FakeProviderMode = 'scripted' | 'error' | 'burn';

const FINAL_TEXT = 'E2E_FAKE_DONE：任务已完成。';
const LONG_TEXT = Array.from({ length: 40 }, (_, i) => `E2E_FAKE_LINE_${i}：流式分片用于 SIGINT 竞态窗口。`).join('\n');

export class ScriptedFakeProvider implements LLMProvider {
  readonly id = 'fake';
  private calls = 0;

  constructor(private readonly mode: FakeProviderMode = 'scripted') {}

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls++;
    if (this.mode === 'error') {
      yield { type: 'error', message: 'e2e fake: fatal provider error', retriable: false };
      yield { type: 'done' };
      return;
    }

    if (this.mode === 'burn') {
      // 与 scripted 同构的两轮脚本（先工具后答案）：保证跑到下一轮轮首的 guard 硬停，
      // 否则单轮终答案在预算检查前就正常完成，永远触发不了退出码 4
      const hasToolResult = req.messages.some((m: ChatMessage) => m.role === 'tool');
      if (!hasToolResult) {
        const call: ToolCall = {
          id: `fake_call_${this.calls}`,
          name: 'read_file',
          argsJson: JSON.stringify({ path: 'note.txt' }),
        };
        yield { type: 'tool_call_delta', index: 0, id: call.id, name: call.name, argsDelta: '' };
        yield { type: 'tool_call_delta', index: 0, argsDelta: call.argsJson };
        yield { type: 'usage', input: 200_000, output: 200_000 };
        yield { type: 'done' };
        return;
      }
      yield { type: 'text_delta', text: FINAL_TEXT };
      yield { type: 'usage', input: 200_000, output: 200_000 };
      yield { type: 'done' };
      return;
    }

    // scripted：按历史里是否已有 tool 结果决定本轮动作（多轮运行可重复触发同一脚本）
    const hasToolResult = req.messages.some((m: ChatMessage) => m.role === 'tool');
    if (!hasToolResult) {
      const call: ToolCall = {
        id: `fake_call_${this.calls}`,
        name: 'read_file',
        argsJson: JSON.stringify({ path: 'note.txt' }),
      };
      for (const [i, c] of [call].entries()) {
        yield { type: 'tool_call_delta', index: i, id: c.id, name: c.name, argsDelta: '' };
        const half = Math.ceil(c.argsJson.length / 2);
        yield { type: 'tool_call_delta', index: i, argsDelta: c.argsJson.slice(0, half) };
        yield { type: 'tool_call_delta', index: i, argsDelta: c.argsJson.slice(half) };
      }
      yield { type: 'usage', input: 100, output: 20 };
      yield { type: 'done' };
      return;
    }

    const delay = Number(process.env.DELTA_FAKE_CHUNK_DELAY_MS ?? 0);
    const text = process.env.DELTA_FAKE_LONG_REPLY === '1' ? LONG_TEXT : FINAL_TEXT;
    for (const chunk of text.match(/.{1,8}/gs) ?? []) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      yield { type: 'text_delta', text: chunk };
    }
    yield { type: 'usage', input: 100, output: 20 };
    yield { type: 'done' };
  }

  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
}
