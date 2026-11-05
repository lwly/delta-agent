// F-55 外部 CLI Agent 占位 Provider：
// 外部会话（cli:claude-code / cli:codex / acp:*）的 model 字段指向虚拟 id，
// 没有真实 LLM 后端；若引擎误把该会话路由到 LLMProvider，chat() 在迭代时立即
// reject，携带 external_agent_no_llm 标记，便于上层给出明确报错而非静默失败。
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent } from '@delta/shared';

export class UnavailableProvider implements LLMProvider {
  constructor(private readonly virtualId: string) {}

  get id(): string {
    return this.virtualId;
  }

  async *chat(_req: ChatRequest): AsyncGenerator<StreamEvent> {
    // async generator 中 throw 会在「迭代时」reject（而非调用 chat 时），
    // 正是外部会话不可调用 LLM 的语义。
    throw new Error(
      `external_agent_no_llm: ${this.virtualId} 是外部 CLI Agent 会话的虚拟 model id，` +
        '不可调用 LLMProvider（外部会话由对应 adapter 直接驱动）',
    );
  }

  estimateTokens(_messages: ChatMessage[]): number {
    return 0;
  }
}
