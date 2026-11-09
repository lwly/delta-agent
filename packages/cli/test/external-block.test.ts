/**
 * F-55 `delta models list` 外部 Agent 区块渲染单测（docs/design-f55-external-cli-agents.md §10）：
 *  - 被测对象是纯渲染函数：探测（ensureExternalAdapters）在命令入口完成，这里只断言行内容；
 *  - 有探测结果 → 区块含「外部 Agent」标题与 id / 版本 / 来源 / 登录态 / plan 档；
 *  - 无结果 → 含「未探测到」；
 *  - 登录态标记只依赖 existsSync（homeDir 注入临时目录，不碰真实 HOME）。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { KNOWN_AGENTS, type DetectedAgent } from '@delta/core/external';
import { externalAgentBlockLines, planMark } from '../src/external-block.js';

const DEF = KNOWN_AGENTS[0]!;

function detected(source: 'env' | 'cache' | 'path' = 'path'): DetectedAgent {
  return { def: DEF, command: '/usr/local/bin/claude', version: '2.1.168', source };
}

describe('externalAgentBlockLines（models list 外部区块，§10）', () => {
  it('有探测结果：含「外部 Agent」标题与 id / 版本 / Tier / 来源 / 登录态 / plan 档', () => {
    const lines = externalAgentBlockLines([detected('env')]);
    const text = lines.join('\n');
    expect(text).toContain('外部 Agent');
    expect(text).toContain('cli:claude-code');
    expect(text).toContain('claude');
    expect(text).toContain('2.1.168');
    expect(text).toContain('Tier B');
    expect(text).toContain('[env]');
    expect(text).toContain('登录态');
    expect(text).toContain('plan 档');
  });

  it('无探测结果：含「未探测到」且说明 delta 只探测不安装（§16 红线文案）', () => {
    const text = externalAgentBlockLines([]).join('\n');
    expect(text).toContain('外部 Agent');
    expect(text).toContain('未探测到');
    expect(text).toContain('只探测不安装');
  });

  it('登录态标记：homeDir 存在 .claude.json → ✓；不存在 → ✗（只 existsSync，不解析内容）', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-ext-block-'));
    try {
      const absent = externalAgentBlockLines([detected()], tmp).join('\n');
      expect(absent).toContain('登录态: ✗');
      fs.writeFileSync(path.join(tmp, '.claude.json'), '{}');
      const present = externalAgentBlockLines([detected()], tmp).join('\n');
      expect(present).toContain('登录态: ✓');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('plan 档标记：permissionArgs.plan 非空 → ✓（claude-code 实测有 --permission-mode plan）', () => {
    expect(planMark(DEF)).toBe('✓');
  });
});
