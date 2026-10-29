/**
 * F-50 自动更新单测（AC-50-5 为主）：
 *  - 版本比较 / 降级拒绝（version.ts）
 *  - 配置加载宽松归一化 + 状态原子回写（config.ts）
 *  - 更新源 URL 解析 / 检查结果归一化 / 失败抛错（checker.ts）
 *  - 启动检查节流与状态回写（maybeCheckOnStartup）
 *  - SEA 替换：下载落盘、原子换入、失败回滚（install.ts）
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_UPDATE_CONFIG,
  applyBinarySwap,
  checkForUpdate,
  compareVersions,
  downloadUpdateAsset,
  isNewerVersion,
  loadUpdateConfig,
  maybeCheckOnStartup,
  parseVersion,
  resolveSourceUrl,
  updateUpdateState,
  userUpdateConfigPath,
  type FetchLike,
} from '../src/update/index.js';
import type { RunLogSink, LogLevel } from '../src/logging/logger.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'delta-update-home-'));
}

const homes: string[] = [];
afterEach(() => {
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ── 版本比较 ────────────────────────────────────────────────────────────────

describe('parseVersion / compareVersions', () => {
  it('解析 v 前缀与预发布后缀；非法输入返回 null', () => {
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseVersion('1.2.3-beta.1')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: 'beta.1' });
    expect(parseVersion('abc')).toBeNull();
    expect(parseVersion('1.2')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });

  it('逐段比较；四段等非标准输入不可比较', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.3.0')).toBeNull();
    expect(compareVersions('0.1.0', '0.1.10')).toBe(-1);
  });

  it('预发布口径：正式版 > 同号预发布；数字段按数值比较', () => {
    expect(compareVersions('1.2.3', '1.2.3-beta.1')).toBe(1);
    expect(compareVersions('1.2.3-beta.1', '1.2.3-beta.2')).toBe(-1);
    expect(compareVersions('1.2.3-beta.2', '1.2.3-beta.10')).toBe(-1);
    expect(compareVersions('1.2.3-beta.1', '1.2.3-beta.1')).toBe(0);
  });

  it('任一版本非法 → 无法比较（null）', () => {
    expect(compareVersions('1.2.3', 'not-a-version')).toBeNull();
    expect(compareVersions('', '1.2.3')).toBeNull();
  });

  it('降级拒绝（AC-50-5）：latest 不严格大于 current 一律 false', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false); // 降级
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false); // 相等
    expect(isNewerVersion('v0.2.0', '0.1.0')).toBe(true); // v 前缀
    expect(isNewerVersion('garbage', '0.1.0')).toBe(false); // 不可比较 → 拒绝
  });
});

// ── 配置读写 ────────────────────────────────────────────────────────────────

describe('loadUpdateConfig / updateUpdateState', () => {
  it('文件缺失返回纯默认值', () => {
    const home = tmpHome();
    const { config, warnings } = loadUpdateConfig(home);
    expect(config).toEqual(DEFAULT_UPDATE_CONFIG);
    expect(warnings).toEqual([]);
  });

  it('合法配置生效；非法值降级默认 + warning；永不 throw', () => {
    const home = tmpHome();
    const file = userUpdateConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      enabled: false,
      intervalMs: 60_000,
      source: { type: 'github', repo: 'foo/bar' },
      lastCheckAt: '2026-01-01T00:00:00Z',
    }));
    const { config, warnings } = loadUpdateConfig(home);
    expect(config.enabled).toBe(false);
    expect(config.intervalMs).toBe(60_000);
    expect(config.source).toEqual({ type: 'github', repo: 'foo/bar' });
    expect(config.lastCheckAt).toBe('2026-01-01T00:00:00Z');
    expect(warnings).toEqual([]);

    fs.writeFileSync(file, JSON.stringify({ enabled: 'yes', intervalMs: 1, source: { type: 'ftp' } }));
    const bad = loadUpdateConfig(home);
    expect(bad.config.enabled).toBe(true);
    expect(bad.config.intervalMs).toBe(DEFAULT_UPDATE_CONFIG.intervalMs);
    expect(bad.config.source.type).toBe('gitee');
    expect(bad.warnings.length).toBeGreaterThanOrEqual(3);

    fs.writeFileSync(file, 'not json{');
    expect(loadUpdateConfig(home).config.enabled).toBe(true);
  });

  it('updateUpdateState 只改状态字段、其它原样保留；坏 JSON 拒写', () => {
    const home = tmpHome();
    const file = userUpdateConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ enabled: false, custom: 'keep' }));

    updateUpdateState({ lastCheckAt: '2026-10-29T00:00:00Z', lastSeenVersion: '0.2.0' }, { homeDir: home });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.enabled).toBe(false);
    expect(raw.custom).toBe('keep');
    expect(raw.lastCheckAt).toBe('2026-10-29T00:00:00Z');
    expect(raw.lastSeenVersion).toBe('0.2.0');

    fs.writeFileSync(file, 'broken{');
    expect(() => updateUpdateState({ lastCheckAt: 'x' }, { homeDir: home })).toThrow(/无法解析/);
    expect(fs.readFileSync(file, 'utf8')).toBe('broken{');
  });
});

// ── 更新源与检查 ────────────────────────────────────────────────────────────

describe('resolveSourceUrl', () => {
  it('三种源解析正确；非法 repo / 缺 url 抛错', () => {
    expect(resolveSourceUrl({ type: 'github', repo: 'a/b' })).toBe('https://api.github.com/repos/a/b/releases/latest');
    expect(resolveSourceUrl({ type: 'gitee', repo: 'a/b' })).toBe('https://gitee.com/api/v5/repos/a/b/releases/latest');
    expect(resolveSourceUrl({ type: 'json', url: 'https://x/y.json' })).toBe('https://x/y.json');
    expect(() => resolveSourceUrl({ type: 'gitee', repo: 'nope' })).toThrow(/owner\/repo/);
    expect(() => resolveSourceUrl({ type: 'json' })).toThrow(/url/);
  });
});

function jsonResponse(body: unknown): FetchLike {
  return async () => new Response(JSON.stringify(body), { status: 200 });
}

const RELEASE = {
  tag_name: 'v0.2.0',
  html_url: 'https://gitee.com/lwly/delta-agent/releases/v0.2.0',
  body: 'release notes',
  assets: [
    { name: 'delta-darwin-arm64', browser_download_url: 'https://example.com/delta-darwin-arm64' },
    { name: 'ignored', browser_download_url: null },
  ],
};

describe('checkForUpdate', () => {
  it('归一化结果：剥 v 前缀、资产过滤、降级判定', async () => {
    const r = await checkForUpdate({ currentVersion: '0.1.0', source: { type: 'gitee', repo: 'lwly/delta-agent' }, fetcher: jsonResponse(RELEASE) });
    expect(r).toMatchObject({
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      hasUpdate: true,
      releaseUrl: RELEASE.html_url,
      notes: 'release notes',
    });
    expect(r.assets).toEqual([{ name: 'delta-darwin-arm64', downloadUrl: 'https://example.com/delta-darwin-arm64' }]);
  });

  it('latest 更旧 → hasUpdate false（降级拒绝）', async () => {
    const r = await checkForUpdate({ currentVersion: '0.3.0', source: { type: 'gitee', repo: 'a/b' }, fetcher: jsonResponse(RELEASE) });
    expect(r.hasUpdate).toBe(false);
  });

  it('自定义 JSON 源：version 字段可用', async () => {
    const r = await checkForUpdate({
      currentVersion: '0.1.0',
      source: { type: 'json', url: 'https://x/latest.json' },
      fetcher: jsonResponse({ version: '0.2.0', url: 'https://x/latest.json' }),
    });
    expect(r.latestVersion).toBe('0.2.0');
    expect(r.hasUpdate).toBe(true);
    expect(r.releaseUrl).toBe('https://x/latest.json');
  });

  it('HTTP 错误 / 坏结构抛错并留档（AC-50-4 留档由调用方注入 log 承接）', async () => {
    const fail: FetchLike = async () => new Response('nope', { status: 503 });
    const logs: string[] = [];
    const log: RunLogSink = { append: (level: LogLevel, _source: string, message: string) => logs.push(`${level}:${message}`) };
    await expect(checkForUpdate({ currentVersion: '0.1.0', source: { type: 'gitee', repo: 'a/b' }, fetcher: fail, log })).rejects.toThrow(/HTTP 503/);
    expect(logs[0]).toContain('warn');
    expect(logs[0]).toContain('HTTP 503');
    await expect(checkForUpdate({ currentVersion: '0.1.0', source: { type: 'gitee', repo: 'a/b' }, fetcher: jsonResponse({ foo: 1 }) })).rejects.toThrow(/版本号/);
  });
});

describe('maybeCheckOnStartup', () => {
  it('enabled=false 直接跳过（零网络请求）', async () => {
    const home = tmpHome();
    const file = userUpdateConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ enabled: false }));
    let calls = 0;
    const fetcher: FetchLike = async () => {
      calls++;
      return new Response('{}', { status: 200 });
    };
    const r = await maybeCheckOnStartup({ currentVersion: '0.1.0', homeDir: home, fetcher });
    expect(r).toEqual({ ran: false });
    expect(calls).toBe(0);
  });

  it('intervalMs 内跳过；到点发起检查并有更新时回写状态', async () => {
    const home = tmpHome();
    const file = userUpdateConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const now = 1_700_000_000_000;
    let fetcher: FetchLike = jsonResponse(RELEASE);

    // 刚检查过 → 跳过
    fs.writeFileSync(file, JSON.stringify({ lastCheckAt: new Date(now).toISOString() }));
    let r = await maybeCheckOnStartup({ currentVersion: '0.1.0', homeDir: home, fetcher, now: () => now });
    expect(r).toEqual({ ran: false });

    // 超过一周 → 检查并回写 lastCheckAt + lastSeenVersion
    r = await maybeCheckOnStartup({ currentVersion: '0.1.0', homeDir: home, fetcher, now: () => now + 8 * 24 * 60 * 60 * 1000 });
    expect(r).toEqual({ ran: true, hasUpdate: true, latestVersion: '0.2.0' });
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.lastSeenVersion).toBe('0.2.0');
    expect(Date.parse(raw.lastCheckAt)).toBe(now + 8 * 24 * 60 * 60 * 1000);

    // 无更新 → 只回写 lastCheckAt，lastSeenVersion 保持
    fetcher = jsonResponse({ ...RELEASE, tag_name: 'v0.1.0' });
    r = await maybeCheckOnStartup({ currentVersion: '0.1.0', homeDir: home, fetcher, now: () => now + 20 * 24 * 60 * 60 * 1000 });
    expect(r).toEqual({ ran: true, hasUpdate: false });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).lastSeenVersion).toBe('0.2.0');
  });

  it('检查失败静默：也回写 lastCheckAt（避免每次启动打必败请求），不 throw', async () => {
    const home = tmpHome();
    const fail: FetchLike = async () => new Response('down', { status: 500 });
    const r = await maybeCheckOnStartup({ currentVersion: '0.1.0', homeDir: home, fetcher: fail, now: () => 1_700_000_000_000 });
    expect(r).toEqual({ ran: true });
    expect(JSON.parse(fs.readFileSync(userUpdateConfigPath(home), 'utf8')).lastCheckAt).toBe('2023-11-14T22:13:20.000Z');
  });
});

// ── SEA 下载与替换 ──────────────────────────────────────────────────────────

describe('downloadUpdateAsset / applyBinarySwap', () => {
  it('下载落盘 + 可执行位；HTTP 失败清理半截文件并抛错', async () => {
    const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-update-dl-'));
    const body = Buffer.from('#!/bin/sh\necho new\n');
    const ok: FetchLike = async () => new Response(new Uint8Array(body), { status: 200 });
    const r = await downloadUpdateAsset('https://example.com/bin', destDir, { fetcher: ok });
    expect(r.bytes).toBe(body.length);
    expect(fs.statSync(r.file).mode & 0o755).toBe(0o755);
    expect(fs.readFileSync(r.file, 'utf8')).toBe(body.toString('utf8'));

    const fail: FetchLike = async () => new Response('nope', { status: 404 });
    await expect(downloadUpdateAsset('https://example.com/bin', destDir, { fetcher: fail })).rejects.toThrow(/下载更新包失败/);
    expect(fs.readdirSync(destDir).filter((f) => f.startsWith('delta-new-'))).toEqual([]);
  });

  it('原子换入：旧文件备份为 .bak；换入失败回滚旧二进制', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-update-swap-'));
    const execPath = path.join(dir, 'delta');
    fs.writeFileSync(execPath, 'old-binary');
    fs.writeFileSync(path.join(dir, 'new'), 'new-binary');

    const r = applyBinarySwap(path.join(dir, 'new'), execPath);
    expect(fs.readFileSync(execPath, 'utf8')).toBe('new-binary');
    expect(fs.readFileSync(r.backupPath, 'utf8')).toBe('old-binary');

    // 换入失败（下载文件缺失）→ 自动回滚旧二进制，不留中间态
    const execPath2 = path.join(dir, 'delta2');
    fs.writeFileSync(execPath2, 'old-binary');
    expect(() => applyBinarySwap(path.join(dir, 'missing'), execPath2)).toThrow();
    expect(fs.readFileSync(execPath2, 'utf8')).toBe('old-binary');
    expect(fs.existsSync(`${execPath2}.bak`)).toBe(false);
  });
});
