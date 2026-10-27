/**
 * apiFetch 鉴权头注入（桌面宿主 /api/* 强制校验 x-delta-auth，裸 fetch 必 401）：
 *  - token 为空（CLI serve / 浏览器形态）→ 不附加任何凭据，headers 原样透传
 *  - 桌面形态（?auth= 已注入 token）→ 附带 x-delta-auth，且保留调用方原有 headers
 * 注意本文件内用例顺序敏感：auth.ts 的模块级 token 一旦注入无法清空，
 * 「无 token」用例必须先于「有 token」用例执行。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './client';
import { initAuthToken } from './auth';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiFetch', () => {
  it('token 为空时不附加 x-delta-auth（CLI serve / 浏览器形态）', async () => {
    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/providers');

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toEqual({});
  });

  it('桌面形态（?auth= 注入 token）时附带 x-delta-auth 并保留原 headers', async () => {
    vi.stubGlobal('location', new URL('http://127.0.0.1:7900/?auth=tok-123'));
    vi.stubGlobal('history', { replaceState: () => {} });
    initAuthToken();

    const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await apiFetch('/api/providers', { headers: { 'content-type': 'application/json' } });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      'x-delta-auth': 'tok-123',
    });
  });
});
