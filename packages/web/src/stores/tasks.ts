/**
 * F-58 任务台 store：当前项目 Worker 任务列表 + 未送达 inbox 的全部状态与动作（Pinia）。
 *
 * 设计（docs/design-f58-router-worker.md §10/§14、计划 T5b）：
 * - 数据源 = GET /api/projects/:id/worker-tasks + GET /api/projects/:id/inbox?delivered=0
 *   轮询（2s；服务端无增量事件，与 bgTasks 同口径：协议没有就不做假实时）
 * - watch(projectId) 项目切换/清空即重置轮询；过期响应丢弃防串台
 * - interruptCount = 未送达 interrupt 条数 → 任务台红点（AC8 Web 侧）
 * - 裁决/取消不做乐观状态机（红线）：端点成功后才 refresh；失败时列表保持服务端真值
 *
 * 【术语锚点】本 store 的 Task 指的是 **委派任务（worker_tasks，Delegation）的视图
 * 状态**（见 docs/architecture-glossary.md §4/§11-3），不是 Plan 节点任务（core
 * session/tasks.ts）也不是会话内后台命令（bgTasks.ts）。
 *
 * 架构收口 T5b：轮询机制抽至 composables/usePollingResource（watch→stop→refresh+
 * interval+切 id 清态+过期丢弃）；订阅 /api/projects/:id/activity/stream（T5a 端点）
 * 后轮询 2s→10s 降级，activity_changed 立即刷新，断线自动回 2s（useActivityStream）。
 */
import { markRaw } from 'vue';
import { defineStore } from 'pinia';
import { api, type InboxItem, type WorkerTaskView } from '../api/client';
import { createPollingResource, type PollingResourceHandle } from '../composables/usePollingResource';
import { connectActivityStream, type ActivityStreamHandle } from '../composables/useActivityStream';

/** 基础轮询间隔（ms）；任务台是低频状态提示，2s 足够（§18-9：任务台比 Router 播报更快，数据同源不矛盾） */
export const POLL_INTERVAL_MS = 2_000;
/** T5 降级间隔：activity SSE 在线（状态变化 ≤1s 推送）时轮询放宽到 10s */
export const ACTIVITY_IDLE_INTERVAL_MS = 10_000;

export type TaskDecision = 'retry' | 'cancel' | 'accept';

/** 任务按注意力状态的三组分组（对齐轻首页/任务台的「需要你 / 处理中 / 已完成」渲染） */
export interface TaskGroups {
  /** needs_decision：占人不占槽位，最优先 */
  needYou: WorkerTaskView[];
  /** queued / preflight / running：已在推进或排队 */
  active: WorkerTaskView[];
  /** done / failed / canceled：终态 */
  finished: WorkerTaskView[];
}

