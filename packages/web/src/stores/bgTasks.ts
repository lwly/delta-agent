/**
 * F-54 会话内后台任务：输入区上方任务条的全部状态与动作（Pinia）。
 *
 * 设计（docs/design-f54-background-tasks.md §6）：
 * - 数据源 = GET /api/sessions/:id/background-tasks 轮询（2s；服务端无增量事件，
 *   与 RunStatusBar token 小字同口径：协议没有就不做假实时）
 * - watch(sessionId) 会话切换/清空即重置轮询；切会话清空旧列表防串台
 * - expanded 仅是 UI 态（胶囊点开的面板），会话切换时收起
 * - kill 成功后立即刷新列表（不等下一轮轮询）
 */
import { defineStore } from 'pinia';
import { api, type BackgroundTaskView } from '../api/client';

/** 轮询间隔（ms）；任务条是低频状态提示，2s 足够 */
export const POLL_INTERVAL_MS = 2_000;

export const useBgTasksStore = defineStore('bgTasks', {
  state: () => ({
    tasks: [] as BackgroundTaskView[],
    expanded: false,
    sessionId: null as string | null,
    _timer: null as ReturnType<typeof setInterval> | null,
  }),

  getters: {
    runningCount: (s) => s.tasks.filter((t) => t.status === 'running').length,
  },

  actions: {
    /** 会话切换入口：空串/null = 离开会话（停轮询清状态）；同会话重复调用幂等 */
    watch(sessionId: string | null): void {
      const id = sessionId || null;
      if (id === this.sessionId) return;
      this.stop();
      this.sessionId = id;
      if (!id) return;
      void this.refresh();
      this._timer = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
    },

    stop(): void {
      if (this._timer) clearInterval(this._timer);
      this._timer = null;
      this.sessionId = null;
      this.tasks = [];
      this.expanded = false;
    },

    async refresh(): Promise<void> {
      const id = this.sessionId;
      if (!id) return;
      try {
        const items = await api.backgroundTasks(id);
        // 会话已切走：丢弃过期响应
        if (this.sessionId === id) this.tasks = items;
      } catch {
        /* 服务端能力未装配（501）或瞬时失败：保持现状，下轮重试 */
      }
    },

    async kill(taskId: string): Promise<void> {
      const id = this.sessionId;
      if (!id) return;
      try {
        await api.killBackgroundTask(id, taskId);
      } catch {
        /* 404 = 已结束：无害，刷新即消失 */
      }
      await this.refresh();
    },

    toggle(): void {
      this.expanded = !this.expanded;
    },
  },
});
