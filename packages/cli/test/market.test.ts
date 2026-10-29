/**
 * F-52 `delta market` 单测（AC-52-3 守卫逻辑）。
 *
 * 覆盖：plan 权限模式拒绝安装、scripts 确认闸门判定。
 * 网络与文件落盘路径由 core 单测（market.test.ts / market-server.test.ts）与 e2e 覆盖，
 * 这里只测 CLI 层纯守卫函数。
 */
import { describe, expect, it } from 'vitest';
import { planModeRefusal, scriptsRequiringConfirmation } from '../src/market.js';
import type { MarketEntry } from '@delta/core';

describe('planModeRefusal（AC-52-3：plan 权限模式拒绝安装）', () => {
  it('plan 拒绝并给出改法；default / yolo / 未传允许', () => {
    expect(planModeRefusal('plan')).toContain('plan 权限模式');
    expect(planModeRefusal('plan')).toContain('--permission default');
    expect(planModeRefusal('default')).toBeNull();
    expect(planModeRefusal('yolo')).toBeNull();
    expect(planModeRefusal(undefined)).toBeNull();
  });
});

describe('scriptsRequiringConfirmation（AC-52-3：scripts 强制确认闸门）', () => {
  it('含 scripts 的 skill 条目返回脚本清单', () => {
    const entry = {
      kind: 'skill', name: 'a', description: '', category: '', version: '', author: '',
      triggers: [], toolsAllowlist: [], body: '',
      scripts: [{ name: 'run.sh', content: 'echo hi' }],
    } as MarketEntry;
    expect(scriptsRequiringConfirmation(entry)).toEqual([{ name: 'run.sh', content: 'echo hi' }]);
  });

  it('无脚本 skill 与 mcp 条目返回空', () => {
    const skill = {
      kind: 'skill', name: 'a', description: '', category: '', version: '', author: '',
      triggers: [], toolsAllowlist: [], body: '',
    } as MarketEntry;
    const mcp = {
      kind: 'mcp', name: 'b', description: '', category: '', version: '', author: '',
      draft: { command: 'x' },
    } as MarketEntry;
    expect(scriptsRequiringConfirmation(skill)).toEqual([]);
    expect(scriptsRequiringConfirmation(mcp)).toEqual([]);
  });
});
