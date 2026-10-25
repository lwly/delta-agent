/**
 * F-33 桌面通知 —— DesktopNotifier（设计 §2/§4）。
 *
 * 平台后端（全部系统自带，零 npm 依赖）：
 *  - macOS   `osascript -e 'display notification "<body>" with title "<title>"'`
 *  - Windows `powershell.exe` + System.Windows.Forms.NotifyIcon.ShowBalloonTip（Win10+ 呈现为 toast）
 *  - Linux   `notify-send <title> <body>`（best-effort 附带支持）
 *  - 其它    no-op
 *
 * 发送语义：fire-and-forget——spawn(detached + unref)、stdio ignore、10s 超时强杀、
 * 一切错误静默吞掉（AC-7：通知失败绝不影响任务主流程）。
 * platform / runner 可注入（测试伪造，不真发系统通知）。
 */
import { spawn } from 'node:child_process';
import type { Notifier, NotifyConfig } from './types.js';
import { loadNotifyConfig } from './config.js';

/** 通知标题统一前缀（与命令名一致，用户一眼知道是谁在通知） */
const NOTIFY_TITLE = 'delta-agent';

/** 正文最大长度（系统通知面板展示差，且降低转义风险） */
const MAX_BODY_LENGTH = 200;

/** 发送超时：超时强杀子进程，防止挂死的 osascript/powershell 拖住资源 */
const SEND_TIMEOUT_MS = 10_000;

/** 缺省 runner：spawn detached + unref（父进程退出后子进程仍可完成弹窗） */
function defaultRunner(cmd: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      });
      child.unref();
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // 强杀失败无需处理
        }
        resolve();
      }, timeoutMs);
      child.once('error', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    } catch {
      resolve(); // spawn 失败静默（AC-7）
    }
  });
}

export interface DesktopNotifierOptions {
  /** 项目根（项目级配置 `.delta/notify.json` 的查找基准；缺省 process.cwd()） */
  projectRoot?: string;
  /** 用户主目录（缺省 os.homedir()） */
  homeDir?: string;
  /** 显式传入生效配置（缺省自动加载两级文件） */
  config?: NotifyConfig;
  /** 平台注入（缺省 process.platform；测试用） */
  platform?: NodeJS.Platform;
  /** 发送函数注入（缺省 spawn；测试捕获命令断言，不真发） */
  runner?: (cmd: string, args: string[], timeoutMs: number) => Promise<void>;
}

export interface NotifyCommand {
  cmd: string;
  args: string[];
}

/**
 * 桌面通知器：实现 Notifier 接口，两个方法都先做开关/门槛判定再发送。
 */
export class DesktopNotifier implements Notifier {
  readonly config: NotifyConfig;
  private readonly platform: NodeJS.Platform;
  private readonly runner: (cmd: string, args: string[], timeoutMs: number) => Promise<void>;

  constructor(opts: DesktopNotifierOptions = {}) {
    this.config =
      opts.config ??
      loadNotifyConfig({ projectRoot: opts.projectRoot ?? process.cwd(), homeDir: opts.homeDir }).config;
    this.platform = opts.platform ?? process.platform;
    this.runner = opts.runner ?? defaultRunner;
  }

  // ── Notifier 接口 ───────────────────────────────────────────────────────

  /** 任务结束通知：enabled / onDone / minDurationMs 三重判定（D3：只打扰"长任务"） */
  notifyDone(info: { status: string; durationMs: number; summary?: string }): void {
    const cfg = this.config;
    if (!cfg.enabled || !cfg.onDone) return;
    if (info.durationMs < cfg.minDurationMs) return;
    const duration = formatDuration(info.durationMs);
    let body: string;
    if (info.status === 'completed') {
      body = `任务完成（${duration}）`;
    } else {
      body = `任务结束：${info.status}（${duration}）`;
    }
    const summary = sanitizeBody(info.summary);
    if (summary) body += `：${summary}`;
    void this.deliver(`${NOTIFY_TITLE} 任务结束`, body);
  }

