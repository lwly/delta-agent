/** Skill Hub 端点测试（目录合并 / installedIn / 安装 / URL 导入 / 远程源管理） */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as http from 'node:http';
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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-hub-'));
  projectDir = path.join(tmp, 'proj');
  await fs.mkdir(projectDir, { recursive: true });
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
  // configHomeDir 指向 tmp：skill-hub.json 与用户级 skills 均隔离在临时目录
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

/** 本地 mock HTTP 服务（registry / SKILL.md 原文） */
async function startMock(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{
  server: http.Server;
  url: (p: string) => string;
  close: () => Promise<void>;
}> {
  const mock = http.createServer(handler);
  await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const addr = mock.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    server: mock,
    url: (p: string) => `http://127.0.0.1:${port}${p}`,
    close: () => new Promise((resolve) => mock.close(() => resolve())),
  };
}

const userSkillDir = (name: string) => path.join(tmp, '.y-zero', 'skills', name);
const projectSkillDir = (name: string) => path.join(projectDir, '.y-zero', 'skills', name);
const sourcesFile = () => path.join(tmp, '.y-zero', 'skill-hub.json');

interface HubItemView {
  name: string;
  source: string;
  category: string;
  installedIn: Record<string, boolean>;
}

describe('GET /api/skill-hub', () => {
  it('返回内置 10 条 seed 条目（source=builtin，未安装时 installedIn 为空）', async () => {
    const r = await api('GET', '/api/skill-hub');
    expect(r.status).toBe(200);
    const items = r.json.items as HubItemView[];
    expect(items).toHaveLength(10);
    expect(items.every((i) => i.source === 'builtin')).toBe(true);
    const names = items.map((i) => i.name);
    expect(names).toContain('code-review');
    expect(names).toContain('git-flow');
    const review = items.find((i) => i.name === 'code-review')!;
    expect(review.category).toBe('代码质量');
    expect(review.installedIn).toEqual({});
    expect((r.json.errors as string[])).toEqual([]);
  });

  it('安装后 installedIn 更新（user/project 正确标注）', async () => {
    await api('POST', '/api/skill-hub/install', { source: 'builtin', name: 'code-review', scope: 'user' });
    await api('POST', '/api/skill-hub/install', { source: 'builtin', name: 'code-review', scope: 'project', projectId });
    const r = await api('GET', `/api/skill-hub?projectId=${projectId}`);
    const review = (r.json.items as HubItemView[]).find((i) => i.name === 'code-review')!;
    expect(review.installedIn).toEqual({ user: true, project: true });
  });

  it('projectId 不存在返回 404', async () => {
    expect((await api('GET', '/api/skill-hub?projectId=nope')).status).toBe(404);
  });

  it('远程源：实时拉取合并 + 同名条目去重提示 + 源状态', async () => {
    const mock = await startMock((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          skills: [
            {
              name: 'remote-helper',
              description: '来自远程源的技能',
              triggers: ['远程'],
              toolsAllowlist: ['read_file'],
              body: '远程技能正文',
            },
            {
              name: 'code-review', // 与内置同名 → 丢弃并提示
              description: '重复条目',
              body: 'x',
            },
            {
              name: 'Invalid Name!', // 名称不过校验 → 跳过并提示
              description: 'x',
              body: 'x',
            },
          ],
        }),
      );
    });
    try {
      await fs.mkdir(path.join(tmp, '.y-zero'), { recursive: true });
      await fs.writeFile(
        sourcesFile(),
        JSON.stringify({ sources: [{ name: '测试源', url: mock.url('/registry.json') }] }),
        'utf8',
      );
      const r = await api('GET', '/api/skill-hub');
      expect(r.status).toBe(200);
      const items = r.json.items as HubItemView[];
      const remote = items.find((i) => i.name === 'remote-helper');
      expect(remote).toBeTruthy();
      expect(remote!.source).toBe('测试源');
      expect(remote!.category).toBe('远程'); // 缺 category 补默认
      expect(remote!.version).toBe('0.0.0'); // 缺 version 补默认
      const errors = r.json.errors as string[];
      expect(errors.some((e) => e.includes('code-review'))).toBe(true);
      expect(errors.some((e) => e.includes('Invalid Name!'))).toBe(true);
      const sources = r.json.sources as Array<{ name: string; status: string; count: number }>;
      expect(sources).toHaveLength(1);
      expect(sources[0]!.name).toBe('测试源');
      expect(sources[0]!.status).toBe('ok');
      expect(sources[0]!.count).toBe(2);
      // 去重后：10 内置 + 1 远程
      expect(items).toHaveLength(11);
    } finally {
      await mock.close();
    }
  });

  it('单个远程源失败不阻塞其他源（status=error 记入 sources）', async () => {
    const okMock = await startMock((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ skills: [{ name: 'ok-skill', description: 'd', body: 'b' }] }));
    });
    const badMock = await startMock((req, res) => {
      res.writeHead(500);
      res.end('boom');
    });
    try {
      await fs.mkdir(path.join(tmp, '.y-zero'), { recursive: true });
      await fs.writeFile(
        sourcesFile(),
        JSON.stringify({
          sources: [
            { name: '坏源', url: badMock.url('/registry.json') },
            { name: '好源', url: okMock.url('/registry.json') },
          ],
        }),
        'utf8',
      );
      const r = await api('GET', '/api/skill-hub');
      const sources = r.json.sources as Array<{ name: string; status: string; error?: string }>;
      const bad = sources.find((s) => s.name === '坏源')!;
      expect(bad.status).toBe('error');
      expect(bad.error).toContain('500');
      expect(sources.find((s) => s.name === '好源')!.status).toBe('ok');
      expect((r.json.items as HubItemView[]).some((i) => i.name === 'ok-skill')).toBe(true);
    } finally {
      await Promise.all([okMock.close(), badMock.close()]);
    }
  });
});

