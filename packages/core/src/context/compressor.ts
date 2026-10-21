import type { ChatMessage } from '@y-zero/shared';
import { estimateTextTokens, estimateMessagesTokens } from './tokens.js';

/** Tool results longer than this are folded before summarization (chars). */
export const TOOL_RESULT_FOLD_LIMIT = 4000;
/** Token headroom always reserved for system prompt + next reply. */
export const SAFETY_RESERVE_TOKENS = 1024;
/** Turns (user -> assistant exchanges) kept verbatim. */
export const KEEP_TURNS = 6;

export interface CompactionResult {
  messages: ChatMessage[];
  summary: string;
  beforeTokens: number;
  afterTokens: number;
}

export interface CompressorDeps {
  /** model window size in tokens (e.g. 200k) */
  windowTokens: number;
  /** summarize function backed by the session's main model (decision #10) */
  summarize: (prevSummary: string, foldedTranscript: string) => Promise<string>;
}

interface Partition {
  /** older messages subject to compaction */
  compactZone: ChatMessage[];
  /** recent messages kept verbatim */
  keepZone: ChatMessage[];
}

/**
 * Split message list into keep / compact zones at message boundaries.
 * A "turn" starts at a `user` message; we keep the last KEEP_TURNS turns,
 * never splitting an assistant tool-call from its tool results.
 */
export function partition(messages: ChatMessage[]): Partition {
  if (messages.length === 0) return { compactZone: [], keepZone: [] };

  // Find start index of each turn (user message that is not a tool answer).
  let turns = 0;
  let keepStart = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') {
      turns++;
      if (turns === KEEP_TURNS) {
        keepStart = i;
        break;
      }
    }
  }
  if (turns < KEEP_TURNS) {
    // fewer than K turns: keep everything from the first user message,
    // but never compact away a tool result whose call is in the keep zone.
    keepStart = messages.findIndex((m) => m.role === 'user');
    if (keepStart < 0) keepStart = 0;
  }
  return {
    compactZone: messages.slice(0, keepStart),
    keepZone: messages.slice(keepStart),
  };
}

/**
 * Fold oversized tool results into "signature + head + tail" blocks.
 */
export function foldToolResults(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role === 'tool' && m.content.length > TOOL_RESULT_FOLD_LIMIT) {
      const head = m.content.slice(0, 2000);
      const tail = m.content.slice(-500);
      const folded: ChatMessage = {
        ...m,
        content:
          `${head}\n...[工具结果过长，已折叠 ${m.content.length - 2500} 字符]...\n${tail}`,
      };
      folded.tokens = estimateTextTokens(folded.content);
      return folded;
    }
    return m;
  });
}

/**
 * Compact trigger check.
 */
export function shouldCompact(messages: ChatMessage[], deps: CompressorDeps): boolean {
  const used = estimateMessagesTokens(messages);
  return used >= deps.windowTokens * 0.8 - SAFETY_RESERVE_TOKENS;
}

/**
 * Run one compaction pass:
 *  1. partition keep/compact zones
 *  2. fold large tool results in compact zone
 *  3. rolling-summary the folded transcript via the session's main model
 *  4. rebuild [compact-zone-as-summary] + keep zone
 *
 * Raw messages are never destroyed here — persistence layer keeps originals
 * and records a compaction event for replay (PRD §6/技术方案 §6.1).
 */
export async function compact(
  messages: ChatMessage[],
  prevSummary: string,
  deps: CompressorDeps,
): Promise<CompactionResult> {
  const beforeTokens = estimateMessagesTokens(messages);
  const { compactZone, keepZone } = partition(messages);

  if (compactZone.length === 0) {
    return {
      messages,
      summary: prevSummary,
      beforeTokens,
      afterTokens: beforeTokens,
    };
  }

  const folded = foldToolResults(compactZone);
  const transcript = folded
    .map((m) => {
      const calls = m.toolCalls?.map((c) => ` [调用 ${c.name}]`).join('') ?? '';
      return `<${m.role}>${m.content}${calls}</${m.role}>`;
    })
    .join('\n');

  const summary = await deps.summarize(prevSummary, transcript);

  // Rolling summary is injected as a user-role context block at the front of
  // the keep zone (assistant-visible), structured per 技术方案 §6.2.
  const summaryMessage: ChatMessage = {
    role: 'user',
    content: `<context_summary>\n${summary}\n</context_summary>\n（以上为早前对话的滚动摘要，原始细节已压缩）`,
  };
  summaryMessage.tokens = estimateTextTokens(summaryMessage.content);

  const out = [summaryMessage, ...keepZone];
  const afterTokens = estimateMessagesTokens(out);
  return { messages: out, summary, beforeTokens, afterTokens };
}
