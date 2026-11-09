/**
 * F-58 Router–Worker 调度层：类型定义（设计稿 §3/§7）。
 * Router = kind='router' 的普通会话（工具集收窄到 dispatch_task/task_status），
 * Worker = 每任务临时创建、终态即封存的独立会话。本目录不 import server/（依赖方向红线）。
 *
 * 【术语锚点】本模块的 Task 指的是 **委派任务（Delegation）**（`worker_tasks` 表，
 * 见 docs/architecture-glossary.md §4），不是 session/tasks.ts 的 Plan 节点任务
 * （`tasks` 表，glossary §3），也不是 cron 定时任务（glossary §5）。
 */

/** 任务状态机（设计稿 §7.4）。终态 done/failed/canceled 不可回退；needs_decision 非终态、不占并发槽位。 */
export type WorkerTaskStatus = 'draft' | 'queued' | 'preflight' | 'running' | 'needs_decision' | 'done' | 'failed' | 'canceled';

export type TerminalTaskStatus = 'done' | 'failed' | 'canceled';

/** 失败归类（§7.1 failure_kind）。watchdog_l2 = 看门狗越界击杀（不重试）。 */
export type FailureKind = 'preflight' | 'runtime' | 'watchdog_l2' | 'aborted' | 'canceled';

/** 产物引用（裁决 Q2：路径 + result_summary 双轨，不传对话摘要/产物全文）。 */
export interface TaskArtifact {
  kind: 'file' | 'session' | 'note';
  ref: string;
}

/** dispatch_task 入参与手工建任务的共同 body（设计稿 §7.5）。 */
export interface DispatchRequest {
  title: string;
  /** 派单原文 = Worker 首条用户消息 */
  goal: string;
  /** 完成条件；NULL = 由 Router 在 title 里写清 */
  acceptance?: string | null;
  /** 仅 UI 标签，不进 prompt（§1.4） */
  role_label?: string | null;
  /** NULL = 内置引擎；'cli:*' / 'acp:*' = 外部 agent。派单后不可变（§7.5 硬约束 2） */
  executor?: string | null;
  permission_mode?: 'plan' | 'default' | 'yolo';
  priority?: number;
  /** 依赖任务 id：存在未终态项时不派发（§7.4） */
  depends_on?: string[];
}

/** preflight 结果（§6④）：三条失败路径（adapter 解析不到 / probe 失败 / 只读档不支持）都显式，禁止静默重试。 */
export interface PreflightResult {
  ok: boolean;
  /** 失败原因机器码（preflight 用），写 decision_json 供裁决 */
  reason?: string;
  /** 人类可读描述 */
  message?: string;
}

/** worker_tasks 行（与 v7 DDL 一一对应）。 */
export interface WorkerTaskRow {
  id: string;
  project_id: string;
  router_session_id: string;
  title: string;
  goal: string;
  acceptance: string | null;
  role_label: string | null;
  executor: string | null;
  permission_mode: string;
  status: WorkerTaskStatus;
  priority: number;
  /** JSON 数组：task id */
  depends_on: string;
  /** JSON 数组：TaskArtifact */
  artifacts: string;
  worker_session_id: string | null;
  result_summary: string | null;
  failure_kind: FailureKind | null;
  decision_json: string | null;
  watchdog_flag: 'suspect' | null;
  attempt: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
}

/** DTO 投影（HTTP / Web 消费）：JSON 字段解析、金额永不入内（从 usage 按 session_id 聚合）。 */
export interface WorkerTaskView {
  id: string;
  project_id: string;
  router_session_id: string;
  title: string;
  goal: string;
  acceptance: string | null;
  role_label: string | null;
  executor: string | null;
  permission_mode: string;
  status: WorkerTaskStatus;
  priority: number;
  depends_on: string[];
  artifacts: TaskArtifact[];
  worker_session_id: string | null;
  result_summary: string | null;
  failure_kind: FailureKind | null;
  /** decision_json 解析结果；结构由裁决场景定义（T4 decision 端点落地） */
  decision: unknown;
  watchdog_flag: 'suspect' | null;
  attempt: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
}

export type InboxKind = 'task_done' | 'task_failed' | 'needs_decision' | 'digest';

/** 静默三级（§10）：成功一律 silent；batch 由 dispatcher 自动触发播报；interrupt 立即播报 + Web 红点。 */
export type InboxSeverity = 'silent' | 'batch' | 'interrupt';

/** task_inbox 行（§7.1）。delivered_at NULL = 未送达；ack_at = 用户读过（与送达语义分开）。 */
export interface InboxItem {
  id: number;
  router_session_id: string;
  /** NULL = 会话级提示（如用量概览） */
  task_id: string | null;
  kind: InboxKind;
  severity: InboxSeverity;
  payload: unknown;
  created_at: number;
  delivered_at: number | null;
  ack_at: number | null;
}