  /** 需人工确认通知：等待人是天然低频事件，不受 minDurationMs 约束 */
  notifyConfirm(info: { tool: string; reason: string }): void {
    const cfg = this.config;
    if (!cfg.enabled || !cfg.onConfirm) return;
    const reason = sanitizeBody(info.reason);
    const body = `工具 ${info.tool} 等待确认${reason ? `：${reason}` : ''}`;
    void this.deliver(`${NOTIFY_TITLE} 需要确认`, body);
  }

  // ── 发送 ────────────────────────────────────────────────────────────────

  /**
   * 构造平台命令并发送（fire-and-forget）。无可用后端（未知平台）时静默返回。
   * 供 `delta notify test` 复用；返回发送 Promise 便于 CLI 等待结果（仍不抛错）。
   */
  deliver(title: string, body: string): Promise<void> {
    const command = buildNotifyCommand(this.platform, title, body);
    if (!command) return Promise.resolve();
    try {
      return this.runner(command.cmd, command.args, SEND_TIMEOUT_MS).catch(() => undefined);
    } catch {
      // runner 同步抛错也吞掉（AC-7：通知失败绝不影响主流程）
      return Promise.resolve();
    }
  }

  /** 当前平台是否有可用通知后端（status 展示用）。 */
  backendName(): string {
    switch (this.platform) {
      case 'darwin':
        return 'macOS 通知中心（osascript）';
      case 'win32':
        return 'Windows 通知（PowerShell BalloonTip）';
      case 'linux':
        return '桌面通知（notify-send）';
      default:
        return `无（平台 ${this.platform} 暂不支持，静默关闭）`;
    }
  }
}

// ── 平台命令构造（设计 §4，含字面量转义）────────────────────────────────────

/**
 * 按平台构造通知命令；平台不支持时返回 null。
 * 纯函数（无 IO），单测直接断言 cmd/args。
 */
export function buildNotifyCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
): NotifyCommand | null {
  switch (platform) {
    case 'darwin': {
      // AppleScript 字符串字面量：反斜杠与双引号转义
      const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return {
        cmd: 'osascript',
        args: ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`],
      };
    }
    case 'win32': {
      // PowerShell 单引号字面量：单引号翻倍转义；Sleep+Dispose 让临时托盘图标收敛
      const esc = (s: string): string => s.replace(/'/g, "''");
      const script =
        `Add-Type -AssemblyName System.Windows.Forms; ` +
        `Add-Type -AssemblyName System.Drawing; ` +
        `$n = New-Object System.Windows.Forms.NotifyIcon; ` +
        `$n.Icon = [System.Drawing.SystemIcons]::Information; ` +
        `$n.Visible = $true; ` +
        `$n.ShowBalloonTip(8000, '${esc(title)}', '${esc(body)}', ` +
        `[System.Windows.Forms.ToolTipIcon]::Info); ` +
        `Start-Sleep -Milliseconds 500; $n.Dispose()`;
      return { cmd: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] };
    }
    case 'linux':
      return { cmd: 'notify-send', args: [title, body] };
    default:
      return null;
  }
}

// ── 文本清洗（D8）───────────────────────────────────────────────────────────

/** 正文清洗：换行折叠为空格 + 截断（AppleScript/PowerShell 字面量不可含裸换行）。 */
export function sanitizeBody(text: string | undefined, max = MAX_BODY_LENGTH): string {
  if (!text) return '';
  const flat = text.replace(/\s*\r?\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** 时长人类可读（< 60s 秒；< 1h 分；否则 时+分）。 */
function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60 > 0 ? `${sec % 60}s` : ''}`;
  const hour = Math.floor(min / 60);
  return `${hour}h${min % 60}m`;
}

/** 便捷构造：按两级配置文件创建通知器（三端入口复用；未传 config 时自动加载）。 */
export function createDesktopNotifier(opts: DesktopNotifierOptions = {}): DesktopNotifier {
  return new DesktopNotifier(opts);
}
