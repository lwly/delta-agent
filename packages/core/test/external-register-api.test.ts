/**
 * F-56 外部 Agent 手动注册 HTTP 端点契约测试（PASI-87）：
 *  - GET /api/external-agents/templates —— 向导第 1 步模板网格（6 CLI）
 *  - POST /api/external-agents —— 手动注册（upsert；400 校验错误）
 *  - DELETE /api/external-agents/:id —— 移除手动条目（404 非 manual）
 * 注册/移除入口注入隔离（externalRegister/externalRemove），不触碰真实 ~/.delta。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent } from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionHub, createWebServer } from '../src/server/index.js';
import type { SessionHubDeps } from '../src/server/hub.js';
import { ManualRegisterError, type ExternalAgentCacheEntry } from '../src/external/detect.js';

class MockProvider implements LLMProvider {
  readonly id = 'mock';
  async *chat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'text_delta', text: 'ok' };
    yield { type: 'usage', input: 1, output: 1 };
    yield { type: 'done' };
  }
  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
}

let tmp = '';
let server: ReturnType<typeof createWebServer>;
let base = '';

interface RegisterCall {
  templateId: string;
  command?: string;
  displayName?: string;
  description?: string;
}

/** 启动服务并注入注册/移除入口（探测缺省 ensureExternalAdapters——本文件用例不触发它） */
async function startServer(hooks: { register?: typeof registerMock; remove?: (id: string) => boolean } = {}): Promise<void> {
  const service = new SessionService(path.join(tmp, 'db.sqlite'));
  const deps: SessionHubDeps = {
    service,
    registry: new ToolRegistry(),
    resolveProvider: async () => new MockProvider(),
  };
  const hub = new SessionHub(deps);
  server = createWebServer({
    service,
    hub,
    port: 0,
    externalRegister: hooks.register ?? registerMock,
    externalRemove: hooks.remove ?? ((id) => id === 'cli:codebuddy'),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

const registerMock = (input: RegisterCall): ExternalAgentCacheEntry => {
  if (input.templateId === 'cli:nope') throw new ManualRegisterError('unknown_template', `未知模板 id：${input.templateId}`);
  return {
    id: input.templateId,
    kind: 'acp',
    command: input.command ?? 'codebuddy',
    version: '',
    tier: 'A',
    enabled: true,
    lastProbeAt: '',
    manual: true,
    displayName: input.displayName ?? 'CodeBuddy Code',
    description: input.description,
  };
};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-external-register-'));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmp, { recursive: true, force: true });
});

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

describe('GET /api/external-agents/templates（向导第 1 步）', () => {
  it('返回 6 个模板，字段齐全（id/label/description/executable/kind/tier）', async () => {
    await startServer();
    const { status, json } = await api('GET', '/api/external-agents/templates');
    expect(status).toBe(200);
    const templates = json.templates as Array<Record<string, unknown>>;
    expect(templates).toHaveLength(6);
    const ids = templates.map((t) => t.id);
    expect(ids).toContain('cli:claude-code');
    expect(ids).toContain('cli:codex');
    expect(ids).toContain('cli:codebuddy');
    expect(ids).toContain('cli:cursor-agent');
    expect(ids).toContain('cli:opencode');
    expect(ids).toContain('cli:dsh');
    for (const t of templates) {
      expect(typeof t.label).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(typeof t.executable).toBe('string');
    }
    // F-56 下拉选择：模板透出候选模型清单
    const cb = templates.find((t) => t.id === 'cli:codebuddy')! as Record<string, unknown>;
    expect(Array.isArray(cb.models)).toBe(true);
    expect(cb.models as string[]).toContain('glm-5.3');
  });
});

describe('POST /api/external-agents（手动注册）', () => {
  it('合法载荷 → 200 + entry 回显，注册入口收到规范化字段（AC-56-1）', async () => {
    const calls: RegisterCall[] = [];
    await startServer({
      register: (input) => {
        calls.push(input);
        return registerMock(input);
      },
    });
    const { status, json } = await api('POST', '/api/external-agents', {
      templateId: 'cli:codebuddy',
      command: '/opt/cb/codebuddy',
      displayName: 'CB',
      description: '自建 codebuddy',
    });
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    const entry = json.entry as Record<string, unknown>;
    expect(entry.manual).toBe(true);
    expect(entry.displayName).toBe('CB');
    expect(calls).toEqual([
      { templateId: 'cli:codebuddy', command: '/opt/cb/codebuddy', displayName: 'CB', description: '自建 codebuddy' },
    ]);
  });

  it('未知模板 → 400 unknown_template', async () => {
    await startServer();
    const { status, json } = await api('POST', '/api/external-agents', { templateId: 'cli:nope' });
    expect(status).toBe(400);
    expect(String(json.error)).toContain('unknown_template');
  });
});

describe('DELETE /api/external-agents/:id（移除手动条目）', () => {
  it('manual 条目 → 200 ok；非 manual → 404', async () => {
    await startServer();
    expect((await api('DELETE', '/api/external-agents/cli:codebuddy')).status).toBe(200);
    expect((await api('DELETE', '/api/external-agents/cli:claude-code')).status).toBe(404);
  });
});
