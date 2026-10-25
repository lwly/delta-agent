/**
 * Composer 自动补全 —— /api/skills 与 /api/projects/:id/files 端点单测：
 * 文件候选（忽略目录 / q 过滤 / 不跟随符号链接 / 404）
 * 技能候选（三层发现 + projectId 项目层 + 元数据只读）。
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

let tmp = ''; // 项目根
let home = ''; // 用户级 skills 根
let server: ReturnType<typeof createWebServer>;
let base = '';
let projectId = '';

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-cmp-web-'));
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-cmp-home-'));
  // 项目根内造文件树：正常文件 / 忽略目录 / 隐藏目录 / 指向根外的符号链接
  await fs.mkdir(path.join(tmp, 'sub'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'a.ts'), 'export {}');
  await fs.writeFile(path.join(tmp, 'sub', 'b.ts'), 'export {}');
  await fs.mkdir(path.join(tmp, 'node_modules', 'x'), { recursive: true });
  await fs.writeFile(path.join(tmp, 'node_modules', 'x', 'pkg.js'), 'x');
  await fs.mkdir(path.join(tmp, '.git'), { recursive: true });
  await fs.writeFile(path.join(tmp, '.git', 'config'), '');
  await fs.symlink(os.tmpdir(), path.join(tmp, 'evil-link'), 'dir');
  // 用户级 skill：<home>/.delta/skills/demo/SKILL.md
  await fs.mkdir(path.join(home, '.delta', 'skills', 'demo'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.delta', 'skills', 'demo', 'SKILL.md'),
    '---\nname: demo\ndescription: 演示技能\n---\n正文',
  );

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
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const api = async (p: string) => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};

describe('GET /api/projects/:id/files —— @ 文件引用候选', () => {
  it('返回相对路径，跳过忽略目录 / 隐藏目录 / 符号链接', async () => {
    const r = await api(`/api/projects/${projectId}/files`);
    expect(r.status).toBe(200);
    const files = r.json.files as string[];
    expect(files).toContain('a.ts');
    expect(files).toContain('sub/b.ts');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.includes('.git'))).toBe(false);
    expect(files.some((f) => f.startsWith('evil-link'))).toBe(false);
  });

  it('q 参数做子串过滤（大小写不敏感）', async () => {
    const r = await api(`/api/projects/${projectId}/files?q=b.TS`);
    const files = r.json.files as string[];
    expect(files).toEqual(['sub/b.ts']);
  });

  it('未知项目 → 404', async () => {
    const r = await api('/api/projects/no-such/files');
    expect(r.status).toBe(404);
  });
});

describe('GET /api/skills —— / 技能候选', () => {
  it('发现用户层 skill 并返回元数据', async () => {
    const r = await api('/api/skills');
    expect(r.status).toBe(200);
    const skills = r.json.skills as Array<{ name: string; description: string; layer: string }>;
    const demo = skills.find((s) => s.name === 'demo');
    expect(demo?.layer).toBe('user');
    expect(demo?.description).toBe('演示技能');
  });

  it('携带 projectId 时包含项目层；未知项目不报错（跳过项目层）', async () => {
    // 项目层 skill：<tmp>/.delta/skills/proj-skill/SKILL.md
    await fs.mkdir(path.join(tmp, '.delta', 'skills', 'proj-skill'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.delta', 'skills', 'proj-skill', 'SKILL.md'),
      '---\nname: proj-skill\ndescription: 项目技能\n---\n正文',
    );
    const r = await api(`/api/skills?projectId=${projectId}`);
    const skills = r.json.skills as Array<{ name: string; layer: string }>;
    expect(skills.find((s) => s.name === 'proj-skill')?.layer).toBe('project');

    const unknown = await api('/api/skills?projectId=no-such');
    expect(unknown.status).toBe(200);
  });
});
