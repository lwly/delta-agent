/**
 * F-17 对话检索测试：FTS5 全文（中文 bigram）、存量回填、软删过滤、
 * 语义向量（注入假 embedder）、RRF 混合去重、HTTP 端点。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage } from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { SearchStore, ftsTokenize, buildFtsQuery, makeSnippet } from '../src/session/search.js';
import { EmbeddingClient } from '../src/llm/embeddings.js';
import { SessionHub, createWebServer } from '../src/server/index.js';
import type { SessionHubDeps } from '../src/server/hub.js';
import { ToolRegistry } from '../src/tools/registry.js';

const msg = (role: ChatMessage['role'], content: string): ChatMessage => ({ role, content });

/** 假 embedder：概念词表映射到固定维度（同义词共享维度 → 余弦可比较） */
class FakeEmbedder extends EmbeddingClient {
  private static DIMS: Array<{ dim: number; words: string[] }> = [
    { dim: 0, words: ['池化', 'pooling', '连接池'] },
    { dim: 1, words: ['缓存', 'cache'] },
    { dim: 2, words: ['性能', 'performance'] },
  ];
  constructor() {
    super({ apiKey: 'fake', baseUrl: 'http://localhost:0', model: 'fake-embedding' });
  }
  override async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const lower = t.toLowerCase();
      const v = [0.01, 0.01, 0.01];
      for (const d of FakeEmbedder.DIMS) {
        if (d.words.some((w) => lower.includes(w))) v[d.dim] = 1;
      }
      return v;
    });
  }
}

let tmp = '';
let service: SessionService;
let projectId: string;
let sessionId: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-search-'));
  // 注入假 embedder，隔离网络
  service = new SessionService(path.join(tmp, 'db.sqlite'), { embedderFactory: () => new FakeEmbedder() });
  projectId = service.ensureProject(tmp).id;
  sessionId = service.createSession(projectId, { title: '数据库优化讨论' }).id;
  service.appendMessage(sessionId, msg('user', '帮我分析如何用池化技术优化数据库性能'));
  service.appendMessage(sessionId, msg('assistant', '可以引入连接池，控制最大连接数并复用连接。'));
});

afterEach(async () => {
  service.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('分词与查询构建', () => {
  it('ftsTokenize：中文 bigram + 英文词，无单字 CJK', () => {
    expect(ftsTokenize('对话检索 full text')).toEqual(['full', 'text', '对话', '话检', '检索']);
    expect(ftsTokenize('中')).toEqual(['中']);
  });

  it('buildFtsQuery：token 加引号 AND 连接；无 token 返回 null', () => {
    expect(buildFtsQuery('对话 检索')).toBe('"对话" AND "检索"');
    expect(buildFtsQuery('！！')).toBeNull();
  });

  it('makeSnippet：命中窗口截取与回退', () => {
    const long = '前置铺垫。'.repeat(30) + '关键词池化出现在这里' + '后置内容。'.repeat(30);
    const s = makeSnippet(long, '池化');
    expect(s).toContain('池化');
    expect(s.length).toBeLessThan(120);
    expect(makeSnippet('短文本', '不存在词')).toBe('短文本');
  });
});

describe('全文检索', () => {
  it('中文查询命中 bigram 索引，含会话标题与片段', async () => {
    const hits = await service.searchMessages('连接池', { mode: 'fulltext' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.sessionId).toBe(sessionId);
    expect(hits[0]!.sessionTitle).toBe('数据库优化讨论');
    expect(hits[0]!.via).toBe('fulltext');
  });

  it('英文单词查询命中', async () => {
    service.appendMessage(sessionId, msg('user', 'check the connection pooling config please'));
    const hits = await service.searchMessages('pooling', { mode: 'fulltext' });
    expect(hits.some((h) => h.content.includes('pooling'))).toBe(true);
  });

  it('软删除会话不参与检索', async () => {
    service.removeSession(sessionId);
    const hits = await service.searchMessages('池化', { mode: 'fulltext' });
    expect(hits).toHaveLength(0);
  });

  it('存量消息懒回填：清空索引后仍可检索', async () => {
    service.store.db.prepare('DELETE FROM messages_fts').run();
    const hits = await service.searchMessages('池化', { mode: 'fulltext' });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('硬删除级联清理 FTS 行', async () => {
    const s2 = service.createSession(projectId, { title: '待硬删' }).id;
    service.appendMessage(s2, msg('user', '独有关键词量子纠缠检测'));
    service.removeSession(s2, { hard: true });
    const count = (
      service.store.db.prepare("SELECT COUNT(*) AS c FROM messages_fts WHERE session_id = ?").get(s2) as { c: number }
    ).c;
    expect(count).toBe(0);
  });
});

describe('语义检索与混合', () => {
  it('语义命中无词汇重叠的同义内容', async () => {
    // 查询与内容共享概念词（池化/pooling），但全文 token 无交集
    const hits = await service.searchMessages('connection pooling design', { mode: 'semantic' });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.via).toBe('semantic');
  });

  it('auto 模式两路命中去重合并为 hybrid', async () => {
    service.appendMessage(sessionId, msg('user', '请介绍 pooling 池化的最佳实践'));
    const hits = await service.searchMessages('池化 pooling', { mode: 'auto' });
    const target = hits.find((h) => h.content.includes('最佳实践'));
    expect(target).toBeDefined();
    expect(target!.via).toBe('hybrid');
    // 无重复 messageId
    const ids = hits.map((h) => h.messageId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('embedder 失败时降级为纯全文且不抛错', async () => {
    const broken = new SessionService(path.join(tmp, 'db2.sqlite'), {
      embedderFactory: () => new EmbeddingClient({ apiKey: 'x', baseUrl: 'http://127.0.0.1:1', model: 'm' }),
    });
    try {
      const pid = broken.ensureProject(tmp).id;
      const sid = broken.createSession(pid, { title: 't' }).id;
      broken.appendMessage(sid, msg('user', '数据库池化优化'));
      const hits = await broken.searchMessages('池化', { mode: 'auto' });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.via).toBe('fulltext');
      expect(broken.search.semanticAvailable).toBe(false);
    } finally {
      broken.close();
    }
  });
});

describe('HTTP 端点', () => {
  it('GET /api/search/messages 返回命中', async () => {
    const deps: SessionHubDeps = {
      service,
      registry: new ToolRegistry(),
      resolveProvider: async () => {
        throw new Error('not used');
      },
    };
    const hub = new SessionHub(deps);
    const server = createWebServer({ service, hub, port: 0 });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const addr = server.address();
      const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      const res = await fetch(`${base}/api/search/messages?q=${encodeURIComponent('池化')}&mode=fulltext`);
      expect(res.status).toBe(200);
      const hits = (await res.json()) as Array<{ sessionId: string; via: string }>;
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.sessionId).toBe(sessionId);
    } finally {
      server.close();
    }
  });
});
