/**
 * F-39 T02：三层发现器 + mtime 指纹缓存 + 头像校验
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ExpertStore } from '../src/experts/store.js';

const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-expert-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function writePackage(root: string, name: string, opts: { version?: string; body?: string; tools?: string[] } = {}): Promise<void> {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'agents'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'expert.json'),
    JSON.stringify({
      name,
      version: opts.version ?? '1.0.0',
      description: `${name} desc`,
      author: { name: 'tester' },
      expertType: 'agent',
      agentName: `${name}-agent`,
      agents: [`agents/${name}-agent.md`],
      displayName: { en: name, zh: `${name} 中文` },
      profession: { en: 'Eng', zh: '工程师' },
      ...(opts.tools ? { tools: opts.tools } : {}),
    }),
    'utf-8',
  );
  await fs.writeFile(
    path.join(dir, 'agents', `${name}-agent.md`),
    `---\nname: ${name}-agent\ndescription: x\ndisplayName_zh: ${name} 中文\nprofession_zh: 工程师\n---\n\n${opts.body ?? `${name} 正文`}`,
    'utf-8',
  );
}

describe('ExpertStore 三层发现', () => {
  it('内置层解析；list 返回记录与空 errors', async () => {
    const builtin = await tmp();
    await writePackage(builtin, 'alpha');
    const store = new ExpertStore({ builtinDir: builtin, homeDir: await tmp(), projectRoot: await tmp() });
    const { experts, errors } = await store.list();
    expect(errors).toEqual([]);
    expect(experts.map((e) => `${e.name}:${e.layer}`)).toEqual(['alpha:builtin']);
  });

  it('用户层同名覆盖内置；项目层覆盖用户层', async () => {
    const builtin = await tmp();
    const user = await tmp();
    const project = await tmp();
    await writePackage(builtin, 'alpha', { version: '1.0.0', body: '内置' });
    await writePackage(path.join(user, '.delta', 'experts'), 'alpha', { version: '2.0.0', body: '用户' });
    const store = new ExpertStore({ builtinDir: builtin, homeDir: user, projectRoot: project });
    const first = await store.get('alpha');
    expect(first!.layer).toBe('user');
    expect(first!.agent.body).toBe('用户');

    await writePackage(path.join(project, '.delta', 'experts'), 'alpha', { version: '3.0.0', body: '项目' });
    const second = await new ExpertStore({ builtinDir: builtin, homeDir: user, projectRoot: project }).get('alpha');
    expect(second!.layer).toBe('project');
    expect(second!.agent.body).toBe('项目');
  });

  it('layers() 返回每层原始视图（含被覆盖项）', async () => {
    const builtin = await tmp();
    const user = await tmp();
    await writePackage(builtin, 'alpha');
    await writePackage(path.join(user, '.delta', 'experts'), 'alpha');
    const layers = await new ExpertStore({ builtinDir: builtin, homeDir: user }).layers();
    expect(layers.byLayer.builtin.map((e) => e.name)).toEqual(['alpha']);
    expect(layers.byLayer.user.map((e) => e.name)).toEqual(['alpha']);
  });

  it('坏包只跳过自己并给出 `layer/name: msg` 文案', async () => {
    const builtin = await tmp();
    await writePackage(builtin, 'good');
    const badDir = path.join(builtin, 'bad');
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(path.join(badDir, 'expert.json'), JSON.stringify({ name: 'bad', expertType: 'agent' }), 'utf-8');
    const { experts, errors } = await new ExpertStore({ builtinDir: builtin }).list();
    expect(experts.map((e) => e.name)).toEqual(['good']);
    expect(errors.some((e) => e.startsWith('builtin/bad:'))).toBe(true);
  });

  it('单层超过上限 → 截断 + errors', async () => {
    const builtin = await tmp();
    for (const n of ['aaa', 'bbb', 'ccc']) await writePackage(builtin, n);
    const { experts, errors } = await new ExpertStore({ builtinDir: builtin, maxPerLayer: 2 }).list();
    expect(experts).toHaveLength(2);
    expect(errors.join('\n')).toMatch(/超过上限 2/);
  });

  it('disabled 清单过滤', async () => {
    const builtin = await tmp();
    await writePackage(builtin, 'alpha');
    const { experts } = await new ExpertStore({ builtinDir: builtin, disabled: ['alpha'] }).list();
    expect(experts).toEqual([]);
  });
});

describe('ExpertStore 指纹缓存', () => {
  it('二次 list 零解析（readFile 不再被调用）', async () => {
    const builtin = await tmp();
    await writePackage(builtin, 'alpha');
    const store = new ExpertStore({ builtinDir: builtin });
    await store.list();
    const spy = vi.spyOn(fs, 'readFile');
    await store.list();
    expect(spy).not.toHaveBeenCalled();
  });

  it('改 md 正文（mtime 变化）→ 缓存失效并读到新正文', async () => {
    const builtin = await tmp();
    await writePackage(builtin, 'alpha', { body: '旧正文' });
    const store = new ExpertStore({ builtinDir: builtin });
    expect((await store.get('alpha'))!.agent.body).toBe('旧正文');

    const mdFile = path.join(builtin, 'alpha', 'agents', 'alpha-agent.md');
    await fs.writeFile(
      mdFile,
      '---\nname: alpha-agent\ndescription: x\ndisplayName_zh: alpha\nprofession_zh: 工程师\n---\n\n新正文',
      'utf-8',
    );
    const future = new Date(Date.now() + 5_000);
    await fs.utimes(mdFile, future, future);
    expect((await store.get('alpha'))!.agent.body).toBe('新正文');
  });

  it('新增包（目录 mtime 变化）→ 自动失效；invalidate() 幂等', async () => {
    const builtin = await tmp();
    await writePackage(builtin, 'alpha');
    const store = new ExpertStore({ builtinDir: builtin });
    expect((await store.list()).experts).toHaveLength(1);
    await writePackage(builtin, 'beta');
    expect((await store.list()).experts).toHaveLength(2);
    store.invalidate();
    expect((await store.list()).experts).toHaveLength(2);
  });
});

describe('头像校验', () => {
  it('超过 500KB → avatarPath=null + warning，包仍可用', async () => {
    const builtin = await tmp();
    await writePackage(builtin, 'alpha');
    const dir = path.join(builtin, 'alpha');
    await fs.mkdir(path.join(dir, 'avatars'), { recursive: true });
    await fs.writeFile(path.join(dir, 'avatars', 'expert.png'), Buffer.alloc(600 * 1024));
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'expert.json'), 'utf-8'));
    pkg.avatar = 'avatars/expert.png';
    await fs.writeFile(path.join(dir, 'expert.json'), JSON.stringify(pkg), 'utf-8');

    const store = new ExpertStore({ builtinDir: builtin });
    const rec = await store.get('alpha');
    expect(rec!.avatarPath).toBeNull();
    expect((await store.list()).errors.join('\n')).toMatch(/头像超过/);
  });

  it('.gif 扩展名 → 忽略', async () => {
    const builtin = await tmp();
    await writePackage(builtin, 'alpha');
    const dir = path.join(builtin, 'alpha');
    await fs.mkdir(path.join(dir, 'avatars'), { recursive: true });
    await fs.writeFile(path.join(dir, 'avatars', 'expert.gif'), Buffer.alloc(128));
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'expert.json'), 'utf-8'));
    pkg.avatar = 'avatars/expert.gif';
    await fs.writeFile(path.join(dir, 'expert.json'), JSON.stringify(pkg), 'utf-8');
    const rec = await new ExpertStore({ builtinDir: builtin }).get('alpha');
    expect(rec!.avatarPath).toBeNull();
  });
});
