/**
 * F-33 桌面通知 —— 类型与默认值（设计 §2）。
 *
 * 通知是**纯旁路**能力：入口端（TUI App / SessionHub / headless-run）在
 * 「任务结束」「确认卡出现」两个时机调用 Notifier，引擎与工具零改动。
 * 发送失败绝不影响主流程（fire-and-forget，见 notifier.ts）。
 */

/** 通知触发类型：done = 任务结束；confirm = 等待人工确认 */
export type NotifyTrigger = 'done' | 'confirm';

/** F-33 生效配置（两级文件逐字段 merge 后的最终值） */
export interface NotifyConfig {
  /** 总开关（`delta notify enable/disable` 只改此字段） */
  enabled: boolean;
  /** 任务结束通知开关 */
  onDone: boolean;
  /** 确认卡通知开关（等待人是天然低频事件，不受 minDurationMs 约束） */
  onConfirm: boolean;
  /** done 通知的最短任务时长门槛（ms）：低于该值视为非"长任务"，不打扰 */
  minDurationMs: number;
}

/** 默认配置：默认开启——30s 门槛 + 确认低频使噪声可控；不满意 `delta notify disable` 一键关 */
export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  enabled: true,
  onDone: true,
  onConfirm: true,
  minDurationMs: 30_000,
};

/** 可 merge 的配置字段（配置校验/归一化的唯一事实来源） */
export const NOTIFY_MERGE_FIELDS = [
  'enabled',
  'onDone',
  'onConfirm',
  'minDurationMs',
] as const;

export type NotifyMergeField = (typeof NOTIFY_MERGE_FIELDS)[number];

/** 配置来源层（user = ~/.delta，project = .delta，与 sandbox.json 同构） */
export type NotifyConfigSource = 'user' | 'project';

export interface NotifyConfigWarning {
  source: NotifyConfigSource;
  field?: string;
  message: string;
}

/**
 * Notifier 接口（三端注入的最小面，测试可伪造）。
 * 两个方法均为 fire-and-forget：内部吞掉一切异常，永不 throw。
 */
export interface Notifier {
  /** 任务结束通知：内部检查 enabled / onDone / minDurationMs（不满足直接返回） */
  notifyDone(info: { status: string; durationMs: number; summary?: string }): void;
  /** 需人工确认通知：内部检查 enabled / onConfirm */
  notifyConfirm(info: { tool: string; reason: string }): void;
}

/** 空实现（测试 / 未注入时的语义兜底） */
export const noopNotifier: Notifier = {
  notifyDone: () => undefined,
  notifyConfirm: () => undefined,
};
