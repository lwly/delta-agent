/** Skills / MCP 配置端点测试（server-config-store + HTTP 路由） */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionHub, createWebServer } from '../src/server/index.js';
import { serializeSkillMd } from '../src/server/config-store.js';
import type { SessionHubDeps } from '../src/server/hub.js';

let tmp = '';
let projectDir = '';
let service: SessionService;
let projectId: string;
let server: ReturnType<typeof createWebServer>;
let base = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-cfg-'));
  projectDir = path.join(tmp, 'proj');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(path.join(projectDir, 'README.md'), '# demo');
  service = new SessionService(path.join(tmp, 'db.sqlite'));
  projectId = service.ensureProject(projectDir).id;
  const deps: SessionHubDeps = {
    service,
    registry: new ToolRegistry(),
    resolveProvider: async () => {
      throw new Error('not used');
    },
  };
  const hub = new SessionHub(deps);
  // skillsHomeDir + configHomeDir 均指向 tmp：用户级 skills 与全局 mcp.json 全部隔离
  server = createWebServer({ service, hub, port: 0, skillsHomeDir: tmp, configHomeDir: tmp });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(tmp, { recursive: true, force: true });
});

const api = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
};

const userSkillDir = (name: string) => path.join(tmp, '.y-zero', 'skills', name);
const projectSkillDir = (name: string) => path.join(projectDir, '.y-zero', 'skills', name);

async function mkSkill(dir: string, description = '测试技能', body = '执行测试步骤'): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    serializeSkillMd({ description, triggers: ['测试'], toolsAllowlist: ['read_file'], body }),
    'utf8',
  );
}

describe('GET /api/skills/detail', () => {
  it('返回分层原始发现 + 合并视图与覆盖标识', async () => {
    await mkSkill(userSkillDir('deploy'));
    await mkSkill(projectSkillDir('deploy'), '项目层覆盖版');
    const r = await api('GET', `/api/skills/detail?projectId=${projectId}`);
    expect(r.status).toBe(200);
    const skills = r.json.skills as Array<Record<string, unknown>>;
    const deploy = skills.find((s) => s.name === 'deploy');
    expect(deploy).toBeTruthy();
    expect(deploy!.layer).toBe('project');
    expect(deploy!.shadowing).toBe('user');
    expect(deploy!.description).toBe('项目层覆盖版');
    const availability = r.json.availability as Record<string, string[]>;
    expect(availability.deploy).toEqual(['user', 'project']);
    const layers = r.json.layers as Record<string, unknown[]>;
    expect(layers.user).toHaveLength(1);
    expect(layers.project).toHaveLength(1);
  });

  it('项目不存在返回 404', async () => {
    const r = await api('GET', '/api/skills/detail?projectId=nope');
    expect(r.status).toBe(404);
  });
});

describe('POST /api/skills/:name', () => {
  it('写入用户级 SKILL.md 并可被 detail 读回', async () => {
    const r = await api('POST', '/api/skills/review-helper', {
      scope: 'user',
      description: '代码审查流程',
      triggers: ['review', '审查'],
      toolsAllowlist: ['read_file', 'grep'],
      body: '按清单逐步审查……',
    });
    expect(r.status).toBe(200);
    const raw = await fs.readFile(path.join(userSkillDir('review-helper'), 'SKILL.md'), 'utf8');
    expect(raw).toContain('description: 代码审查流程');
    expect(raw).toContain('  - review');
    expect(raw).toContain('按清单逐步审查');

    const detail = await api('GET', `/api/skills/detail?projectId=${projectId}`);
    const names = (detail.json.skills as Array<{ name: string }>).map((s) => s.name);
    expect(names).toContain('review-helper');
  });

  it('覆盖已有同名用户级 Skill', async () => {
    await mkSkill(userSkillDir('deploy'));
    const r = await api('POST', '/api/skills/deploy', {
      scope: 'user',
      description: '新版',
      triggers: [],
      toolsAllowlist: [],
      body: 'v2',
    });
    expect(r.status).toBe(200);
    const detail = await api('GET', `/api/skills/detail?projectId=${projectId}`);
    const deploy = (detail.json.skills as Array<Record<string, unknown>>).find((s) => s.name === 'deploy');
    expect(deploy!.description).toBe('新版');
  });

  it('项目级写入落在项目 .y-zero/skills 下', async () => {
    const r = await api('POST', '/api/skills/proj-only', {
      scope: 'project',
      projectId,
      description: '仅本项目',
      triggers: [],
      toolsAllowlist: [],
      body: 'x',
    });
    expect(r.status).toBe(200);
    await expect(fs.access(path.join(projectSkillDir('proj-only'), 'SKILL.md'))).resolves.toBeUndefined();
  });

  it('非法名称与路径逃逸被拒绝', async () => {
    expect((await api('POST', '/api/skills/bad%20name', { scope: 'user', body: 'x' })).status).toBe(400);
    expect((await api('POST', '/api/skills/..%2Fescape', { scope: 'user', body: 'x' })).status).toBe(400);
    expect((await api('POST', '/api/skills/x', { scope: 'user', body: 'x' })).status).toBe(400);
    expect((await api('POST', '/api/skills/ok-name', { scope: 'project', body: 'x' })).status).toBe(404);
  });
});

