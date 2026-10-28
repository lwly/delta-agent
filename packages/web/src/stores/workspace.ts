import { defineStore } from 'pinia';
import { api, type ProjectRow, type PurgeBatchResult, type SessionRow, type TrashItem } from '../api/client';

/** 项目 + 会话 + 回收站：M4-4 管理页的数据中枢 */
export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    projects: [] as ProjectRow[],
    sessions: [] as SessionRow[],
    trash: [] as TrashItem[],
    activeProjectId: '' as string,
    loading: false,
    /** PASI-9：运行中的会话 id（侧栏 ⏸/✕ 切换与删除门禁） */
    runningIds: [] as string[],
    /** 有会话运行中的项目 id（侧栏项目点运行中动效；旧服务端无此字段时为空） */
    runningProjectIds: [] as string[],
  }),
  actions: {
    async refreshProjects() {
      this.projects = await api.listProjects();
    },
    /** PASI-9：拉取运行中的会话 id（失败保持上次状态，不阻塞侧栏） */
    async refreshRunning() {
      try {
        const r = await api.runningSessions();
        this.runningIds = r.ids;
        this.runningProjectIds = r.projects ?? [];
      } catch {
        // 服务暂不可用时维持现状
      }
    },
    async refreshSessions() {
      if (this.activeProjectId) this.sessions = await api.listSessions(this.activeProjectId);
    },
    /** PASI-9：暂停执行中的会话，并同步运行态与会话列表（paused 徽标） */
    async pauseSession(id: string) {
      await api.pause(id);
      await Promise.all([this.refreshRunning(), this.refreshSessions()]);
    },
    async selectProject(id: string) {
      this.activeProjectId = id;
      this.sessions = await api.listSessions(id);
      void this.refreshRunning(); // PASI-9：切项目时同步运行态
    },
    async createProject(root: string) {
      const p = await api.createProject(root);
      await this.refreshProjects();
      return p;
    },
    async createSession(opts?: { title?: string; model?: string; mode?: string; expert?: string }) {
      if (!this.activeProjectId) throw new Error('未选择项目');
      const s = await api.createSession(this.activeProjectId, opts);
      await this.selectProject(this.activeProjectId);
      return s;
    },
    async removeSession(id: string, hard = false) {
      await api.removeSession(id, hard);
      await this.selectProject(this.activeProjectId);
      await this.refreshTrash();
    },
    async removeProject(id: string, confirmName: string, hard = false) {
      await api.removeProject(id, confirmName, hard);
      this.activeProjectId = '';
      this.sessions = [];
      await this.refreshProjects();
      await this.refreshTrash();
    },
    async refreshTrash() {
      this.trash = await api.listTrash();
    },
    async restore(kind: 'project' | 'session', id: string) {
      await api.restore(kind, id);
      await Promise.all([this.refreshProjects(), this.refreshTrash()]);
    },
    async purge(kind: 'project' | 'session', id: string) {
      await api.purgeTrash(kind, id);
      await this.refreshTrash();
    },
    /** 回收站批量彻底清除：完成后刷新列表；部分失败抛出汇总错误供组件展示 */
    async purgeBatch(items: Array<{ kind: 'project' | 'session'; id: string }>): Promise<PurgeBatchResult> {
      const result = await api.purgeTrashBatch(items);
      await this.refreshTrash();
      if (result.failed.length > 0) {
        const first = result.failed[0]!;
        throw new Error(`批量清除：成功 ${result.purged} 条，失败 ${result.failed.length} 条（${first.error}）`);
      }
      return result;
    },
    async search(q: string) {
      return api.search(q);
    },
  },
});
