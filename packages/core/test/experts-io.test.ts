/**
 * F-39 P1（T15）：zip 导入 / 导出 / 创建骨架
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { installExpertFromBytes, exportExpertToBytes, scaffoldExpert } from '../src/experts/io.js';

const dirs: string[] = [];
const tmp = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-expert-io-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

// 值一律 strToU8：zipSync 只接受 Uint8Array（传字符串会在 fltn 内爆栈）
const PACKAGE = {
  'expert.json': strToU8(JSON.stringify({
    name: 'imported-expert',
    version: '1.0.0',
    description: 'd',
    author: { name: 't' },
    expertType: 'agent',
    agentName: 'imported-expert-agent',
    agents: ['agents/imported-expert-agent.md'],
    displayName: { en: 'IE', zh: '导入专家' },
    profession: { en: 'P', zh: '职业' },
  })),
  'agents/imported-expert-agent.md': strToU8(
    '---\nname: imported-expert-agent\ndescription: x\ndisplayName_zh: 导入\nprofession_zh: 职业\n---\n\n正文',
  ),
};

const ioOpts = async () => {
  const homeDir = await tmp();
  const projectRoot = await tmp();
  return { homeDir, projectRoot };
};

describe('installExpertFromBytes', () => {
  it('正常导入（顶层目录剥离）+ 试解析通过', async () => {
    const o = await ioOpts();
    // 注：不构造显式目录条目 —— fflate zipSync 对「目录条目 + 子目录文件」会栈溢出（fltn 缺陷）
    const r = await installExpertFromBytes(zipSync({ 'imported-expert/expert.json': PACKAGE['expert.json']!, 'imported-expert/agents/imported-expert-agent.md': PACKAGE['agents/imported-expert-agent.md']! }), {
      layer: 'user',
      homeDir: o.homeDir,
    });
    expect(r.name).toBe('imported-expert');
    expect(r.warnings).toEqual([]);
    const store = await fs.readdir(path.join(o.homeDir, '.delta', 'experts'));
    expect(store).toContain('imported-expert');
  });

  it('zip-slip 条目 → 拒绝且不留残留', async () => {
    const o = await ioOpts();
    const evil = { ...PACKAGE, '../evil.sh': strToU8('x') };
    await expect(
      installExpertFromBytes(zipSync(evil), { layer: 'user', homeDir: o.homeDir }),
    ).rejects.toThrow(/越界/);
    const leftovers = await fs.readdir(path.join(o.homeDir, '.delta', 'experts')).catch(() => []);
    expect(leftovers.filter((n) => n.includes('importing'))).toEqual([]);
  });

  it('缺 expert.json → 报错', async () => {
    const o = await ioOpts();
    await expect(
      installExpertFromBytes(zipSync({ 'agents/x.md': strToU8('x') }), { layer: 'user', homeDir: o.homeDir }),
    ).rejects.toThrow(/expert\.json/);
  });

  it('同名已存在且未 --force → 拒绝；--force 覆盖', async () => {
    const o = await ioOpts();
    const bytes = zipSync(PACKAGE);
    await installExpertFromBytes(bytes, { layer: 'user', homeDir: o.homeDir });
    await expect(
      installExpertFromBytes(bytes, { layer: 'user', homeDir: o.homeDir }),
    ).rejects.toThrow(/同名包/);
    await installExpertFromBytes(bytes, { layer: 'user', homeDir: o.homeDir, force: true });
  });

  it('坏包（缺 agents 文件）→ 拒绝且临时目录清理', async () => {
    const o = await ioOpts();
    const bad = { 'expert.json': PACKAGE['expert.json']! };
    await expect(
      installExpertFromBytes(zipSync(bad), { layer: 'user', homeDir: o.homeDir }),
    ).rejects.toThrow(/不存在/);
    const leftovers = await fs.readdir(path.join(o.homeDir, '.delta', 'experts')).catch(() => []);
    expect(leftovers.filter((n) => n.includes('importing'))).toEqual([]);
  });
});

describe('exportExpertToBytes', () => {
  it('导出 zip 可回导（roundtrip），expert.json 副本含 exportedBy', async () => {
    const o = await ioOpts();
    const scaffold = await scaffoldExpert({
      name: 'round-trip',
      displayName: '回环',
      profession: '测试',
      expertType: 'agent',
      layer: 'user',
      homeDir: o.homeDir,
    });
    const { bytes, fileName } = await exportExpertToBytes('round-trip', { homeDir: o.homeDir });
    expect(fileName).toBe('round-trip.zip');

    const other = await ioOpts();
    const r = await installExpertFromBytes(bytes, { layer: 'user', homeDir: other.homeDir });
    expect(r.name).toBe('round-trip');
    expect(scaffold.dir).toBeTruthy();
  });

  it('内置专家不可导出；不存在 → 报错', async () => {
    const o = await ioOpts();
    await expect(exportExpertToBytes('code-architect', { homeDir: o.homeDir })).rejects.toThrow(/内置/);
    await expect(exportExpertToBytes('ghost', { homeDir: o.homeDir })).rejects.toThrow(/未找到/);
  });
});

describe('scaffoldExpert', () => {
  it('非法 name / 重名 → 报错；团队骨架含 3 agent 与 teamInfo', async () => {
    const o = await ioOpts();
    await scaffoldExpert({ name: 'my-team', displayName: 'T', profession: 'P', expertType: 'team', layer: 'user', homeDir: o.homeDir });
    const pkg = JSON.parse(
      await fs.readFile(path.join(o.homeDir, '.delta', 'experts', 'my-team', 'expert.json'), 'utf-8'),
    ) as { agents: string[]; teamInfo: { memberAgents: string[] } };
    expect(pkg.agents).toHaveLength(3);
    expect(pkg.teamInfo.memberAgents).toHaveLength(3);

    await expect(
      scaffoldExpert({ name: '1bad', displayName: 'x', profession: 'y', expertType: 'agent', layer: 'user', homeDir: o.homeDir }),
    ).rejects.toThrow(/非法|包名/);
    await expect(
      scaffoldExpert({ name: 'my-team', displayName: 'x', profession: 'y', expertType: 'agent', layer: 'user', homeDir: o.homeDir }),
    ).rejects.toThrow(/同名包/);
  });
});
