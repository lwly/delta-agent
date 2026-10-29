/**
 * F-39 T09：专家库 HTTP 端点
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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-expert-web-'));
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-expert-home-'));
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

const json = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    name: 'alpha',
    version: '1.0.0',
    description: 'alpha desc',
    author: { name: 'tester' },
    expertType: 'agent',
    agentName: 'alpha-agent',
    agents: ['agents/alpha-agent.md'],
    displayName: { en: 'Alpha', zh: '阿尔法' },
    profession: { en: 'Eng', zh: '架构' },
    tools: ['read_file', 'list_dir', 'ghost_tool'],
    ...over,
  });

async function writeAgentExpert(name = 'alpha'): Promise<void> {
  const dir = path.join(home, '.delta', 'experts', name);
  await fs.mkdir(path.join(dir, 'agents'), { recursive: true });
  await fs.writeFile(path.join(dir, 'expert.json'), json({ name }));
  await fs.writeFile(
    path.join(dir, 'agents', `${name}-agent.md`),
    `---\nname: ${name}-agent\ndescription: x\ndisplayName_zh: ${name}\nprofession_zh: 架构\n---\n\n${name} 的专家正文。`,
  );
}

async function writeTeamExpert(): Promise<void> {
  const dir = path.join(home, '.delta', 'experts', 'alpha-team');
  await fs.mkdir(path.join(dir, 'agents'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'expert.json'),
    JSON.stringify({
      name: 'alpha-team',
      version: '1.0.0',
      description: 'team',
      author: { name: 't' },
      expertType: 'team',
      agentName: 'alpha-team-lead',
      agents: ['agents/alpha-team-lead.md', 'agents/alpha-team-dev.md'],
      displayName: { en: 'Team', zh: '阿尔法团队' },
      profession: { en: 'T', zh: '团队' },
      members: [
        { id: 'alpha-team-lead', name: { en: 'Lead', zh: '主理人' }, profession: { en: 'L', zh: '主理人' }, role: 'lead' },
        { id: 'alpha-team-dev', name: { en: 'Dev', zh: '开发' }, profession: { en: 'D', zh: '开发' }, role: 'member' },
      ],
      teamInfo: { leadAgent: 'alpha-team-lead', memberAgents: ['alpha-team-lead', 'alpha-team-dev'] },
    }),
  );
  await fs.writeFile(path.join(dir, 'agents', 'alpha-team-lead.md'), '---\nname: alpha-team-lead\ndescription: x\ndisplayName_zh: 主理人\nprofession_zh: 主理人\n---\n\n主理人正文');
  await fs.writeFile(path.join(dir, 'agents', 'alpha-team-dev.md'), '---\nname: alpha-team-dev\ndescription: x\ndisplayName_zh: 开发\nprofession_zh: 开发\n---\n\n开发正文');
}

const get = async (p: string) => (await fetch(`${base}${p}`)).json();
const getStatus = async (p: string) => (await fetch(`${base}${p}`)).status;

describe('GET /api/experts', () => {
  it('列表 DTO：snake_case + member_count + has_avatar', async () => {
    await writeAgentExpert();
    const r = await get(`/api/experts?projectId=${projectId}`);
    expect(r.errors).toEqual([]);
    const alpha = r.experts.find((e: { name: string }) => e.name === 'alpha');
    expect(alpha).toMatchObject({
      name: 'alpha',
      expertType: 'agent',
      memberCount: 0,
      hasAvatar: false,
      layer: 'user',
      missingMcp: [],
    });
  });

  it('项目不存在 → 404', async () => {
    expect(await getStatus('/api/experts?projectId=nope')).toBe(404);
  });
});

describe('GET /api/experts/:name', () => {
  it('详情含 tools / tool_stats / prompt_preview', async () => {
    await writeAgentExpert();
    const r = await get('/api/experts/alpha');
    expect(r.expertType).toBe('agent');
    expect(r.tools).toEqual(['read_file', 'list_dir', 'ghost_tool']);
    expect(r.tool_stats).toMatchObject({ restricted: 2, total: 17, unrestricted: false });
    expect(r.prompt_preview).toContain('专家正文');
    expect(JSON.stringify(r)).not.toContain('/.delta/experts');
  });

  it('未知 name → 404', async () => {
    expect(await getStatus('/api/experts/ghost')).toBe(404);
  });
});

describe('GET /api/experts/:name/avatar', () => {
  it('无头像 → data_url:null；有头像 → data URL', async () => {
    await writeAgentExpert();
    expect((await get('/api/experts/alpha/avatar')).data_url).toBeNull();

    const dir = path.join(home, '.delta', 'experts', 'alpha');
    await fs.mkdir(path.join(dir, 'avatars'), { recursive: true });
    // 1x1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await fs.writeFile(path.join(dir, 'avatars', 'expert.png'), png);
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'expert.json'), 'utf-8'));
    pkg.avatar = 'avatars/expert.png';
    await fs.writeFile(path.join(dir, 'expert.json'), JSON.stringify(pkg));

    const r2 = await get('/api/experts/alpha/avatar');
    expect(r2.data_url).toMatch(/^data:image\/png;base64,/);
  });
});

describe('GET /api/sessions/:id/expert', () => {
  it('未绑定 → bound:null；绑定 → bound + mode_forced；包删除 → missing', async () => {
    await writeAgentExpert();
    await writeTeamExpert();
    const emptySession = await (
      await fetch(`${base}/api/projects/${projectId}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
    ).json();
    const empty = await get(`/api/sessions/${emptySession.id}/expert`);
    expect(empty).toEqual({ bound: null, missing: false, mode_forced: false });

    const created = await (
      await fetch(`${base}/api/projects/${projectId}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expert: 'alpha-team', mode: 'multi-agent' }),
      })
    ).json();
    expect(created.mode).toBe('react'); // 团队强制 react（D5）
    expect(created.expert).toBe('alpha-team');
    expect(created.expert_type).toBe('team');

    const bound = await get(`/api/sessions/${created.id}/expert`);
    expect(bound.missing).toBe(false);
    expect(bound.mode_forced).toBe(true);
    expect(bound.bound.displayName.zh).toBe('阿尔法团队');

    await fs.rm(path.join(home, '.delta', 'experts', 'alpha-team'), { recursive: true, force: true });
    const missing = await get(`/api/sessions/${created.id}/expert`);
    expect(missing.missing).toBe(true);
    expect(missing.bound.name).toBe('alpha-team');
  });
});

describe('POST /api/projects/:id/sessions（expert）', () => {
  it('未知 expert → 400 且不建会话', async () => {
    const before = (await get(`/api/projects/${projectId}/sessions`)).length ?? 0;
    const res = await fetch(`${base}/api/projects/${projectId}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expert: 'ghost' }),
    });
    expect(res.status).toBe(400);
    const after = (await get(`/api/projects/${projectId}/sessions`)).length ?? 0;
    expect(after).toBe(before);
  });

  it('单人专家 → expert_type=agent，mode 保留', async () => {
    await writeAgentExpert();
    const r = await (
      await fetch(`${base}/api/projects/${projectId}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expert: 'alpha', mode: 'react' }),
      })
    ).json();
    expect(r.expert).toBe('alpha');
    expect(r.expert_type).toBe('agent');
    expect(r.mode).toBe('react');
  });
});
