/**
 * F-54 会话内后台任务：输入区上方任务条的全部状态与动作（Pinia）。
 *
 * 设计（docs/design-f54-background-tasks.md §6）：
 * - 数据源 = GET /api/sessions/:id/background-tasks 轮询（2s；服务端无增量事件，
 *   与 RunStatusBar token 小字同口径：协议没有就不做假实时）
 * - watch(sessionId) 会话切换/清空即重置轮询；切会话清空旧列表防串台
 * - expanded 仅是 UI 态（胶囊点开的面板），会话切换时收起
 * - kill 成功后立即刷新列表（不等下一轮轮询）
 *
 * 【术语锚点】本 store 的 Task 指的是 **会话内后台命令（BackgroundCommand，内存
 * Map、不落库）的视图状态**（见 docs/architecture-glossary.md §6/§11-4），不是
 * worker_tasks 委派任务（tasks.ts）也不是 cron 定时任务。
 *
 * 架构收口 T5b：轮询机制抽至 composables/usePollingResource；activity SSE 按
 * 当前会话所属项目订阅（useActivityStream）——在线时轮询 2s→10s 降级、断线回 2s；
 * activity_changed 立即刷新。无项目上下文（桌面端未选项目）时不订阅、保持 2s。
 */
import { markRaw } from 'vue';
import { defineStore } from 'pinia';
import { api, type BackgroundTaskView } from '../api/client';
import { createPollingResource, type PollingResourceHandle } from '../composables/usePollingResource';
import { connectActivityStream, type ActivityStreamHandle } from '../composables/useActivityStream';
import { useWorkspaceStore } from './workspace';

/** 基础轮询间隔（ms）；任务条是低频状态提示，2s 足够 */
export const POLL_INTERVAL_MS = 2_000;
/** T5 降级间隔：activity SSE 在线（状态变化 ≤1s 推送）时轮询放宽到 10s */
export const ACTIVITY_IDLE_INTERVAL_MS = 10_000;

export const useBgTasksStore = defineStore('bgTasks', {
  state: () => ({
    tasks: [] as BackgroundTaskView[],
    expanded: false,
    sessionId: null as string | null,
    /** T5b：轮询资源句柄（markRaw 防 reactive 代理；null = 未在轮询） */
    _resource: null as PollingResourceHandle | null,
    /** T5b：activity SSE 句柄（markRaw；null = 未订阅） */
    _activity: null as ActivityStreamHandle | null,
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
      // T5b：轮询机制委托 usePollingResource（切会话清态 + 过期丢弃在工厂内完成）
      this._resource = markRaw(
        createPollingResource<BackgroundTaskView[]>({
          fetch: (sid) => api.backgroundTasks(sid),
          apply: (items) => {
            this.tasks = items;
          },
          intervalMs: POLL_INTERVAL_MS,
        }),
      );
      this._resource.start(id);
      // T5b：activity SSE 按当前会话所属项目订阅（workspace 上下文；无项目 = 不订阅）
      const projectId = useWorkspaceStore().activeProjectId;
      if (projectId) {
        this._activity = markRaw(
          connectActivityStream(
            projectId,
            () => void this.refresh(), // activity_changed：立即刷新
            (connected) => this._resource?.setIntervalMs(connected ? ACTIVITY_IDLE_INTERVAL_MS : POLL_INTERVAL_MS),
          ),
        );
      }
    },

    stop(): void {
      this._resource?.stop();
      this._resource = null;
      this._activity?.disconnect();
      this._activity = null;
      this.sessionId = null;
      this.tasks = [];
      this.expanded = false;
    },

    /** T5b：刷一轮（委托 usePollingResource；过期响应按当前会话 id 丢弃） */
    async refresh(): Promise<void> {
      await this._resource?.refresh();
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
