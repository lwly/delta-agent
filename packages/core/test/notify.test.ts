/**
 * F-33 桌面通知 —— DesktopNotifier 单测（设计 §8）：
 * 三平台命令构造与转义、未知平台 no-op、enabled/onDone/onConfirm/minDurationMs 开关、
 * 正文清洗（换行折叠 + 截断）。runner 全部伪造，不真发系统通知。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFY_CONFIG,
  type NotifyConfig,
} from '../src/notify/types.js';
import { buildNotifyCommand, createDesktopNotifier, DesktopNotifier, sanitizeBody } from '../src/notify/notifier.js';

type Sent = { cmd: string; args: string[]; timeoutMs: number };

/** 捕获发送命令的伪造 runner */
function fakeRunner(sent: Sent[]) {
  return (cmd: string, args: string[], timeoutMs: number): Promise<void> => {
    sent.push({ cmd, args, timeoutMs });
    return Promise.resolve();
  };
}

function makeNotifier(patch: Partial<NotifyConfig>, platform: NodeJS.Platform, sent: Sent[]): DesktopNotifier {
  return new DesktopNotifier({
    config: { ...DEFAULT_NOTIFY_CONFIG, ...patch },
    platform,
    runner: fakeRunner(sent),
  });
}

describe('F-33 平台命令构造（buildNotifyCommand）', () => {
  it('darwin：osascript display notification，AppleScript 双引号与反斜杠转义', () => {
    const c = buildNotifyCommand('darwin', '标题 "带引号"', '正文 \\ 含"引号"');
    expect(c).not.toBeNull();
    expect(c!.cmd).toBe('osascript');
    expect(c!.args[0]).toBe('-e');
    expect(c!.args[1]).toBe(
      'display notification "正文 \\\\ 含\\"引号\\"" with title "标题 \\"带引号\\""',
    );
  });

  it('win32：powershell BalloonTip，单引号翻倍转义', () => {
    const c = buildNotifyCommand('win32', "it's", "body 'quoted'");
    expect(c!.cmd).toBe('powershell.exe');
    expect(c!.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', expect.any(String)]);
    const script = c!.args[3]!;
    expect(script).toContain('ShowBalloonTip');
    expect(script).toContain("'it''s'");
    expect(script).toContain("'body ''quoted'''");
  });

  it('linux：notify-send <title> <body>', () => {
    const c = buildNotifyCommand('linux', 't', 'b');
    expect(c).toEqual({ cmd: 'notify-send', args: ['t', 'b'] });
  });

  it('未知平台返回 null（no-op）', () => {
    expect(buildNotifyCommand('freebsd' as NodeJS.Platform, 't', 'b')).toBeNull();
  });
});

describe('F-33 notifyDone 开关与门槛', () => {
  const DONE = { status: 'completed', durationMs: 60_000, summary: '做完了' };

  it('默认配置：超过门槛的完成 → 发送，正文含状态与耗时', () => {
    const sent: Sent[] = [];
    makeNotifier({}, 'darwin', sent).notifyDone(DONE);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.cmd).toBe('osascript');
    expect(sent[0]!.args[1]).toContain('任务完成');
    expect(sent[0]!.args[1]).toContain('1m');
    expect(sent[0]!.args[1]).toContain('做完了');
  });

  it('低于 minDurationMs 不发送（防噪：只打扰长任务）', () => {
    const sent: Sent[] = [];
    makeNotifier({}, 'darwin', sent).notifyDone({ ...DONE, durationMs: 29_999 });
    expect(sent).toHaveLength(0);
  });

  it('enabled=false / onDone=false 不发送', () => {
    const sent1: Sent[] = [];
    makeNotifier({ enabled: false }, 'darwin', sent1).notifyDone(DONE);
    expect(sent1).toHaveLength(0);
    const sent2: Sent[] = [];
    makeNotifier({ onDone: false }, 'darwin', sent2).notifyDone(DONE);
    expect(sent2).toHaveLength(0);
  });

  it('失败/中断状态正文带状态词；summary 缺省可发送', () => {
    const sent: Sent[] = [];
    makeNotifier({}, 'darwin', sent).notifyDone({ status: 'failed', durationMs: 120_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args[1]).toContain('failed');
  });

  it('未知平台下超过门槛也不发送（后端 no-op）', () => {
    const sent: Sent[] = [];
    makeNotifier({}, 'freebsd' as NodeJS.Platform, sent).notifyDone(DONE);
    expect(sent).toHaveLength(0);
  });
});

describe('F-33 notifyConfirm 开关', () => {
  it('默认配置：确认卡出现 → 发送，正文含工具名与原因', () => {
    const sent: Sent[] = [];
    makeNotifier({}, 'darwin', sent).notifyConfirm({ tool: 'run_command', reason: 'rm -rf 危险命令' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.args[1]).toContain('run_command');
    expect(sent[0]!.args[1]).toContain('rm -rf 危险命令');
  });

  it('不受 minDurationMs 约束（等待人是低频事件）', () => {
    const sent: Sent[] = [];
    makeNotifier({ minDurationMs: 3_600_000 }, 'darwin', sent).notifyConfirm({ tool: 'write_file', reason: 'r' });
    expect(sent).toHaveLength(1);
  });

  it('enabled=false / onConfirm=false 不发送', () => {
    const sent1: Sent[] = [];
    makeNotifier({ enabled: false }, 'darwin', sent1).notifyConfirm({ tool: 't', reason: 'r' });
    expect(sent1).toHaveLength(0);
    const sent2: Sent[] = [];
    makeNotifier({ onConfirm: false }, 'darwin', sent2).notifyConfirm({ tool: 't', reason: 'r' });
    expect(sent2).toHaveLength(0);
  });
});

describe('F-33 正文清洗与发送语义', () => {
  it('sanitizeBody：换行折叠 + 截断 200 字符', () => {
    expect(sanitizeBody('a\nb\r\nc')).toBe('a b c');
    const long = 'x'.repeat(300);
    const out = sanitizeBody(long);
    expect(out).toHaveLength(201); // 200 + 省略号
    expect(out.endsWith('…')).toBe(true);
    expect(sanitizeBody(undefined)).toBe('');
  });

  it('发送超时参数为 10s；runner 抛错被吞掉（fire-and-forget 语义）', async () => {
    const sent: Sent[] = [];
    const n = makeNotifier({}, 'darwin', sent);
    await n.deliver('t', 'b');
    expect(sent[0]!.timeoutMs).toBe(10_000);

    const throwing = new DesktopNotifier({
      config: DEFAULT_NOTIFY_CONFIG,
      platform: 'darwin',
      runner: () => Promise.reject(new Error('boom')),
    });
    await expect(throwing.deliver('t', 'b')).resolves.toBeUndefined();
  });

  it('notifyDone/notifyConfirm 永不 throw（runner 同步抛错也被吞掉）', () => {
    const n = new DesktopNotifier({
      config: DEFAULT_NOTIFY_CONFIG,
      platform: 'darwin',
      runner: () => {
        throw new Error('sync boom');
      },
    });
    expect(() => n.notifyDone({ status: 'completed', durationMs: 60_000 })).not.toThrow();
    expect(() => n.notifyConfirm({ tool: 't', reason: 'r' })).not.toThrow();
  });

  it('createDesktopNotifier：未传 config 时自动加载（smoke）', () => {
    const n = createDesktopNotifier({
      projectRoot: process.cwd(),
      platform: 'linux',
      runner: () => Promise.resolve(),
    });
    expect(n.config).toEqual(DEFAULT_NOTIFY_CONFIG);
    expect(n.backendName()).toContain('notify-send');
  });
});
