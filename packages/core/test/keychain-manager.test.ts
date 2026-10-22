import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  encryptKey,
  decryptKey,
  maskKey,
} from '../src/llm/keychain.js';
import { ProviderManager } from '../src/llm/manager.js';
import { OpenAICompatibleProvider } from '../src/llm/providers/openai-compatible.js';

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
      if (/ANTHROPIC|DEEPSEEK|DASHSCOPE|OPENAI|YZERO/.test(k)) delete process.env[k];
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
