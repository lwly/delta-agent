import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from '@y-zero/shared';
import { sanitizeHistory } from '../src/llm/sanitize.js';

const user = (content: string): ChatMessage => ({ role: 'user', content });
const assistantText = (content: string): ChatMessage => ({ role: 'assistant', content });
const call = (id: string, name = 'exec'): ToolCall => ({ id, name, argsJson: '{}' });
const tool = (callId: string, content = 'ok'): ChatMessage => ({ role: 'tool', content, toolCallId: callId });

describe('sanitizeHistory', () => {
  it('完整配对的历史原样保留（引用不变）', () => {
    const history: ChatMessage[] = [
      user('hi'),
      { role: 'assistant', content: '查一下', toolCalls: [call('c1')] },
      tool('c1'),
      assistantText('完成'),
    ];
    expect(sanitizeHistory(history)).toEqual(history);
  });

  it('中止于工具执行中：悬空 tool_calls 被剔除，纯文本保留', () => {
    const history: ChatMessage[] = [
      user('hi'),
      { role: 'assistant', content: '让我执行命令', toolCalls: [call('c1')] },
    ];
    const out = sanitizeHistory(history);
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({ role: 'assistant', content: '让我执行命令' });
    expect(out[1]!.toolCalls).toBeUndefined();
  });

  it('悬空 tool_calls 且无文本的 assistant 消息整条丢弃', () => {
    const history: ChatMessage[] = [
      user('hi'),
      { role: 'assistant', content: '', toolCalls: [call('c1')] },
    ];
    expect(sanitizeHistory(history)).toEqual([user('hi')]);
  });

  it('部分调用有响应：仅保留已响应的调用，悬空调用剔除', () => {
    const history: ChatMessage[] = [
      user('hi'),
      { role: 'assistant', content: '并行查', toolCalls: [call('c1'), call('c2')] },
      tool('c1', 'result-1'),
    ];
    const out = sanitizeHistory(history);
    expect(out).toHaveLength(3);
    expect(out[1]!.toolCalls).toEqual([call('c1')]);
    expect(out[2]).toEqual(tool('c1', 'result-1'));
  });

  it('孤儿 tool 消息（无对应调用声明）被丢弃', () => {
    const history: ChatMessage[] = [
      user('hi'),
      assistantText('回答'),
      tool('c1', 'stray'),
    ];
    expect(sanitizeHistory(history)).toEqual([user('hi'), assistantText('回答')]);
  });

  it('保留工具轮次间插入的用户提示及其后的 tool 消息（断路器 note 场景）', () => {
    const history: ChatMessage[] = [
      user('hi'),
      { role: 'assistant', content: '', toolCalls: [call('c1'), call('c2')] },
      tool('c1'),
      user('（系统提示：工具 exec 已连续失败 3 次…）'),
      tool('c2'),
      assistantText('done'),
    ];
    expect(sanitizeHistory(history)).toEqual(history);
  });

  it('连续多组 tool_calls 全配对：原样保留', () => {
    const history: ChatMessage[] = [
      user('hi'),
      { role: 'assistant', content: '查', toolCalls: [call('c1'), call('c2')] },
      tool('c1'),
      tool('c2'),
      { role: 'assistant', content: '再查', toolCalls: [call('c3')] },
      tool('c3'),
      assistantText('完成'),
    ];
    expect(sanitizeHistory(history)).toEqual(history);
  });

  it('tool 消息乱序响应（c2 先于 c1）：两组都保留', () => {
    const history: ChatMessage[] = [
      user('hi'),
      { role: 'assistant', content: '', toolCalls: [call('c1'), call('c2')] },
      tool('c2', 'result-2'),
      tool('c1', 'result-1'),
      assistantText('完成'),
    ];
    expect(sanitizeHistory(history)).toEqual(history);
  });

  it('同一 callId 重复 tool 消息：仅保留第一条，重复视为孤儿丢弃', () => {
    const history: ChatMessage[] = [
      user('hi'),
      { role: 'assistant', content: '', toolCalls: [call('c1')] },
      tool('c1', 'first'),
      tool('c1', 'second'),
      assistantText('完成'),
    ];
    const out = sanitizeHistory(history);
    expect(out).toEqual([history[0], history[1], tool('c1', 'first'), assistantText('完成')]);
  });

  it('无文本 assistant 部分调用悬空：保留有响应的调用（含 tool_calls），不全丢', () => {
    const history: ChatMessage[] = [
      user('hi'),
      { role: 'assistant', content: '', toolCalls: [call('c1'), call('c2')] },
      tool('c1', 'result-1'),
    ];
    const out = sanitizeHistory(history);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ role: 'assistant', content: '', toolCalls: [call('c1')] });
    expect(out[2]).toEqual(tool('c1', 'result-1'));
  });

  it('空历史安全返回空数组', () => {
    expect(sanitizeHistory([])).toEqual([]);
  });
});
