import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { promises as fs, readFileSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import * as net from 'node:net';
import { zipSync } from 'fflate';
import {
  searchHubSkills,
  installHubSkill,
  extractZipEntries,
  resolveSkillHubBase,
  readSkillHubUrl,
  writeSkillHubUrl,
  userSkillHubConfigPath,
  DEFAULT_SKILL_HUB_BASE,
  SKILL_HUB_ENV,
} from '../src/skills/hub.js';

let tmp = '';
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-hub-'));
});

// ── 本地 mock hub（覆盖 search / download 两个端点）─────────────────────────

const servers: http.Server[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** 启动 mock hub：handlers 按 URL 前缀匹配，返回 { status, body } */
async function startHub(handlers: Record<string, { status: number; body: Uint8Array | string }>): Promise<string> {
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    for (const [prefix, resp] of Object.entries(handlers)) {
      if (url.startsWith(prefix)) {
        res.writeHead(resp.status, { 'Content-Type': 'application/octet-stream' });
        res.end(resp.body);
        return;
      }
    }
    res.writeHead(404);
    res.end('not found');
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return `http://127.0.0.1:${port}`;
}

const SKILL_MD = `---
name: demo-skill
description: 演示技能
triggers: [demo]
---
# 演示
主体指令
`;

// ── resolveSkillHubBase：配置优先级 ─────────────────────────────────────────

describe('resolveSkillHubBase', () => {
  it('无任何配置 → 官方默认', () => {
    const home = path.join(tmp, 'home');
    const r = resolveSkillHubBase({ homeDir: home });
    expect(r.base).toBe(DEFAULT_SKILL_HUB_BASE);
    expect(r.source).toBe('default');
  });

  it('配置文件 > 默认', async () => {
    const home = path.join(tmp, 'home2');
    writeSkillHubUrl('https://hub.example.com', { homeDir: home });
    const r = resolveSkillHubBase({ homeDir: home });
    expect(r.base).toBe('https://hub.example.com');
    expect(r.source).toBe('config');
  });

  it('环境变量 > 配置文件', async () => {
    const home = path.join(tmp, 'home3');
    writeSkillHubUrl('https://hub.example.com', { homeDir: home });
    const prev = process.env[SKILL_HUB_ENV];
    process.env[SKILL_HUB_ENV] = 'https://env.example.com/';
    try {
      const r = resolveSkillHubBase({ homeDir: home });
      expect(r.base).toBe('https://env.example.com'); // 尾部 / 被归一化
      expect(r.source).toBe('env');
    } finally {
      if (prev === undefined) delete process.env[SKILL_HUB_ENV];
      else process.env[SKILL_HUB_ENV] = prev;
    }
  });

  it('显式 flag 最高优先', async () => {
    const home = path.join(tmp, 'home4');
    writeSkillHubUrl('https://hub.example.com', { homeDir: home });
    process.env[SKILL_HUB_ENV] = 'https://env.example.com';
    try {
      const r = resolveSkillHubBase({ flag: 'http://flag.example.com', homeDir: home });
      expect(r.base).toBe('http://flag.example.com');
      expect(r.source).toBe('flag');
    } finally {
      delete process.env[SKILL_HUB_ENV];
    }
  });

  it('非法地址（非 http/https）抛错', () => {
    expect(() => resolveSkillHubBase({ flag: 'ftp://x' })).toThrow(/http\(s\)/);
    expect(() => resolveSkillHubBase({ flag: 'not-a-url' })).toThrow(/URL/);
  });
});

// ── 配置文件读写 ─────────────────────────────────────────────────────────────

describe('skill hub config', () => {
  it('写入后可读回；reset(null) 清除 url 并保留其它字段', () => {
    const home = path.join(tmp, 'home5');
    writeSkillHubUrl('https://a.example.com', { homeDir: home });
    expect(readSkillHubUrl(home)).toBe('https://a.example.com');
    expect(userSkillHubConfigPath(home)).toBe(path.join(home, '.y-zero', 'skill-hub.json'));

    // 手工塞一个无关字段，验证 reset 不破坏
    const file = userSkillHubConfigPath(home);
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    raw.keepMe = 1;
    writeFileSync(file, JSON.stringify(raw));

    writeSkillHubUrl(null, { homeDir: home });
    expect(readSkillHubUrl(home)).toBeUndefined();
    const after = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    expect(after.keepMe).toBe(1);
  });

  it('非法 url 拒绝落盘', () => {
    const home = path.join(tmp, 'home6');
    expect(() => writeSkillHubUrl('javascript:alert(1)', { homeDir: home })).toThrow(/http\(s\)/);
    expect(readSkillHubUrl(home)).toBeUndefined();
  });

  it('坏 JSON 配置读取降级为 undefined（永不 throw）', async () => {
    const home = path.join(tmp, 'home7');
    const file = userSkillHubConfigPath(home);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{oops');
    expect(readSkillHubUrl(home)).toBeUndefined();
  });
});

// ── 搜索 ────────────────────────────────────────────────────────────────────

describe('searchHubSkills', () => {
  it('解析 results 数组并宽容丢弃缺 slug 条目', async () => {
    const base = await startHub({
      '/api/v1/search': {
        status: 200,
        body: JSON.stringify({
          results: [
            { slug: 'git', name: 'Git', description: 'git ops', description_zh: 'git 操作', downloads: 100 },
            { name: 'no-slug' },
            'junk',
          ],
        }),
      },
    });
    const r = await searchHubSkills(base, 'git');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ slug: 'git', name: 'Git', descriptionZh: 'git 操作', downloads: 100 });
  });

  it('HTTP 500 抛错并带状态码', async () => {
    const base = await startHub({ '/api/v1/search': { status: 500, body: 'boom' } });
    await expect(searchHubSkills(base, 'x')).rejects.toThrow(/HTTP 500/);
  });

  it('响应缺 results 数组抛错', async () => {
    const base = await startHub({ '/api/v1/search': { status: 200, body: '{"bad":1}' } });
    await expect(searchHubSkills(base, 'x')).rejects.toThrow(/results/);
  });
});

