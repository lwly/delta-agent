/**
 * 历史消息完整性修复（sanitization）。
 *
 * OpenAI 兼容网关（deepseek 等）强校验 assistant.tool_calls 与 tool 消息一一配对：
 * "An assistant message with 'tool_calls' must be followed by tool messages
 *  responding to each 'tool_call_id'"。上一轮在工具调用中途被 abort/异常收尾时，
 * 历史中可能留下断裂（assistant 声明了调用但缺少对应 tool 消息），再次请求即 http 400。
 *
 * 在构建 LLM 请求消息数组前做一次修复：
 * - 丢弃没有任何 tool 消息响应的悬空 tool_calls（有文本则降级为纯文本 assistant 消息）
 * - 丢弃孤儿 tool 消息（前面没有对应调用声明，网关同样会 400）
 * - 完整配对的历史原样保留（不改变顺序，不动 user/system 消息）
 */
import type { ChatMessage } from '@delta/shared';

export function sanitizeHistory(messages: ChatMessage[]): ChatMessage[] {
  // 预扫描：拥有 tool 消息响应的 callId 集合（位置只要在后面即可，顺序交由 pending 校验）
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) answered.add(m.toolCallId);
  }

  const out: ChatMessage[] = [];
  /** 已声明（且保留）但尚未见到 tool 消息响应的 callId */
  const pending = new Set<string>();

  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      // 仅保留有 tool 消息响应的调用；悬空调用一律剔除
      const calls = m.toolCalls.filter((c) => answered.has(c.id));
      if (calls.length === 0) {
        // 全部调用悬空（断链）→ 降级为纯文本助手消息；无文本则整条丢弃
        if (m.content.trim()) out.push({ ...m, toolCalls: undefined });
        continue;
      }
      out.push(calls.length === m.toolCalls.length ? m : { ...m, toolCalls: calls });
      for (const c of calls) pending.add(c.id);
      continue;
    }
    if (m.role === 'tool') {
      // 孤儿 tool 消息（没有对应调用声明）→ 丢弃，避免网关 400
      if (!m.toolCallId || !pending.has(m.toolCallId)) continue;
      pending.delete(m.toolCallId);
      out.push(m);
      continue;
    }
    out.push(m);
  }
  return out;
}