export const useTasksStore = defineStore('tasks', {
  state: () => ({
    tasks: [] as WorkerTaskView[],
    inbox: [] as InboxItem[],
    projectId: null as string | null,
    /** 轻首页/任务详情右滑面板：当前打开的任务 id（null = 面板关闭） */
    openTaskId: null as string | null,
    /** T5b：轮询资源句柄（markRaw 防 reactive 代理；null = 未在轮询） */
    _resource: null as PollingResourceHandle | null,
    /** T5b：activity SSE 句柄（markRaw；null = 未订阅） */
    _activity: null as ActivityStreamHandle | null,
  }),

  getters: {
    /** 未送达 interrupt 条数（needs_decision / L2 kill）→ 红点 */
    interruptCount: (s) => s.inbox.filter((i) => i.severity === 'interrupt').length,
    /** 待人工裁决的任务（needs_decision 非终态、不占并发槽位但占人，§18-7） */
    pendingDecision: (s) => s.tasks.filter((t) => t.status === 'needs_decision'),
    /** 三组分组（渲染顺序即数组顺序：需要你 → 处理中 → 已完成） */
    groups: (s): TaskGroups => ({
      needYou: s.tasks.filter((t) => t.status === 'needs_decision'),
      active: s.tasks.filter((t) => t.status === 'queued' || t.status === 'preflight' || t.status === 'running'),
      finished: s.tasks.filter((t) => t.status === 'done' || t.status === 'failed' || t.status === 'canceled'),
    }),
    /** 详情面板当前任务（任务被轮询刷新后引用自动跟随最新行） */
    openTask: (s): WorkerTaskView | null => s.tasks.find((t) => t.id === s.openTaskId) ?? null,
  },

  actions: {
    /** 项目切换入口：空串/null = 离开项目（停轮询清状态）；同项目重复调用幂等 */
    watch(projectId: string | null): void {
      const id = projectId || null;
      if (id === this.projectId) return;
      this.stop();
      this.projectId = id;
      if (!id) return;
      void this.refresh();
      // T5b：轮询机制委托 usePollingResource（切 id 清态 + 过期丢弃在工厂内完成）
      this._resource = markRaw(
        createPollingResource<{ tasks: WorkerTaskView[]; inbox: InboxItem[] }>({
          fetch: (pid) =>
            Promise.all([api.listWorkerTasks(pid), api.listUndeliveredInbox(pid)]).then(([tasks, inbox]) => ({
              tasks: tasks.tasks,
              inbox: inbox.items,
            })),
          apply: (data) => {
            this.tasks = data.tasks;
            this.inbox = data.inbox;
          },
          intervalMs: POLL_INTERVAL_MS,
        }),
      );
      this._resource.start(id);
      // T5b：activity SSE 订阅（同项目多消费者共享连接）——在线放宽 10s，断线回 2s
      this._activity = markRaw(
        connectActivityStream(
          id,
          () => void this.refresh(), // activity_changed：立即刷新，不等下一轮
          (connected) => this._resource?.setIntervalMs(connected ? ACTIVITY_IDLE_INTERVAL_MS : POLL_INTERVAL_MS),
        ),
      );
    },

    stop(): void {
      this._resource?.stop();
      this._resource = null;
      this._activity?.disconnect();
      this._activity = null;
      this.projectId = null;
      this.tasks = [];
      this.inbox = [];
      this.openTaskId = null;
    },

    /** 打开/关闭任务详情右滑面板（taskId 传 null = 关闭） */
    openTaskPanel(taskId: string | null): void {
      this.openTaskId = taskId;
    },

    /**
     * 轻首页「输入即派任务」：立即派发（dispatch:true）并刷新列表。
     * title 由 goal 收敛（首行截断，与截图形态一致）；executor null = 内置引擎。
     * 失败向上抛给调用方 toast；成功后调用方拿返回的任务行做「接手」提示与面板打开。
     */
    async dispatch(projectId: string, opts: { goal: string; executor?: string | null; permissionMode?: 'plan' | 'default' | 'yolo' }): Promise<WorkerTaskView> {
      const goal = opts.goal.trim();
      if (!goal) throw new Error('任务内容为空');
      const firstLine = goal.split('\n')[0]!.trim();
      const title = firstLine.length > 24 ? `${firstLine.slice(0, 24)}…` : firstLine;
      const r = await api.createWorkerTask(projectId, {
        title,
        goal,
        executor: opts.executor ?? null,
        permission_mode: opts.permissionMode ?? 'default',
        dispatch: true,
      });
      await this.refresh();
      return r.task;
    },

    /** T5b：刷一轮（委托 usePollingResource；过期响应按当前 id 丢弃） */
    async refresh(): Promise<void> {
      await this._resource?.refresh();
    },

    /** needs_decision 裁决（红线：无乐观更新——端点成功后才 refresh；失败向上抛给弹窗展示） */
    async decide(taskId: string, decision: TaskDecision): Promise<void> {
      await api.decideWorkerTask(taskId, decision);
      await this.refresh();
    },

    /** 取消任务（queued/running/needs_decision 均可）：同 bgTasks.kill 口径，失败静默、刷新看真值 */
    async cancel(taskId: string): Promise<void> {
      try {
        await api.cancelWorkerTask(taskId);
      } catch {
        /* 404 = 已终态 / 409 = preflight 窗口：无害，刷新即对齐 */
      }
      await this.refresh();
    },
  },
});
