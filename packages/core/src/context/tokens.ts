/**
 * Token estimation.
 *
 * Rules from memory-design.md / PRD:
 *  - CJK: ~1 token per character
 *  - Latin/other: ~3 characters per token
 */

const CJK_RE =
  /[\u2E80-\u2EFF\u3000-\u303F\u31C0-\u31EF\u3200-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F]/;

/** Count CJK characters in a string. */
function countCjk(text: string): number {
  let n = 0;
  for (const ch of text) if (CJK_RE.test(ch)) n++;
  return n;
}

/** Estimate tokens for a single string. */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  const cjk = countCjk(text);
  const rest = text.length - cjk;
  return cjk + Math.ceil(rest / 3);
}

const ROLE_OVERHEAD = 4; // per-message envelope overhead (role separators etc.)

/** Estimate tokens for a chat message list. */
export function estimateMessagesTokens(
  messages: Array<{ role: string; content: string; toolCalls?: Array<{ argsJson: string }> }>,
): number {
  let total = 0;
  for (const m of messages) {
    total += ROLE_OVERHEAD + estimateTextTokens(m.content);
    if (m.toolCalls) {
      for (const c of m.toolCalls) {
        total += estimateTextTokens(c.argsJson) + 8; // name + id overhead
      }
    }
  }
  return total;
}
