/**
 * F-41 运行日志 —— RunLog / createRunFileLogger 单测：
 * 环形缓冲 / tail 顺序与裁剪 / 订阅扇出与退订 / 文件落盘与按日文件名 / 过期清理 /
 * 写失败静默 / 独立追加写入器。
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { RunLog, createRunFileLogger } from '../src/logging/logger.js';

function fixedNow(ms = 0): () => Date {
  return () => new Date(Date.UTC(2026, 9, 28, 8, 0, 0, ms));
}

describe('F-41 RunLog', () => {
  it('append → tail 时间正序；环形缓冲截断保留最新', () => {
    let tick = 0;
    const log = new RunLog({ ringSize: 5, now: () => new Date(Date.UTC(2026, 9, 28, 8, 0, 0, tick++)) });
    for (let i = 0; i < 8; i++) log.append('info', 'hub', `m${i}`);
    const tail = log.tail();
    expect(tail).toHaveLength(5);
    expect(tail[0]!.message).toBe('m3');
    expect(tail[4]!.message).toBe('m7');
  });

  it('tail limit 裁剪；缺省 200；非法 limit 归一化', () => {
    const log = new RunLog({ ringSize: 10, now: fixedNow() });
    for (let i = 0; i < 10; i++) log.append('info', 'serve', `m${i}`);
    expect(log.tail(3)).toHaveLength(3);
    expect(log.tail(-1)).toHaveLength(0);
    expect(log.tail(9999)).toHaveLength(10);
  });

  it('subscribe 扇出 + 退订；订阅者抛错不影响其他订阅者', () => {
    const log = new RunLog({ now: fixedNow() });
    const a: string[] = [];
    const b: string[] = [];
    const unA = log.subscribe((e) => a.push(e.message));
    log.subscribe((e) => {
      b.push(e.message);
      throw new Error('subscriber boom');
    });
    log.append('warn', 'hub', 'hello');
    unA();
    log.append('warn', 'hub', 'world');
    expect(a).toEqual(['hello']);
    expect(b).toEqual(['hello', 'world']);
  });

  it('sessionId 携带与 format 单行格式', () => {
    const log = new RunLog({ now: fixedNow() });
    log.append('error', 'hub', '任务异常', 'sid-123');
    const e = log.tail(1)[0]!;
    expect(e.sessionId).toBe('sid-123');
    expect(RunLog.format(e)).toBe('2026-10-28T08:00:00.000Z [ERROR] [hub] [sid-123] 任务异常');
    log.append('info', 'serve', '无会话');
    expect(RunLog.format(log.tail(1)[0]!)).toBe('2026-10-28T08:00:00.000Z [INFO] [serve] 无会话');
  });

  it('落盘：写入注入目录，缺省按日文件名 serve-YYYYMMDD.log', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-log-'));
    const log = new RunLog({ dir, now: fixedNow() });
    log.append('info', 'serve', 'line one');
    log.append('error', 'hub', 'line two', 's1');
    const files = await fs.readdir(dir);
    expect(files).toEqual(['serve-20261028.log']);
    const text = await fs.readFile(path.join(dir, files[0]!), 'utf8');
    expect(text).toContain(' [INFO] [serve] line one');
    expect(text).toContain(' [ERROR] [hub] [s1] line two');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('固定 fileName 时不按日滚动', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-log-'));
    const log = new RunLog({ dir, fileName: 'custom.log', now: fixedNow() });
    log.append('info', 'serve', 'x');
    expect(await fs.readdir(dir)).toEqual(['custom.log']);
  });

  it('过期清理：mtime 超过 retentionDays 的 .log 删除，新文件与非 .log 保留', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-log-'));
    const oldLog = path.join(dir, 'serve-20200101.log');
    await fs.writeFile(oldLog, 'old\n');
    // 实现按 mtime 判过期（不是文件名日期）：把旧文件 mtime 拨回 2020 年
    const old = new Date('2020-01-01T00:00:00Z');
    await fs.utimes(oldLog, old, old);
    await fs.writeFile(path.join(dir, 'serve-20200102.log.bak'), 'not a log\n');
    const log = new RunLog({ dir, retentionDays: 14, now: fixedNow() });
    log.append('info', 'serve', 'fresh');
    const files = await fs.readdir(dir);
    expect(files).not.toContain('serve-20200101.log');
    expect(files).toContain('serve-20200102.log.bak'); // 非 .log 不动
    expect(files).toContain('serve-20261028.log');
  });

  it('retentionDays: 0 不清理；目录不存在时静默', () => {
    expect(() => new RunLog({ dir: '/nonexistent-dir/yz-log', retentionDays: 0, now: fixedNow() })).not.toThrow();
  });

  it('不传 dir：仅内存 + 订阅，不落盘', () => {
    const log = new RunLog({ now: fixedNow() });
    log.append('info', 'serve', 'mem only');
    expect(log.tail(1)).toHaveLength(1);
  });
});

describe('F-41 createRunFileLogger', () => {
  it('追加写同一文件；自动建目录；path 回显', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-runlog-'));
    const name = 'run-x.log';
    const w = createRunFileLogger(dir, name);
    w.log('first');
    w.log('second');
    const text = await fs.readFile(w.path, 'utf8');
    expect(text).toBe('first\nsecond\n');

    // 自动建目录：不存在的多级目录也能写
    const nested = path.join(dir, 'a', 'b');
    const w2 = createRunFileLogger(nested, 'n.log');
    w2.log('nested');
    expect(await fs.readFile(path.join(nested, 'n.log'), 'utf8')).toBe('nested\n');
  });

  it('不可写路径静默失败（不抛错）', () => {
    const w = createRunFileLogger('/proc/definitely/not-writable', 'x.log');
    expect(() => w.log('nope')).not.toThrow();
  });
});
