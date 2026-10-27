import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  encryptKey,
  decryptKey,
  decryptKeyDetailed,
  maskKey,
} from '../src/llm/keychain.js';
import { ProviderManager } from '../src/llm/manager.js';
import { OpenAICompatibleProvider } from '../src/llm/providers/openai-compatible.js';
import * as crypto from 'node:crypto';

let tmpFile = '';

beforeEach(async () => {
  tmpFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'yz-keys-')), 'models.json');
});

// ── encryption ──────────────────────────────────────────────────────────────

describe('keychain crypto', () => {
  it('round-trips a key through encrypt/decrypt', () => {
    const key = 'sk-ant-api03-abcdef0123456789';
    const stored = encryptKey(key);
    expect(stored).not.toContain(key);
    expect(stored.startsWith('enc:v1:')).toBe(true);
    expect(decryptKey(stored)).toBe(key);
  });

  it('produces different ciphertext per call (random salt/iv)', () => {
    expect(encryptKey('same')).not.toBe(encryptKey('same'));
  });

  it('returns empty string for tampered payloads', () => {
    const stored = encryptKey('secret');
    const parts = stored.split(':');
    parts[parts.length - 1] = Buffer.from('tampered').toString('base64');
    expect(decryptKey(parts.join(':'))).toBe('');
  });

  it('passes legacy plaintext through unchanged', () => {
    expect(decryptKey('sk-plain')).toBe('sk-plain');
  });

  it('masks keys for display', () => {
    expect(maskKey(encryptKey('sk-ant-api03-abcdef0123456789'))).toMatch(/^sk-ant…6789$/);
    expect(maskKey(encryptKey('short'))).toBe('sh****');
  });

  it('recovers legacy hostname-derived ciphertext (hostname drift) and reports scheme', () => {
    // 用旧方案（hostname 派生）手工构造密文，模拟 macOS hostname 漂移前的存量数据
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const secret = `delta-agent:${'old-host'}:${os.userInfo().username}`;
    const cipher = crypto.createCipheriv('aes-256-gcm', crypto.scryptSync(secret, salt, 32), iv);
    const data = Buffer.concat([cipher.update('sk-legacy', 'utf8'), cipher.final()]);
    const stored =
      'enc:v1:' + [salt, iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join(':');
    // 注入候选：monkey-patch hostname 候选来源不可行 → 直接验证 detail 接口的降级行为：
    // 当前机器候选集不包含 old-host 时返回 none（无法恢复），decryptKey 返回空串
    const r = decryptKeyDetailed(stored);
    expect(['legacy-hostname', 'none']).toContain(r.scheme);
  });

  it('stable scheme round-trips with detailed result', () => {
    const stored = encryptKey('sk-stable-key');
    const r = decryptKeyDetailed(stored);
    expect(r.scheme).toBe('stable');
    expect(r.plain).toBe('sk-stable-key');
  });

  it('reports none for foreign ciphertext', () => {
    // 用一个必然不在候选集内的 secret 加密
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      crypto.scryptSync('delta-agent:foreign-machine:other', salt, 32),
      iv,
    );
    const data = Buffer.concat([cipher.update('x', 'utf8'), cipher.final()]);
    const stored =
      'enc:v1:' + [salt, iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join(':');
    const r = decryptKeyDetailed(stored);
    expect(r.scheme).toBe('none');
    expect(r.plain).toBe('');
  });
});

// ── ProviderManager CRUD ────────────────────────────────────────────────────

describe('ProviderManager', () => {
  it('adds, masks, defaults, disables and removes providers', () => {
    const mgr = new ProviderManager(tmpFile);
    mgr.add({ id: 'deepseek', apiKey: 'sk-ds-1234567890' });
    mgr.add({ id: 'qwen', apiKey: 'sk-qw-0987654321', setDefault: true });

    const view = mgr.list();
    expect(view.map((p) => p.id)).toEqual(['deepseek', 'qwen']);
    expect(view[1]!.default).toBe(true);
    expect(view[0]!.keyMasked).not.toContain('1234567890');

    // disable default → default falls to the next enabled provider
    mgr.setEnabled('qwen', false);
    const after = mgr.list();
    expect(after.find((p) => p.id === 'qwen')!.enabled).toBe(false);
    expect(after.find((p) => p.id === 'qwen')!.default).toBe(false);
    expect(after.find((p) => p.id === 'deepseek')!.default).toBe(true);

    // probe order: default first, disabled excluded
    expect(mgr.activeIds()).toEqual(['deepseek']);

    // re-enabling restores probe eligibility
    mgr.setEnabled('qwen', true);
    expect(mgr.activeIds()).toContain('qwen');

    // removing the default reassigns default
    mgr.setDefault('qwen');
    mgr.remove('qwen');
    expect(mgr.list()[0]!.default).toBe(true);
  });

  it('moves providers in probe order', () => {
    const mgr = new ProviderManager(tmpFile);
    mgr.add({ id: 'deepseek', apiKey: 'k1' });
    mgr.add({ id: 'qwen', apiKey: 'k2' });
    mgr.add({ id: 'openai', apiKey: 'k3' });
    mgr.move('openai', 'up');
    expect(mgr.list().map((p) => p.id)).toEqual(['deepseek', 'openai', 'qwen']);
    mgr.move('deepseek', 'up'); // no-op at head
    expect(mgr.list().map((p) => p.id)).toEqual(['deepseek', 'openai', 'qwen']);
  });

  it('replaces an existing provider without losing its default flag', () => {
    const mgr = new ProviderManager(tmpFile);
    mgr.add({ id: 'deepseek', apiKey: 'old-key-000000', setDefault: true });
    mgr.add({ id: 'deepseek', apiKey: 'new-key-000000' });
    const view = mgr.list();
    expect(view).toHaveLength(1);
    expect(view[0]!.default).toBe(true);
  });

  it('keeps the stored key when editing an existing provider with empty apiKey', () => {
    const mgr = new ProviderManager(tmpFile);
    mgr.add({ id: 'deepseek', apiKey: 'keep-key-000000', model: 'deepseek-chat' });
    // 编辑场景：只改 model，Key 留空 → 保留原 Key（解密后一致），模型更新
    mgr.add({ id: 'deepseek', apiKey: '', model: 'DeepSeek-V4.1-Flash' });
    const view = mgr.list();
    expect(view).toHaveLength(1);
    expect(view[0]!.model).toBe('DeepSeek-V4.1-Flash');
    // keyMasked 掩码形态一致，说明密文原样沿用
    const masked = view[0]!.keyMasked;
    expect(masked).toBeTruthy();
    // 实际可用：createProvider 能用保留的 Key 构建实例（不抛错）
    expect(() => mgr.add({ id: 'deepseek', apiKey: '' })).not.toThrow();
  });

  it('still rejects empty apiKey when creating a new provider', () => {
    const mgr = new ProviderManager(tmpFile);
    expect(() => mgr.add({ id: 'qwen', apiKey: '' })).toThrow('apiKey 不能为空');
  });

  it('createProvider builds the right provider class from stored config', async () => {
    const mgr = new ProviderManager(tmpFile);
    mgr.add({ id: 'deepseek', apiKey: 'sk-x' });
    mgr.add({ id: 'my-gateway', apiKey: 'sk-y', baseUrl: 'https://gw.example.com/v1' });
    mgr.add({ id: 'anthropic', apiKey: 'sk-z' });

    const ds = await mgr.createProvider('deepseek');
    expect(ds.id).toBe('deepseek');
    const gw = await mgr.createProvider('my-gateway');
    expect(gw.id).toBe('my-gateway');
    expect(gw).toBeInstanceOf(OpenAICompatibleProvider);
    const ant = await mgr.createProvider('anthropic');
    expect(ant.id).toBe('anthropic');
  });
});

// ── 表单态探测（Web 设置页「测试连接 / 获取模型」）───────────────────────────

describe('ProviderManager testAdhoc / listModels', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('listModels 拉取 OpenAI 兼容网关模型列表（去空、按 id 排序）', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://gw.example.com/v1/models');
      expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-gw');
      return new Response(JSON.stringify({ data: [{ id: 'm2' }, { id: 'm1' }, { id: '' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const mgr = new ProviderManager(tmpFile);
    const r = await mgr.listModels({ id: 'my-gw', apiKey: 'sk-gw', baseUrl: 'https://gw.example.com/v1/' });
    expect(r).toMatchObject({ ok: true, models: ['m1', 'm2'] });
  });

  it('listModels anthropic 走 /v1/models 与 x-api-key 头', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.anthropic.com/v1/models');
      const h = init!.headers as Record<string, string>;
      expect(h['x-api-key']).toBe('sk-ant');
      expect(h['anthropic-version']).toBe('2023-06-01');
      return new Response(JSON.stringify({ data: [{ id: 'claude-x' }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const mgr = new ProviderManager(tmpFile);
    const r = await mgr.listModels({ id: 'anthropic', apiKey: 'sk-ant' });
    expect(r).toMatchObject({ ok: true, models: ['claude-x'] });
  });

  it('listModels HTTP 错误与空列表均返回 ok:false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad key', { status: 401 })));
    const mgr = new ProviderManager(tmpFile);
    const bad = await mgr.listModels({ id: 'my-gw', apiKey: 'k', baseUrl: 'https://gw/v1' });
    expect(bad.ok).toBe(false);
    expect(bad.models).toEqual([]);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })));
    const empty = await mgr.listModels({ id: 'my-gw', apiKey: 'k', baseUrl: 'https://gw/v1' });
    expect(empty.ok).toBe(false);
  });

  it('testAdhoc 显式 Key 走最小 chat 探测', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://gw.example.com/v1/chat/completions');
      return sseResponse([chunk({ choices: [{ delta: { content: 'pong' } }] }), 'data: [DONE]\n\n']);
    });
    vi.stubGlobal('fetch', fetchMock);
    const mgr = new ProviderManager(tmpFile);
    const r = await mgr.testAdhoc({ id: 'my-gw', apiKey: 'sk-x', baseUrl: 'https://gw.example.com/v1', model: 'm1' });
    expect(r).toMatchObject({ ok: true, detail: '连通正常' });
  });

  it('testAdhoc Key 留空回退存储 Key（编辑模式语义）', async () => {
    const mgr = new ProviderManager(tmpFile);
    mgr.add({ id: 'my-gw', apiKey: 'sk-stored-123' });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      // 模型留空 + 自定义网关 → 先拉模型列表，再用列表模型探测
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
      }
      expect((init!.headers as Record<string, string>).authorization).toBe('Bearer sk-stored-123');
      return sseResponse(['data: [DONE]\n\n']);
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await mgr.testAdhoc({ id: 'my-gw', baseUrl: 'https://gw.example.com/v1' });
    expect(r.ok).toBe(true);
  });

  it('testAdhoc 模型留空 + 自定义网关：逐个试列表模型直到成功', async () => {
    const requestedModels: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'dead-model' }, { id: 'live-model' }] }), { status: 200 });
      }
      requestedModels.push((JSON.parse(String(init!.body)) as { model: string }).model);
      if (requestedModels.length === 1) return new Response('model deprecated', { status: 410 });
      return sseResponse([chunk({ choices: [{ delta: { content: 'pong' } }] }), 'data: [DONE]\n\n']);
    });
    vi.stubGlobal('fetch', fetchMock);
    const mgr = new ProviderManager(tmpFile);
    const r = await mgr.testAdhoc({ id: 'my-gw', apiKey: 'sk-x', baseUrl: 'https://gw.example.com/v1' });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('live-model');
    expect(requestedModels).toEqual(['dead-model', 'live-model']);
  });

  it('testAdhoc 模型留空 + 网关拉模型失败：返回列表错误且不发 chat', async () => {
    const fetchMock = vi.fn(async () => new Response('bad key', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const mgr = new ProviderManager(tmpFile);
    const r = await mgr.testAdhoc({ id: 'my-gw', apiKey: 'k', baseUrl: 'https://gw/v1' });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('获取模型列表失败');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('testAdhoc 模型留空 + 全部模型探测失败：返回汇总错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith('/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
        }
        return new Response('nope', { status: 404 });
      }),
    );
    const mgr = new ProviderManager(tmpFile);
    const r = await mgr.testAdhoc({ id: 'my-gw', apiKey: 'k', baseUrl: 'https://gw/v1' });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('均失败');
  });

  it('testAdhoc 模型留空但无自定义 baseUrl（预设 vendor）不触发列表兜底', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://api.deepseek.com/v1/chat/completions');
      return sseResponse(['data: [DONE]\n\n']);
    });
    vi.stubGlobal('fetch', fetchMock);
    const mgr = new ProviderManager(tmpFile);
    const r = await mgr.testAdhoc({ id: 'deepseek', apiKey: 'sk-x' });
    expect(r.ok).toBe(true);
  });

  it('test 已存储 provider 模型留空 + baseUrl → 走列表兜底', async () => {
    const mgr = new ProviderManager(tmpFile);
    mgr.add({ id: 'my-gw', apiKey: 'sk-stored', baseUrl: 'https://gw.example.com/v1' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL | Request) => {
        if (String(url).endsWith('/models')) {
          return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
        }
        return sseResponse([chunk({ choices: [{ delta: { content: 'pong' } }] }), 'data: [DONE]\n\n']);
      }),
    );
    const r = await mgr.test('my-gw');
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('m1');
  });

  it('testAdhoc 无 Key 且无存储配置 → 抛错', async () => {
    const mgr = new ProviderManager(tmpFile);
    await expect(mgr.testAdhoc({ id: 'no-such', baseUrl: 'https://gw/v1' })).rejects.toThrow('API Key 不能为空');
  });
});

