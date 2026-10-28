import { describe, expect, it } from 'vitest';
import { splitSystemForCache } from '../src/llm/providers/anthropic.js';

describe('splitSystemForCache（E-4 prompt caching）', () => {
  it('静态前缀命中：拆为 [静态(cache_control) + 动态] 两块', () => {
    const staticText = '静态系统提示（identity/environment/tools 等八层）';
    const system = `${staticText}\n\n动态段：当前时间 2026-10-28`;
    const blocks = splitSystemForCache(system, staticText) as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: 'text',
      text: staticText,
      cache_control: { type: 'ephemeral' },
    });
    expect(blocks[1]).toMatchObject({ type: 'text', text: '动态段：当前时间 2026-10-28' });
    expect(blocks[1].cache_control).toBeUndefined(); // 动态段不打断点，避免破坏前缀缓存
  });

  it('静态即全部（无动态段）：单块缓存', () => {
    const system = '只有静态段的系统提示';
    const blocks = splitSystemForCache(system, system) as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'text', text: system, cache_control: { type: 'ephemeral' } });
  });

  it('systemStatic 缺失：整串打断点（退化为单块缓存，不报错）', () => {
    const blocks = splitSystemForCache('整条系统消息') as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'text', text: '整条系统消息', cache_control: { type: 'ephemeral' } });
  });

  it('systemStatic 不是前缀（防御）：退化为整串单块缓存', () => {
    const blocks = splitSystemForCache('AABB', 'CC') as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ text: 'AABB' });
  });

  it('静态段为空白串：视同缺失', () => {
    const blocks = splitSystemForCache('X  \n\n Y', '   ') as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
  });
});
