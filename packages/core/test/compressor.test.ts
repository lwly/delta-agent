import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@delta/shared';
import {
  partition,
  foldToolResults,
  shouldCompact,
  compact,
  TOOL_RESULT_FOLD_LIMIT,
  type CompressorDeps,
} from '../src/context/compressor.js';

function turn(i: number, toolResultLen = 10): ChatMessage[] {
  return [
    { role: 'user', content: `question ${i}`, tokens: 10 },
    { role: 'assistant', content: `answer ${i}`, tokens: 10 },
    ...(toolResultLen > 0
      ? [{ role: 'tool' as const, content: 'x'.repeat(toolResultLen), toolCallId: `c${i}`, tokens: toolResultLen }]
      : []),
  ];
}

const deps: CompressorDeps = {
  windowTokens: 1000,
  summarize: async (prev, transcript) => `SUMMARY(${prev.length}):${transcript.length}`,
};

describe('partition', () => {
  it('keeps the last 6 turns verbatim', () => {
    const messages = Array.from({ length: 10 }, (_, i) => turn(i)).flat();
    const { compactZone, keepZone } = partition(messages);
    // 10 turns of 3 messages = 30; keep last 6 turns = 18 messages
    expect(keepZone).toHaveLength(18);
    expect(compactZone).toHaveLength(12);
    expect(keepZone[0]!.content).toBe('question 4');
  });

  it('never splits a turn at message boundary', () => {
    const messages = Array.from({ length: 8 }, (_, i) => turn(i)).flat();
    const { keepZone } = partition(messages);
    expect(keepZone[0]!.role).toBe('user');
  });

  it('keeps everything when fewer than 6 turns', () => {
    const messages = Array.from({ length: 3 }, (_, i) => turn(i)).flat();
    const { compactZone } = partition(messages);
    expect(compactZone).toHaveLength(0);
  });
});

describe('foldToolResults', () => {
  it('folds oversized tool results', () => {
    const big = 'y'.repeat(TOOL_RESULT_FOLD_LIMIT + 1000);
    const messages: ChatMessage[] = [{ role: 'tool', content: big, toolCallId: 'c1' }];
    const folded = foldToolResults(messages);
    expect(folded[0]!.content.length).toBeLessThan(3000);
    expect(folded[0]!.content).toContain('已折叠');
  });

  it('leaves small tool results untouched', () => {
    const messages: ChatMessage[] = [{ role: 'tool', content: 'short', toolCallId: 'c1' }];
    expect(foldToolResults(messages)[0]!.content).toBe('short');
  });
});

describe('shouldCompact', () => {
  // latin: 3 chars ≈ 1 token → 5000 chars ≈ 1667 tokens
  const deps4k: CompressorDeps = { ...deps, windowTokens: 4000 }; // threshold 4000*0.65-1024 = 1576（E-2：65% 触发）
  it('triggers at 65% of window minus reserve', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'a'.repeat(5000), tokens: 1667 }];
    expect(shouldCompact(messages, deps4k)).toBe(true);
  });
  it('does not trigger below 65% of window', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'a'.repeat(3000), tokens: 1000 }];
    expect(shouldCompact(messages, deps4k)).toBe(false);
  });
  it('does not trigger for small contexts', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello', tokens: 10 }];
    expect(shouldCompact(messages, deps4k)).toBe(false);
  });
});

describe('compact', () => {
  it('produces summary + keep zone and reduces tokens', async () => {
    const messages = Array.from({ length: 12 }, (_, i) => turn(i, TOOL_RESULT_FOLD_LIMIT + 500)).flat();
    const result = await compact(messages, '', deps);
    expect(result.messages[0]!.content).toContain('<context_summary>');
    // 12 turns -> compact 6, keep 6 + 1 summary message = 19
    expect(result.messages).toHaveLength(19);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  });

  it('is a no-op when nothing to compact', async () => {
    const messages = turn(1);
    const result = await compact(messages, 'old', deps);
    expect(result.messages).toBe(messages);
    expect(result.summary).toBe('old');
  });
});
