import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readBudgetSetting, writeBudgetSetting } from '../src/server/settings-store.js';
import { readFileSync } from 'node:fs';

let home = '';

beforeEach(async () => {
  // sandbox.test 的清理口径会递归删除 mkdtemp 的父目录（整个 TMPDIR 根），
  // 并行运行时可能把根目录删掉 —— 这里 mkdir 自愈后再建临时目录
  await fs.mkdir(os.tmpdir(), { recursive: true });
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-settings-'));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

describe('server/settings-store（会话预算设置）', () => {
  it('空配置读取 → 空对象（回退默认）', () => {
    expect(readBudgetSetting(home)).toEqual({});
  });

  it('写入后可读回；其他设置键原样保留', async () => {
    writeBudgetSetting({ maxTokens: 1_000_000, maxCostUsd: 2.5 }, home);
    expect(readBudgetSetting(home)).toEqual({ maxTokens: 1_000_000, maxCostUsd: 2.5 });

    // 模拟既有 settings.json 里的其他键不被破坏：写入 theme 后再走一次预算写入
    const file = path.join(home, '.delta', 'settings.json');
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(['budget']);
    raw.theme = 'dark';
    await fs.writeFile(file, JSON.stringify(raw, null, 2), 'utf-8');
    writeBudgetSetting({}, home);
    const after = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    expect(after.theme).toBe('dark');
  });

  it('null 删除字段（回退默认）；merge 语义保留另一字段', () => {
    writeBudgetSetting({ maxTokens: 1_000_000, maxCostUsd: 2.5 }, home);
    writeBudgetSetting({ maxTokens: null }, home);
    expect(readBudgetSetting(home)).toEqual({ maxCostUsd: 2.5 });
  });

  it('非法值抛错（正数校验）', () => {
    expect(() => writeBudgetSetting({ maxTokens: 0 }, home)).toThrow(/maxTokens/);
    expect(() => writeBudgetSetting({ maxTokens: -5 }, home)).toThrow(/maxTokens/);
    expect(() => writeBudgetSetting({ maxCostUsd: -1 }, home)).toThrow(/maxCostUsd/);
    // 抛错后文件不被破坏
    expect(readBudgetSetting(home)).toEqual({});
  });

  it('坏 JSON settings.json 读取降级为空（不抛错）', async () => {
    await fs.mkdir(path.join(home, '.delta'), { recursive: true });
    await fs.writeFile(path.join(home, '.delta', 'settings.json'), '{oops');
    expect(readBudgetSetting(home)).toEqual({});
  });
});