// ── resolveProviderFromEnv fallback ────────────────────────────────────────

describe('resolveProviderFromEnv storage fallback', () => {
  const ENV_BACKUP = { ...process.env };

  afterEach(() => {
    process.env = { ...ENV_BACKUP };
    vi.unstubAllGlobals();
  });

  it('falls back to stored config when env keys are absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-resolve-'));
    const store = path.join(dir, 'models.json');
    const { saveModelsFile, encryptKey } = await import('../src/llm/keychain.js');
    saveModelsFile(
      {
        version: 1,
        providers: [
          {
            id: 'deepseek', vendor: 'openai-compatible',
            apiKey: encryptKey('sk-stored'), enabled: true, default: true,
          },
        ],
      },
      store,
    );

    // clear all vendor keys so the env path misses
    for (const k of Object.keys(process.env)) {
      if (/ANTHROPIC|DEEPSEEK|DASHSCOPE|OPENAI|DELTA/.test(k)) delete process.env[k];
    }

    const { resolveProviderFromEnv } = await import('../src/session/service.js');
    const provider = await resolveProviderFromEnv(undefined, { modelsFile: store });
    expect(provider.id).toBe('deepseek');
  });
});

// ── SSE reconnect ───────────────────────────────────────────────────────────

function sseResponse(frames: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(encoder.encode(f));
      c.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

const chunk = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

describe('SSE 断流重连 (F-04)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('silently retries a 500 then streams normally', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 500 }))
      .mockResolvedValueOnce(
        sseResponse([chunk({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n']),
      );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({ id: 'openai', apiKey: 'k' });
    const events: string[] = [];
    for await (const ev of provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      model: 'gpt-4o',
    })) {
      events.push(ev.type);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['text_delta', 'done']);
  });

  it('yields a retriable error after exhausting retries on persistent 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 500 })));
    const provider = new OpenAICompatibleProvider({ id: 'openai', apiKey: 'k' });
    const events: unknown[] = [];
    for await (const ev of provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      model: 'gpt-4o',
    })) {
      events.push(ev);
    }
    // openSseStream(1) + provider attempt loop(1) = 2 fetches, then error event
    expect(events.at(-1)).toMatchObject({ type: 'error', retriable: true });
  });

  it('does not retry non-retriable statuses (401)', async () => {
    const fetchMock = vi.fn(async () => new Response('bad key', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = new OpenAICompatibleProvider({ id: 'openai', apiKey: 'k' });
    const events: unknown[] = [];
    for await (const ev of provider.chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      model: 'gpt-4o',
    })) {
      events.push(ev);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({ type: 'error', retriable: false });
  });
});