describe('GET /api/skill-hub/item', () => {
  it('内置条目返回完整 body', async () => {
    const r = await api('GET', '/api/skill-hub/item?source=builtin&name=commit-message');
    expect(r.status).toBe(200);
    expect((r.json as { body: string }).body).toContain('Conventional Commits');
  });

  it('条目不存在返回 404', async () => {
    expect((await api('GET', '/api/skill-hub/item?source=builtin&name=nope')).status).toBe(404);
    expect((await api('GET', '/api/skill-hub/item?source=不存在源&name=x')).status).toBe(404);
  });
});

describe('POST /api/skill-hub/install', () => {
  it('安装到用户级：落盘 SKILL.md 且 GET /api/skills/detail 可见', async () => {
    const r = await api('POST', '/api/skill-hub/install', { source: 'builtin', name: 'test-writer', scope: 'user' });
    expect(r.status).toBe(200);
    expect((r.json as { ok: boolean }).ok).toBe(true);
    const raw = await fs.readFile(path.join(userSkillDir('test-writer'), 'SKILL.md'), 'utf8');
    expect(raw).toContain('description: 为指定模块编写单元测试');
    expect(raw).toContain('tools_allowlist');
    const detail = await api('GET', `/api/skills/detail?projectId=${projectId}`);
    expect((detail.json.skills as Array<{ name: string }>).map((s) => s.name)).toContain('test-writer');
  });

  it('安装到项目级：落在项目 .y-zero/skills 下', async () => {
    const r = await api('POST', '/api/skill-hub/install', {
      source: 'builtin', name: 'perf-tips', scope: 'project', projectId,
    });
    expect(r.status).toBe(200);
    await expect(fs.access(projectSkillDir('perf-tips'), undefined)).resolves.toBeUndefined();
  });

  it('覆盖重装幂等（重复安装同名技能两次均成功且内容一致）', async () => {
    const p1 = await api('POST', '/api/skill-hub/install', { source: 'builtin', name: 'docs-writer', scope: 'user' });
    const first = await fs.readFile(path.join(userSkillDir('docs-writer'), 'SKILL.md'), 'utf8');
    const p2 = await api('POST', '/api/skill-hub/install', { source: 'builtin', name: 'docs-writer', scope: 'user' });
    expect(p1.status).toBe(200);
    expect(p2.status).toBe(200);
    const second = await fs.readFile(path.join(userSkillDir('docs-writer'), 'SKILL.md'), 'utf8');
    expect(second).toBe(first);
  });

  it('源不存在 / 条目不存在返回 404', async () => {
    expect(
      (await api('POST', '/api/skill-hub/install', { source: '不存在源', name: 'x', scope: 'user' })).status,
    ).toBe(404);
    expect(
      (await api('POST', '/api/skill-hub/install', { source: 'builtin', name: 'nope', scope: 'user' })).status,
    ).toBe(404);
  });

  it('scope 非法 400；scope=project 无项目 404', async () => {
    expect((await api('POST', '/api/skill-hub/install', { source: 'builtin', name: 'refactor', scope: 'builtin' })).status).toBe(400);
    expect((await api('POST', '/api/skill-hub/install', { source: 'builtin', name: 'refactor', scope: 'project' })).status).toBe(404);
  });

  it('URL 导入：拉取 SKILL.md 原文解析 frontmatter 后安装（无 name 时从 URL 推导）', async () => {
    const mock = await startMock((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(
        serializeSkillMd({
          description: '导入的技能描述',
          triggers: ['导入', 'import'],
          toolsAllowlist: ['read_file'],
          body: '# 导入正文\n\n按步骤执行。',
        }),
      );
    });
    try {
      const r = await api('POST', '/api/skill-hub/install', { url: mock.url('/skills/imported-skill.md'), scope: 'user' });
      expect(r.status).toBe(200);
      expect((r.json as { name: string }).name).toBe('imported-skill');
      const raw = await fs.readFile(path.join(userSkillDir('imported-skill'), 'SKILL.md'), 'utf8');
      expect(raw).toContain('description: 导入的技能描述');
      expect(raw).toContain('  - 导入');
      expect(raw).toContain('按步骤执行');
    } finally {
      await mock.close();
    }
  });

  it('URL 导入：显式 name 优先；URL 不可达返回 400', async () => {
    const mock = await startMock((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(serializeSkillMd({ description: 'd', triggers: [], toolsAllowlist: [], body: '正文' }));
    });
    try {
      const ok = await api('POST', '/api/skill-hub/install', {
        url: mock.url('/whatever.md'), name: 'explicit-name', scope: 'user',
      });
      expect(ok.status).toBe(200);
      expect((ok.json as { name: string }).name).toBe('explicit-name');

      const bad = await api('POST', '/api/skill-hub/install', {
        url: 'http://127.0.0.1:1/unreachable.md', scope: 'user',
      });
      expect(bad.status).toBe(400);
    } finally {
      await mock.close();
    }
  });
});

