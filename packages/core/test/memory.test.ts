import { describe, expect, it, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent } from '@y-zero/shared';
import { SessionStore } from '../src/session/store.js';
import {
  MemoryStore,
  memoryTokenize,
  coverageOf,
  MEMORY_QUOTA,
  RECALL_THRESHOLD,
} from '../src/session/memory.js';
import { distillMemories } from '../src/session/distill.js';

let store: SessionStore;
let mem: MemoryStore;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-mem-'));
  store = new SessionStore(path.join(dir, 'test.db'));
  mem = new MemoryStore(store.db);
});

describe('memory tokenize / coverage', () => {
  it('chinese bigrams + english words', () => {
    const t = memoryTokenize('用户偏好 Vue3 组合式 API');
    expect(t.has('用户')).toBe(true);
    expect(t.has('户偏')).toBe(true);
    expect(t.has('vue3')).toBe(true);
    expect(t.has('api')).toBe(true);
  });

  it('coverageOf measures query covered fraction', () => {
    const q = memoryTokenize('数据库连接池大小配置');
    expect(coverageOf(q, '数据库连接池默认大小配置为 20')).toBeGreaterThan(0.5);
    expect(coverageOf(q, '完全不相关的记忆内容关于前端框架')).toBeLessThan(0.3);
  });
});

describe('write pipeline (save)', () => {
  it('creates, dedupes by sha256 within scope, merges confidence', () => {
    const r1 = mem.save({ scope: 'global', kind: 'preference', content: '用户偏好 pnpm', confidence: 0.7 });
    expect(r1.action).toBe('created');
    const r2 = mem.save({ scope: 'global', kind: 'preference', content: '用户偏好 pnpm', confidence: 0.9 });
    expect(r2.action).toBe('duplicate');
    expect(r2.id).toBe(r1.id);
    expect(mem.get(r1.id)!.confidence).toBe(0.9);
    // 不同 scope 不互相去重（隔离）
    const r3 = mem.save({ scope: 'project:p1', kind: 'preference', content: '用户偏好 pnpm' });
    expect(r3.action).toBe('created');
  });

  it('supersedes conflicting same-kind facts (old gets low confidence)', () => {
    mem.save({ scope: 'global', kind: 'fact', content: '数据库连接池大小配置为 20 个连接' });
    const r = mem.save({ scope: 'global', kind: 'fact', content: '数据库连接池大小配置为 50 个连接' });
    expect(r.action).toBe('superseded');
    const items = mem.list({ scope: 'global' });
    const old = items.find((m) => m.content.includes('20 个'));
    const neu = items.find((m) => m.content.includes('50 个'));
    expect(old!.confidence).toBe(0.3);
    expect(neu!.confidence).toBeGreaterThan(0.3);
  });

  it('evicts low-importance oldest on quota overflow (importance=1 pinned)', () => {
    for (let i = 0; i < MEMORY_QUOTA; i++) {
      mem.save({ scope: 's', kind: 'fact', content: `普通记忆条目 ${i} 关于项目约定`, importance: 0.5 });
    }
    mem.save({ scope: 's', kind: 'fact', content: '置顶记忆绝不被淘汰', importance: 1 });
    // 超额 1 条 → 淘汰一条低重要性
    const r = mem.save({ scope: 's', kind: 'fact', content: '新记忆触发配额淘汰', importance: 0.9 });
    expect(r.evicted.length).toBeGreaterThanOrEqual(1);
    expect(mem.list({ scope: 's' }).some((m) => m.id === r.id)).toBe(true);
    expect(mem.list({ scope: 's' }).some((m) => m.content.includes('置顶记忆'))).toBe(true);
    // 淘汰项进回收站，可恢复
    expect(mem.listTrash().length).toBeGreaterThan(0);
    const evicted = r.evicted[0]!;
    expect(mem.restore(evicted.id)).toBe(true);
  });
});

