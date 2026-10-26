/**
 * F-33 桌面通知 —— Electron 宿主适配（方案 B 桌面化决策 3：首版即原生通知）。
 *
 * 实现 core 的 Notifier 接口，用 Electron 原生 Notification 替换 osascript/powershell
 * spawn（通知来源显示为宿主 App 而非"脚本编辑器"）。core/notify 不做任何改动——
 * 通知仍是注入点替换（SessionHub.notify 由 createServeRuntime 的 opts.notify 注入）。
 *
 * 门槛语义与 DesktopNotifier 对齐（enabled / onDone / onConfirm / minDurationMs），
 * 配置继续复用两级文件（~/.delta/notify.json + .delta/notify.json）。
 * 发送语义：fire-and-forget——一切错误静默吞掉（AC-7：通知失败绝不影响主流程）。
 * mac 未签名构建下通知可能被通知中心静默丢弃（签名挂起项）；发送失败静默，无副作用。
 */
import { Notification, app } from 'electron';
import {
  loadNotifyConfig,
  sanitizeBody,
  type Notifier,
  type NotifyConfig,
} from '@delta/core';

/** 通知标题统一前缀（与 DesktopNotifier 一致） */
const NOTIFY_TITLE = 'delta-agent';

export interface ElectronNotifierOptions {
  /**
   * 项目根（项目级配置 .delta/notify.json 的查找基准）。
   * 桌面端缺省传 app.getPath('home') —— 仅用户级配置生效（无 cwd 项目概念）。
   */
  projectRoot?: string;
  /** 显式传入生效配置（缺省自动加载两级文件） */
  config?: NotifyConfig;
}

export class ElectronNotifier implements Notifier {
  readonly config: NotifyConfig;

  constructor(opts: ElectronNotifierOptions = {}) {
    this.config =
      opts.config ??
      loadNotifyConfig({ projectRoot: opts.projectRoot ?? app.getPath('home') }).config;
  }

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
    this.deliver(`${NOTIFY_TITLE} 任务结束`, body);
  }

  /** 需人工确认通知：等待人是天然低频事件，不受 minDurationMs 约束 */
  notifyConfirm(info: { tool: string; reason: string }): void {
    const cfg = this.config;
    if (!cfg.enabled || !cfg.onConfirm) return;
    const reason = sanitizeBody(info.reason);
    const body = `工具 ${info.tool} 等待确认${reason ? `：${reason}` : ''}`;
    this.deliver(`${NOTIFY_TITLE} 需要确认`, body);
  }

  /** Electron 原生通知（fire-and-forget；未初始化/失败/无后端均静默） */
  deliver(title: string, body: string): void {
    try {
      if (!Notification.isSupported()) return;
      new Notification({ title, body }).show();
    } catch {
      // 静默（AC-7）
    }
  }
}

/** 时长人类可读（与 DesktopNotifier 同口径：< 60s 秒；< 1h 分；否则 时+分） */
function formatDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${sec % 60 > 0 ? `${sec % 60}s` : ''}`;
  const hour = Math.floor(min / 60);
  return `${hour}h${min % 60}m`;
}