describe('GET/PUT /api/skill-hub/sources', () => {
  it('初始返回空数组', async () => {
    const r = await api('GET', '/api/skill-hub/sources');
    expect(r.status).toBe(200);
    expect(r.json.sources).toEqual([]);
  });

  it('PUT 合法源写入文件并可读回', async () => {
    const put = await api('PUT', '/api/skill-hub/sources', {
      sources: [{ name: '团队源', url: 'https://example.com/registry.json' }],
    });
    expect(put.status).toBe(200);
    const raw = JSON.parse(await fs.readFile(sourcesFile(), 'utf8'));
    expect(raw.sources).toHaveLength(1);
    const get = await api('GET', '/api/skill-hub/sources');
    expect(get.json.sources).toEqual([{ name: '团队源', url: 'https://example.com/registry.json' }]);
  });

  it('PUT 校验失败返回 400：非数组 / 空 name / 非法 URL / 名称重复', async () => {
    expect((await api('PUT', '/api/skill-hub/sources', { sources: 'nope' })).status).toBe(400);
    expect((await api('PUT', '/api/skill-hub/sources', { sources: [{ name: '', url: 'https://a.com/r.json' }] })).status).toBe(400);
    expect((await api('PUT', '/api/skill-hub/sources', { sources: [{ name: 'x', url: 'ftp://a.com' }] })).status).toBe(400);
    expect((await api('PUT', '/api/skill-hub/sources', { sources: [{ name: 'x', url: 'not-a-url' }] })).status).toBe(400);
    expect(
      (await api('PUT', '/api/skill-hub/sources', {
        sources: [
          { name: 'dup', url: 'https://a.com/r.json' },
          { name: 'dup', url: 'https://b.com/r.json' },
        ],
      })).status,
    ).toBe(400);
  });

  it('skill-hub.json 损坏时 GET hub 仍可用（errors 提示、目录只含内置）', async () => {
    await fs.mkdir(path.join(tmp, '.y-zero'), { recursive: true });
    await fs.writeFile(sourcesFile(), '{not json', 'utf8');
    const r = await api('GET', '/api/skill-hub');
    expect(r.status).toBe(200);
    expect((r.json.items as unknown[])).toHaveLength(10);
    expect((r.json.errors as string[]).some((e) => e.includes('skill-hub.json'))).toBe(true);
  });
});

describe('卸载走既有 DELETE /api/skills/:name（口径验证：hub installedIn 联动）', () => {
  it('安装 → 卸载 → hub installedIn 清空', async () => {
    await api('POST', '/api/skill-hub/install', { source: 'builtin', name: 'bug-triage', scope: 'user' });
    const mid = await api('GET', '/api/skill-hub');
    expect(
      (mid.json.items as HubItemView[]).find((i) => i.name === 'bug-triage')!.installedIn,
    ).toEqual({ user: true });
    expect((await api('DELETE', '/api/skills/bug-triage?scope=user')).status).toBe(200);
    const after = await api('GET', '/api/skill-hub');
    expect(
      (after.json.items as HubItemView[]).find((i) => i.name === 'bug-triage')!.installedIn,
    ).toEqual({});
  });
});
