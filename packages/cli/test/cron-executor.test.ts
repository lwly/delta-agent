/**
 * F-22b cron-executor 单测：buildCronSpawnArgs 三态（yolo 双 flag / plan / default 不传）
 * 与 maxCostUsd 组合断言（PRD 验收 5）。
 */
import { describe, expect, it } from 'vitest';
import { buildCronSpawnArgs } from '../src/cron-executor.js';

describe('F-22b buildCronSpawnArgs：任务级权限透传', () => {
  it('default / 缺省：不传任何 permission flag（沿用 CLI 默认）', () => {
    expect(buildCronSpawnArgs({ prompt: '整理日报' })).toEqual(['run', '-p', '整理日报', '--json']);
    expect(buildCronSpawnArgs({ prompt: 'p', permission: 'default' })).toEqual(['run', '-p', 'p', '--json']);
  });

  it('plan → --permission plan', () => {
    expect(buildCronSpawnArgs({ prompt: 'p', permission: 'plan' })).toEqual([
      'run',
      '-p',
      'p',
      '--json',
      '--permission',
      'plan',
    ]);
  });

  it('yolo → --permission yolo --yolo 双 flag（缺一会被 resolvePermissionMode 降级告警）', () => {
    const args = buildCronSpawnArgs({ prompt: 'p', permission: 'yolo' });
    expect(args).toContain('--permission');
    expect(args).toContain('--yolo');
    expect(args.slice(args.indexOf('--permission'))).toEqual(['--permission', 'yolo', '--yolo']);
  });

  it('maxCostUsd 组合：费用上限与 permission flag 顺序稳定', () => {
    expect(buildCronSpawnArgs({ prompt: 'p', maxCostUsd: 0.5, permission: 'yolo' })).toEqual([
      'run',
      '-p',
      'p',
      '--json',
      '--max-cost',
      '0.5',
      '--permission',
      'yolo',
      '--yolo',
    ]);
    expect(buildCronSpawnArgs({ prompt: 'p', maxCostUsd: 1.25, permission: 'plan' })).toEqual([
      'run',
      '-p',
      'p',
      '--json',
      '--max-cost',
      '1.25',
      '--permission',
      'plan',
    ]);
  });
});
