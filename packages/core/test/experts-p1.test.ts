/**
 * F-39 P1：信任 / 停用 / 删除 / 导入 / 创建 / 空会话就地改绑（HTTP 端点）
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent } from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionHub, createWebServer } from '../src/server/index.js';

class NoopProvider implements LLMProvider {
  readonly id = 'noop';
  async *chat(_req: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done' };
  }
  estimateTokens(messages: ChatMessage[]): number {
    return messages.length;
  }
}

let tmp = '';
let home = '';
let server: ReturnType<typeof createWebServer>;
let base = '';
let projectId = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-expert-p1-'));
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-expert-p1-home-'));
  const service = new SessionService(path.join(tmp, 'db.sqlite'));
  projectId = service.ensureProject(tmp).id;
  const hub = new SessionHub({
    service,
    registry: new ToolRegistry(),
    resolveProvider: async () => new NoopProvider(),
  });
  server = createWebServer({ service, hub, port: 0, skillsHomeDir: home });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  server.close();
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

async function writeUserExpert(name = 'p1-expert', version = '1.0.0'): Promise<string> {
  const dir = path.join(home, '.delta', 'experts', name);
  await fs.mkdir(path.join(dir, 'agents'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'expert.json'),
    JSON.stringify({
      name, version, description: 'd', author: { name: 't' }, expertType: 'agent',
      agentName: `${name}-agent`, agents: [`agents/${name}-agent.md`],
      displayName: { en: name, zh: name }, profession: { en: 'P', zh: '职业' },
      tools: ['read_file', 'write_file'],
    }),
  );
  await fs.writeFile(
    path.join(dir, 'agents', `${name}-agent.md`),
    `---\nname: ${name}-agent\ndescription: x\ndisplayName_zh: ${name}\nprofession_zh: 职业\n---\n\n正文`,
  );
  return dir;
}

const get = async (p: string) => (await fetch(`${base}${p}`)).json();
const send = async (method: string, p: string, body?: unknown) =>
  await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe('信任端点（T16）', () => {
  it('list trusted=false → hash 不符 400 → 正确 hash 200 → trusted=true；版本变化后回 false', async () => {
    await writeUserExpert();
    let list = await get(`/api/experts?projectId=${projectId}`);
    const item = list.experts.find((e: { name: string }) => e.name === 'p1-expert');
    expect(item.trusted).toBe(false);

    const detail = await get('/api/experts/p1-expert');
    const bad = await send('POST', '/api/experts/p1-expert/trust', { tools_hash: 'wrong' });
    expect(bad.status).toBe(400);

    const ok = await send('POST', '/api/experts/p1-expert/trust', { tools_hash: detail.tools_hash });
    expect((await ok.json()).ok).toBe(true);

    list = await get(`/api/experts?projectId=${projectId}`);
    expect(list.experts.find((e: { name: string }) => e.name === 'p1-expert').trusted).toBe(true);

    await writeUserExpert('p1-expert', '2.0.0');
    list = await get(`/api/experts?projectId=${projectId}`);
    expect(list.experts.find((e: { name: string }) => e.name === 'p1-expert').trusted).toBe(false);
  });

  it('builtin → 400 无需信任；DELETE 撤销', async () => {
    expect((await send('POST', '/api/experts/code-architect/trust', { tools_hash: 'x' })).status).toBe(400);
    await writeUserExpert();
    const detail = await get('/api/experts/p1-expert');
    await send('POST', '/api/experts/p1-expert/trust', { tools_hash: detail.tools_hash });
    expect((await send('DELETE', '/api/experts/p1-expert/trust')).status).toBe(200);
    const list = await get(`/api/experts?projectId=${projectId}`);
    expect(list.experts.find((e: { name: string }) => e.name === 'p1-expert').trusted).toBe(false);
  });
});

describe('停用 / 删除 / 创建（T15）', () => {
  it('停用 → list disabled 含该包；删除 → 404；内置不可删/不可停用', async () => {
    await writeUserExpert();
    expect((await send('PATCH', '/api/experts/p1-expert/disabled', { disabled: true })).status).toBe(200);
    let list = await get(`/api/experts?projectId=${projectId}`);
    expect(list.disabled).toContain('p1-expert');

    expect((await send('PATCH', '/api/experts/code-architect/disabled', { disabled: true })).status).toBe(400);
    expect((await send('DELETE', '/api/experts/code-architect')).status).toBe(400);

    expect((await send('DELETE', '/api/experts/p1-expert')).status).toBe(200);
    expect((await send('GET', '/api/experts/p1-expert')).status).toBe(404);
  });

  it('创建骨架 → 立即可见于列表', async () => {
    const r = await send('POST', '/api/experts/create', {
      name: 'created-expert',
      displayName: '新建专家',
      profession: '测试',
      expertType: 'agent',
      layer: 'user',
    });
    expect((await r.json()).ok).toBe(true);
    const list = await get(`/api/experts?projectId=${projectId}`);
    expect(list.experts.map((e: { name: string }) => e.name)).toContain('created-expert');
  });
});

describe('空会话就地改绑（PATCH /api/sessions/:id/expert）', () => {
  it('空会话改绑/解绑；有消息 → 409；未知 expert → 400', async () => {
    await writeUserExpert();
    const emptySession = await (
      await send('POST', `/api/projects/${projectId}/sessions`, {})
    ).json();

    const bind = await send('PATCH', `/api/sessions/${emptySession.id}/expert`, { expert: 'p1-expert' });
    const bound = await bind.json();
    expect(bound.expert).toBe('p1-expert');
    expect(bound.expertType).toBe('agent');

    const unbind = await send('PATCH', `/api/sessions/${emptySession.id}/expert`, { expert: null });
    expect((await unbind.json()).expert).toBeNull();

    expect((await send('PATCH', `/api/sessions/${emptySession.id}/expert`, { expert: 'ghost' })).status).toBe(400);

    // 有消息 → 409
    await send('POST', `/api/sessions/${emptySession.id}/messages`, { input: 'hello' });
    expect((await send('PATCH', `/api/sessions/${emptySession.id}/expert`, { expert: 'p1-expert' })).status).toBe(409);
  });
});