// ── 安装 ────────────────────────────────────────────────────────────────────

describe('installHubSkill', () => {
  it('包根布局 zip：安装到 targetDir/<slug> 并通过 SKILL.md 校验', async () => {
    const zip = zipSync({ 'SKILL.md': new TextEncoder().encode(SKILL_MD), 'notes.md': new TextEncoder().encode('n') });
    const base = await startHub({ '/api/v1/download': { status: 200, body: zip } });
    const targetDir = path.join(tmp, 'skills');

    const r = await installHubSkill('demo', { base, targetDir });
    expect(r.dirName).toBe('demo');
    expect(r.skill.name).toBe('demo-skill');
    expect(r.skill.layer).toBe('user');
    expect(r.files.sort()).toEqual(['SKILL.md', 'notes.md']);
    await expect(fs.readFile(path.join(targetDir, 'demo', 'SKILL.md'), 'utf-8')).resolves.toContain('demo-skill');
  });

  it('单顶层目录布局 zip：剥掉前缀后安装', async () => {
    const zip = zipSync({ 'wrap/SKILL.md': new TextEncoder().encode(SKILL_MD) });
    const base = await startHub({ '/api/v1/download': { status: 200, body: zip } });
    const r = await installHubSkill('wrap-skill', { base, targetDir: path.join(tmp, 's2') });
    expect(r.files).toEqual(['SKILL.md']);
    expect(r.skill.name).toBe('demo-skill');
  });

  it('命名空间 slug 取末段做目录名', async () => {
    const zip = zipSync({ 'SKILL.md': new TextEncoder().encode(SKILL_MD) });
    const base = await startHub({ '/api/v1/download': { status: 200, body: zip } });
    const r = await installHubSkill('@org/demo-x', { base, targetDir: path.join(tmp, 's3') });
    expect(r.dirName).toBe('demo-x');
  });

  it('目标已存在且未加 force → 报错；加 force → 覆盖重装', async () => {
    const zip = zipSync({ 'SKILL.md': new TextEncoder().encode(SKILL_MD) });
    const base = await startHub({ '/api/v1/download': { status: 200, body: zip } });
    const targetDir = path.join(tmp, 's4');

    await installHubSkill('dup', { base, targetDir });
    await expect(installHubSkill('dup', { base, targetDir })).rejects.toThrow(/--force/);

    const r = await installHubSkill('dup', { base, targetDir, force: true });
    expect(r.dirName).toBe('dup');
  });

  it('zip-slip：.. 越界条目被拒绝，不落盘', async () => {
    const zip = zipSync({
      'SKILL.md': new TextEncoder().encode(SKILL_MD),
      '../evil.txt': new TextEncoder().encode('bad'),
    });
    const base = await startHub({ '/api/v1/download': { status: 200, body: zip } });
    const targetDir = path.join(tmp, 's5');
    await expect(installHubSkill('evil', { base, targetDir })).rejects.toThrow(/zip-slip/);
    // 越界文件不存在
    await expect(fs.access(path.join(targetDir, 'evil.txt'))).rejects.toThrow();
  });

  it('缺 SKILL.md 的 zip 报错', async () => {
    const zip = zipSync({ 'other.txt': new TextEncoder().encode('x') });
    const base = await startHub({ '/api/v1/download': { status: 200, body: zip } });
    await expect(installHubSkill('bad', { base, targetDir: path.join(tmp, 's6') })).rejects.toThrow(/SKILL\.md/);
  });

  it('HTTP 404 报错', async () => {
    const base = await startHub({});
    await expect(installHubSkill('missing', { base, targetDir: path.join(tmp, 's7') })).rejects.toThrow(/HTTP 404/);
  });
});

// ── extractZipEntries 纯函数 ────────────────────────────────────────────────

describe('extractZipEntries', () => {
  it('过滤目录条目 / __MACOSX / .DS_Store', () => {
    const zip = zipSync({
      'SKILL.md': new TextEncoder().encode(SKILL_MD),
      'refs/': new Uint8Array(0),
      '__MACOSX/meta': new TextEncoder().encode('junk'),
      '.DS_Store': new TextEncoder().encode('junk'),
    });
    const m = extractZipEntries(zip);
    expect([...m.keys()]).toEqual(['SKILL.md']);
  });

  it('绝对路径条目被拒绝', () => {
    const zip = zipSync({
      'SKILL.md': new TextEncoder().encode(SKILL_MD),
      '/etc/evil': new TextEncoder().encode('x'),
    });
    expect(() => extractZipEntries(zip)).toThrow(/zip-slip/);
  });

  it('空 zip 报错', () => {
    expect(() => extractZipEntries(zipSync({}))).toThrow();
  });
});