describe('recall scoring', () => {
  it('ranks relevant memories, applies threshold, counts access', () => {
    mem.save({ scope: 'global', kind: 'preference', content: '用户偏好使用 pnpm 管理依赖', importance: 0.9 });
    mem.save({ scope: 'global', kind: 'pitfall', content: 'Node 20 下 better-sqlite3 需要预编译二进制' });
    mem.save({ scope: 'global', kind: 'fact', content: '团队周会在每周一上午' });

    const hits = mem.recall('依赖管理工具用什么包管理器', ['global'], 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.item.content).toContain('pnpm');
    expect(hits[0]!.score).toBeGreaterThan(RECALL_THRESHOLD);
    expect(mem.get(hits[0]!.item.id)!.access_count).toBe(1);

    // 无关查询低于阈值不召回
    const none = mem.recall('量子纠缠实验设计', ['global'], 5);
    expect(none).toHaveLength(0);
  });

  it('scope chain merge: session over project over global', () => {
    mem.save({ scope: 'global', kind: 'fact', content: '全局约定：使用 TypeScript 严格模式' });
    mem.save({ scope: 'project:p1', kind: 'fact', content: '项目约定：数据库连接池大小配置为 20' });
    const hits = mem.recall('数据库连接池配置', ['session:s1', 'project:p1', 'global'], 5);
    expect(hits.some((h) => h.item.scope === 'project:p1')).toBe(true);
  });
});

describe('pending queue (auto-distill candidates)', () => {
  it('pending items are not recalled until approved', () => {
    const r = mem.save({ scope: 'global', kind: 'fact', content: '待确认的偏好记忆条目关于部署流程', status: 'pending' });
    expect(mem.recall('部署流程', ['global'], 5)).toHaveLength(0);
    expect(mem.approve(r.id)).toBe(true);
    expect(mem.recall('部署流程', ['global'], 5).length).toBeGreaterThan(0);
  });

  it('reject soft-deletes the candidate', () => {
    const r = mem.save({ scope: 'global', kind: 'fact', content: '要被拒绝的候选记忆', status: 'pending' });
    mem.reject(r.id);
    expect(mem.get(r.id)!.deleted_at).not.toBeNull();
    expect(mem.listTrash()).toHaveLength(1);
  });
});

describe('lifecycle', () => {
  it('update / remove / trash / purgeExpired', () => {
    const r = mem.save({ scope: 'global', kind: 'fact', content: '原始内容条目' });
    mem.update(r.id, { content: '更新后的内容条目', importance: 0.9 });
    expect(mem.get(r.id)!.importance).toBe(0.9);
    mem.remove(r.id);
    expect(mem.list({ scope: 'global' })).toHaveLength(0);
    // 过期清除：伪造 31 天前
    store.db.prepare('UPDATE memories SET deleted_at = ? WHERE id = ?').run(Date.now() - 31 * 86_400_000, r.id);
    expect(mem.purgeExpired(30)).toBe(1);
  });
});

describe('distillMemories', () => {
  class MockProvider implements LLMProvider {
    readonly id = 'mock';
    constructor(private body: string) {}
    async *chat(): AsyncIterable<StreamEvent> {
      yield { type: 'text_delta', text: this.body };
      yield { type: 'done' };
    }
    estimateTokens(m: ChatMessage[]): number {
      return m.length;
    }
  }

  it('extracts proposals and saves as pending', async () => {
    const provider = new MockProvider(
      '[{"kind":"preference","content":"用户偏好浅色主题","importance":0.8,"confidence":0.7}]',
    );
    const r = await distillMemories(mem, provider as LLMProvider, 'm', {
      scope: 'global',
      transcript: 'user: 我喜欢浅色主题\nassistant: 好的已记录',
    });
    expect(r.saved).toBe(1);
    expect(mem.listPending()).toHaveLength(1);
    // 提炼候选置信度封顶 0.7
    expect(mem.listPending()[0]!.confidence).toBeLessThanOrEqual(0.7);
  });

  it('returns empty on unparseable output', async () => {
    const provider = new MockProvider('我觉得没什么值得记的。');
    const r = await distillMemories(mem, provider as LLMProvider, 'm', {
      scope: 'global',
      transcript: 'user: hi',
    });
    expect(r.saved).toBe(0);
  });
});
