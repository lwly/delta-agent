/**
 * F-58 任务台 store：当前项目 Worker 任务列表 + 未送达 inbox 的全部状态与动作（Pinia）。
 *
 * 设计（docs/design-f58-router-worker.md §10/§14、计划 T5b）：
 * - 数据源 = GET /api/projects/:id/worker-tasks + GET /api/projects/:id/inbox?delivered=0
 *   轮询（2s；服务端无增量事件，与 bgTasks 同口径：协议没有就不做假实时）
 * - watch(projectId) 项目切换/清空即重置轮询；过期响应丢弃防串台
 * - interruptCount = 未送达 interrupt 条数 → 任务台红点（AC8 Web 侧）
 * - 裁决/取消不做乐观状态机（红线）：端点成功后才 refresh；失败时列表保持服务端真值
 */
import { defineStore } from 'pinia';
import { api, type InboxItem, type WorkerTaskView } from '../api/client';

/** 轮询间隔（ms）；任务台是低频状态提示，2s 足够（§18-9：任务台比 Router 播报更快，数据同源不矛盾） */
export const POLL_INTERVAL_MS = 2_000;

export type TaskDecision = 'retry' | 'cancel' | 'accept';

export const useTasksStore = defineStore('tasks', {
  state: () => ({
    tasks: [] as WorkerTaskView[],
    inbox: [] as InboxItem[],
    projectId: null as string | null,
    _timer: null as ReturnType<typeof setInterval> | null,
  }),

  getters: {
    /** 未送达 interrupt 条数（needs_decision / L2 kill）→ 红点 */
    interruptCount: (s) => s.inbox.filter((i) => i.severity === 'interrupt').length,
    /** 待人工裁决的任务（needs_decision 非终态、不占并发槽位但占人，§18-7） */
    pendingDecision: (s) => s.tasks.filter((t) => t.status === 'needs_decision'),
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
      this._timer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
    },

    stop(): void {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
      this.projectId = null;
      this.tasks = [];
      this.inbox = [];
    },

    async refresh(): Promise<void> {
      const id = this.projectId;
      if (!id) return;
      try {
        const [tasks, inbox] = await Promise.all([
          api.listWorkerTasks(id),
          api.listUndeliveredInbox(id),
        ]);
        // 项目已切走：丢弃过期响应（不串台）
        if (this.projectId === id) {
          this.tasks = tasks.tasks;
          this.inbox = inbox.items;
        }
      } catch {
        /* 服务端能力未装配（501）或瞬时失败：保持现状，下轮重试 */
      }
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
