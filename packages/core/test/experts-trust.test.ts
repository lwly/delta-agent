/**
 * F-39 P1（T16）：信任清单（~/.delta/experts.json）
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  expertsConfigPath,
  readExpertsConfig,
  isTrusted,
  recordTrust,
  revokeTrust,
  setDisabled,
  toolsHashOf,
} from '../src/experts/trust.js';
import { parseExpertPackage, type ParseInput } from '../src/experts/parser.js';
import type { ExpertRecord } from '../src/experts/types.js';

const dirs: string[] = [];
const home = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-trust-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

function record(over: Partial<ExpertRecord> = {}): ExpertRecord {
  const base = makeRecord();
  return { ...base, ...over } as ExpertRecord;
}

function makeRecord(): ExpertRecord {
  const input: ParseInput = {
    dir: '/tmp/x',
    layer: 'user',
    name: 'my-expert',
    expertJson: JSON.stringify({
      name: 'my-expert', version: '1.0.0', description: '', author: { name: 't' },
      expertType: 'agent', agentName: 'my-expert-agent', agents: ['agents/my-expert-agent.md'],
      displayName: { en: 'ME', zh: '我的专家' }, profession: { en: 'P', zh: '职业' },
      tools: ['read_file', 'write_file'],
    }),
    agentFiles: new Map([['my-expert-agent.md', { raw: '---\nname: my-expert-agent\ndescription: x\ndisplayName_zh: m\nprofession_zh: p\n---\n\n正文', absPath: '/x' }]]),
    avatarPath: null,
  };
  return parseExpertPackage(input);
}

describe('toolsHashOf', () => {
  it('排序稳定；未声明 tools = none', () => {
    const a = toolsHashOf(record({ tools: ['write_file', 'read_file'] }));
    const b = toolsHashOf(record({ tools: ['read_file', 'write_file'] }));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(toolsHashOf(record({ tools: null }))).toBe('none');
  });
});

describe('isTrusted / recordTrust / revokeTrust', () => {
  it('builtin 恒已信任；user 层未记录 → false', async () => {
    const h = await home();
    const cfg = await readExpertsConfig(h);
    expect(isTrusted(cfg, record({ layer: 'builtin' }))).toBe(true);
    expect(isTrusted(cfg, record())).toBe(false);
  });

  it('recordTrust 后 true；版本或工具集变化 → false', async () => {
    const h = await home();
    const r = record();
    await recordTrust(h, r);
    let cfg = await readExpertsConfig(h);
    expect(isTrusted(cfg, r)).toBe(true);

    cfg = await readExpertsConfig(h);
    expect(isTrusted(cfg, record({ version: '1.0.1' }))).toBe(false);
    expect(isTrusted(cfg, record({ tools: ['read_file'] }))).toBe(false);
  });

  it('revokeTrust 后回 false；重复信任覆盖同条目', async () => {
    const h = await home();
    const r = record();
    await recordTrust(h, r);
    await recordTrust(h, r);
    let cfg = await readExpertsConfig(h);
    expect(cfg.trusted).toHaveLength(1);
    await revokeTrust(h, r.name);
    cfg = await readExpertsConfig(h);
    expect(isTrusted(cfg, r)).toBe(false);
  });

  it('setDisabled 记录/解除；损坏文件宽容读取', async () => {
    const h = await home();
    await setDisabled(h, 'a', true);
    await setDisabled(h, 'b', true);
    await setDisabled(h, 'a', false);
    let cfg = await readExpertsConfig(h);
    expect(cfg.disabled).toEqual(['b']);
    await fs.writeFile(expertsConfigPath(h), '{broken', 'utf-8');
    cfg = await readExpertsConfig(h);
    expect(cfg).toEqual({ disabled: [], trusted: [] });
  });
});
