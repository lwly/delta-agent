import type { ToolCall } from '@delta/shared';

interface Accum {
  id: string;
  name: string;
  args: string;
}

/**
 * ToolCall delta accumulator (技术方案 §3.2).
 * Deltas are keyed by `index`; id/name normally arrive on the first fragment
 * and `arguments` JSON is spread over many fragments.
 */
export class ToolCallAccumulator {
  private buf = new Map<number, Accum>();

  ingest(ev: { index: number; id?: string; name?: string; argsDelta: string }): void {
    const cur = this.buf.get(ev.index) ?? { id: '', name: '', args: '' };
    if (ev.id) cur.id = ev.id;
    if (ev.name) cur.name = ev.name;
    cur.args += ev.argsDelta;
    this.buf.set(ev.index, cur);
  }

  hasAny(): boolean {
    return this.buf.size > 0;
  }

  /**
   * Finalize: parse each accumulator's JSON args with a lenient repair pass.
   * Calls whose args cannot be repaired are returned with a marker error so
   * the engine can feed the failure back to the model (self-heal path).
   */
  finalize(): ToolCall[] {
    const out: ToolCall[] = [];
    const indices = [...this.buf.keys()].sort((a, b) => a - b);
    for (const idx of indices) {
      const acc = this.buf.get(idx)!;
      const call: ToolCall = { id: acc.id || `call_${idx}`, name: acc.name, argsJson: acc.args };
      const parsed = parseLenientJson(call.argsJson);
      if (parsed.ok) {
        call.args = parsed.value as Record<string, unknown>;
      } else {
        call.argsJson = JSON.stringify({
          __parse_error: parsed.error,
          __raw: call.argsJson.slice(0, 2000),
        });
        call.args = {};
      }
      out.push(call);
    }
    return out;
  }

  reset(): void {
    this.buf.clear();
  }
}

/**
 * Lenient JSON repair: trim, strip code fences, fix trailing commas and
 * unclosed braces/brackets (common truncation artifacts).
 */
export function parseLenientJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  if (!text) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    /* fall through to repair */
  }
  try {
    let repaired = text.replace(/,\s*([}\]])/g, '$1');
    // balance delimiters
    const stack: string[] = [];
    let inStr = false;
    let esc = false;
    for (const ch of repaired) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') stack.pop();
    }
    if (inStr) repaired += '"';
    while (stack.length) repaired += stack.pop();
    return { ok: true, value: JSON.parse(repaired) };
  } catch (e) {
    return { ok: false, error: `invalid tool args json: ${(e as Error).message}` };
  }
}
