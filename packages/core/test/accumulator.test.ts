import { describe, expect, it } from 'vitest';
import { ToolCallAccumulator, parseLenientJson } from '../src/llm/accumulator.js';

describe('ToolCallAccumulator', () => {
  it('accumulates args spread over fragments', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest({ index: 0, id: 't1', name: 'read_file', argsDelta: '{"pa' });
    acc.ingest({ index: 0, argsDelta: 'th": "src/' });
    acc.ingest({ index: 0, argsDelta: 'main.ts"}' });
    const calls = acc.finalize();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('read_file');
    expect(calls[0]!.args).toEqual({ path: 'src/main.ts' });
  });

  it('handles multiple parallel calls by index', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest({ index: 0, id: 'a', name: 'read_file', argsDelta: '{"path":"a.ts"}' });
    acc.ingest({ index: 1, id: 'b', name: 'list_dir', argsDelta: '{"depth":2}' });
    const calls = acc.finalize();
    expect(calls.map((c) => c.name)).toEqual(['read_file', 'list_dir']);
  });

  it('handles out-of-order indices deterministically', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest({ index: 2, id: 'c', name: 'c_tool', argsDelta: '{}' });
    acc.ingest({ index: 0, id: 'a', name: 'a_tool', argsDelta: '{}' });
    const calls = acc.finalize();
    expect(calls.map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('repairs truncated json (unclosed braces/strings)', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest({ index: 0, id: 'x', name: 'write_file', argsDelta: '{"path":"a.ts","content":"hel' });
    const calls = acc.finalize();
    expect(calls[0]!.args).toEqual({ path: 'a.ts', content: 'hel' });
  });

  it('repairs trailing commas', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest({ index: 0, id: 'x', name: 't', argsDelta: '{"a":1,}' });
    expect(acc.finalize()[0]!.args).toEqual({ a: 1 });
  });

  it('marks unrepairable json with __parse_error instead of crashing', () => {
    const acc = new ToolCallAccumulator();
    acc.ingest({ index: 0, id: 'x', name: 't', argsDelta: '{"a": tru' });
    const calls = acc.finalize();
    const parsed = JSON.parse(calls[0]!.argsJson) as Record<string, unknown>;
    expect(parsed.__parse_error).toBeDefined();
  });
});

describe('parseLenientJson', () => {
  it('strips code fences', () => {
    expect(parseLenientJson('```json\n{"a":1}\n```')).toEqual({ ok: true, value: { a: 1 } });
  });
  it('returns empty for blank input', () => {
    expect(parseLenientJson('  ')).toEqual({ ok: true, value: {} });
  });
  it('balances delimiters', () => {
    expect(parseLenientJson('{"list":[1,2')).toEqual({ ok: true, value: { list: [1, 2] } });
  });
});