describe('DELETE /api/skills/:name', () => {
  it('删除用户级 Skill；再次删除报错', async () => {
    await mkSkill(userSkillDir('temp'));
    expect((await api('DELETE', '/api/skills/temp?scope=user')).status).toBe(200);
    await expect(fs.access(userSkillDir('temp'))).rejects.toThrow();
    expect((await api('DELETE', '/api/skills/temp?scope=user')).status).toBe(400);
  });

  it('scope 非法返回 400', async () => {
    expect((await api('DELETE', '/api/skills/any?scope=builtin')).status).toBe(400);
    expect((await api('DELETE', '/api/skills/any')).status).toBe(400);
  });
});

describe('GET/PUT /api/mcp', () => {
  it('初始状态：全局不存在、项目未启用', async () => {
    const r = await api('GET', '/api/mcp');
    expect(r.status).toBe(200);
    expect(r.json.projectEnabled).toBe(false);
    expect((r.json.global as Record<string, unknown>).exists).toBe(false);
  });

  it('写入全局配置并可读回合并视图', async () => {
    const put = await api('PUT', '/api/mcp', {
      scope: 'global',
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@mcp/fs'], env: { FOO: '1' }, timeoutMs: 30_000 },
      },
    });
    expect(put.status).toBe(200);
    const raw = JSON.parse(await fs.readFile(path.join(tmp, '.y-zero', 'mcp.json'), 'utf8'));
    expect(raw.mcpServers.filesystem.command).toBe('npx');

    const get = await api('GET', '/api/mcp');
    const merged = get.json.merged as Record<string, Record<string, unknown>>;
    expect(merged.filesystem.__source).toBe('global');
    expect(merged.filesystem.timeoutMs).toBe(30_000);
  });

  it('项目级同名覆盖全局', async () => {
    await api('PUT', '/api/mcp', { scope: 'global', mcpServers: { fs: { command: 'global-cmd' } } });
    const put = await api('PUT', '/api/mcp', { scope: 'project', projectId, mcpServers: { fs: { command: 'project-cmd' } } });
    expect(put.status).toBe(200);
    const get = await api('GET', `/api/mcp?projectId=${projectId}`);
    const merged = get.json.merged as Record<string, Record<string, unknown>>;
    expect(merged.fs.command).toBe('project-cmd');
    expect(merged.fs.__source).toBe('project');
    expect(get.json.projectEnabled).toBe(true);
  });

  it('校验失败返回 400：缺 command / 名称非法 / args 非数组', async () => {
    expect(
      (await api('PUT', '/api/mcp', { scope: 'global', mcpServers: { bad: { args: ['x'] } } })).status,
    ).toBe(400);
    expect(
      (await api('PUT', '/api/mcp', { scope: 'global', mcpServers: { 'bad name': { command: 'c' } } })).status,
    ).toBe(400);
    expect(
      (await api('PUT', '/api/mcp', { scope: 'global', mcpServers: { ok: { command: 'c', args: 'x' } } })).status,
    ).toBe(400);
  });

  it('scope=project 无项目返回 404；scope 非法返回 400', async () => {
    expect((await api('PUT', '/api/mcp', { scope: 'project', mcpServers: {} })).status).toBe(404);
    expect((await api('PUT', '/api/mcp', { scope: 'other', mcpServers: {} })).status).toBe(400);
  });

  it('解析失败的 mcp.json 进 parseError 不炸端点', async () => {
    await fs.mkdir(path.join(tmp, '.y-zero'), { recursive: true });
    await fs.writeFile(path.join(tmp, '.y-zero', 'mcp.json'), '{not json', 'utf8');
    const r = await api('GET', '/api/mcp');
    expect(r.status).toBe(200);
    expect((r.json.global as Record<string, unknown>).parseError).toBeTruthy();
  });
});
