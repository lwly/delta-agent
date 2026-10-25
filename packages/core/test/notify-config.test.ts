/**
 * F-33 桌面通知 —— 配置体系单测（设计 §8）：
 * 两级加载/覆盖、非法值降级 + warning、坏 JSON 层忽略、未知键 warning、
 * updateUserNotifyEnabled 只改 enabled + 原子写 + 坏 JSON 拒写。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadNotifyConfig,
  normalizeNotifyLayer,
  projectNotifyConfigPath,
  updateUserNotifyEnabled,
  userNotifyConfigPath,
} from '../src/notify/config.js';
import { DEFAULT_NOTIFY_CONFIG } from '../src/notify/types.js';

/** 建一个带 .delta 的临时项目目录 */
function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-notify-'));
  fs.mkdirSync(path.join(dir, '.delta'), { recursive: true });
  return dir;
}

function tmpHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-notify-home-'));
  fs.mkdirSync(path.join(dir, '.delta'), { recursive: true });
  return dir;
}

describe('F-33 notify 配置加载', () => {
  it('无任何配置文件时返回默认值且不 explicit', () => {
    const project = tmpProject();
    const home = tmpHome();
    const r = loadNotifyConfig({ projectRoot: project, homeDir: home });
    expect(r.config).toEqual(DEFAULT_NOTIFY_CONFIG);
    expect(r.explicit).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it('项目层逐字段覆盖用户层', () => {
    const project = tmpProject();
    const home = tmpHome();
    fs.writeFileSync(path.join(home, '.delta', 'notify.json'), JSON.stringify({ enabled: false, onConfirm: false }));
    fs.writeFileSync(path.join(project, '.delta', 'notify.json'), JSON.stringify({ enabled: true, minDurationMs: 60000 }));
    const r = loadNotifyConfig({ projectRoot: project, homeDir: home });
    expect(r.config.enabled).toBe(true); // 项目覆盖用户
    expect(r.config.onConfirm).toBe(false); // 用户层字段保留
    expect(r.config.onDone).toBe(true); // 未声明 → 默认
    expect(r.config.minDurationMs).toBe(60000);
    expect(r.explicit).toBe(true);
  });

  it('非法值降级默认 + warning，永不 throw', () => {
    const project = tmpProject();
    const home = tmpHome();
    fs.writeFileSync(
      path.join(home, '.delta', 'notify.json'),
      JSON.stringify({ enabled: 'yes', minDurationMs: -5, onDone: 1 }),
    );
    const r = loadNotifyConfig({ projectRoot: project, homeDir: home });
    expect(r.config).toEqual(DEFAULT_NOTIFY_CONFIG);
    const fields = r.warnings.map((w) => w.field);
    expect(fields).toContain('enabled');
    expect(fields).toContain('minDurationMs');
    expect(fields).toContain('onDone');
  });

  it('坏 JSON 整层忽略 + warning；另一层不受影响', () => {
    const project = tmpProject();
    const home = tmpHome();
    fs.writeFileSync(path.join(home, '.delta', 'notify.json'), '{not json');
    fs.writeFileSync(path.join(project, '.delta', 'notify.json'), JSON.stringify({ enabled: false }));
    const r = loadNotifyConfig({ projectRoot: project, homeDir: home });
    expect(r.config.enabled).toBe(false);
    expect(r.warnings.some((w) => w.source === 'user' && /无法解析/.test(w.message))).toBe(true);
  });

  it('非 JSON 对象（数组/字符串）整层忽略 + warning', () => {
    const w1: Parameters<typeof normalizeNotifyLayer>[2] = [];
    expect(normalizeNotifyLayer([1, 2], 'user', w1)).toEqual({});
    expect(w1.length).toBe(1);
    const w2: Parameters<typeof normalizeNotifyLayer>[2] = [];
    expect(normalizeNotifyLayer('oops', 'user', w2)).toEqual({});
    expect(w2.length).toBe(1);
  });

  it('未知键 warning 忽略', () => {
    const w: Parameters<typeof normalizeNotifyLayer>[2] = [];
    normalizeNotifyLayer({ enabled: false, volume: 3 }, 'user', w);
    expect(w.map((x) => x.field)).toContain('volume');
  });

  it('空文件整层忽略 + warning', () => {
    const project = tmpProject();
    const home = tmpHome();
    fs.writeFileSync(path.join(home, '.delta', 'notify.json'), '   ');
    const r = loadNotifyConfig({ projectRoot: project, homeDir: home });
    expect(r.config).toEqual(DEFAULT_NOTIFY_CONFIG);
    expect(r.warnings.some((w) => /空文件/.test(w.message))).toBe(true);
  });

  it('路径函数：~/.delta/notify.json 与 .delta/notify.json', () => {
    expect(userNotifyConfigPath('/h')).toBe(path.join('/h', '.delta', 'notify.json'));
    expect(projectNotifyConfigPath('/p')).toBe(path.join('/p', '.delta', 'notify.json'));
  });
});

describe('F-33 updateUserNotifyEnabled（enable/disable 写路径）', () => {
  it('只改 enabled，其它字段原样保留', () => {
    const home = tmpHome();
    fs.writeFileSync(
      path.join(home, '.delta', 'notify.json'),
      JSON.stringify({ enabled: true, onDone: false, minDurationMs: 5000 }),
    );
    const r = updateUserNotifyEnabled(false, { homeDir: home });
    expect(r.previous).toBe(true);
    const after = JSON.parse(fs.readFileSync(r.path, 'utf8')) as Record<string, unknown>;
    expect(after.enabled).toBe(false);
    expect(after.onDone).toBe(false); // 写前读保留
    expect(after.minDurationMs).toBe(5000);
  });

  it('文件不存在时创建并写 enabled；previous 视为默认 true', () => {
    const home = tmpHome();
    const r = updateUserNotifyEnabled(false, { homeDir: home });
    expect(r.previous).toBe(true);
    const after = JSON.parse(fs.readFileSync(userNotifyConfigPath(home), 'utf8')) as Record<string, unknown>;
    expect(after.enabled).toBe(false);
  });

  it('enabled 缺失时 previous 视为默认 true；写 false 后再次 enable 读到 false', () => {
    const home = tmpHome();
    const first = updateUserNotifyEnabled(false, { homeDir: home });
    expect(first.previous).toBe(true);
    const second = updateUserNotifyEnabled(true, { homeDir: home });
    expect(second.previous).toBe(false);
  });

  it('既有文件坏 JSON 时拒绝写入（宁可不写也不覆盖用户文件）', () => {
    const home = tmpHome();
    const file = path.join(home, '.delta', 'notify.json');
    fs.writeFileSync(file, '{broken');
    expect(() => updateUserNotifyEnabled(false, { homeDir: home })).toThrow(/无法解析/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{broken'); // 原样保留
  });
});
