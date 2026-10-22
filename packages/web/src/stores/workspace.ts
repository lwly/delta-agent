import { defineStore } from 'pinia';
import { api, type ProjectRow, type SessionRow, type TrashItem } from '../api/client';

/** 项目 + 会话 + 回收站：M4-4 管理页的数据中枢 */
export const useWorkspaceStore = defineStore('workspace', {
  state: () => ({
    projects: [] as ProjectRow[],
    sessions: [] as SessionRow[],
    trash: [] as TrashItem[],
    activeProjectId: '' as string,
    loading: false,
  }),
  actions: {
    async refreshProjects() {
      this.projects = await api.listProjects();
    },
    async selectProject(id: string) {
      this.activeProjectId = id;
      this.sessions = await api.listSessions(id);
    },
    async createProject(root: string) {
      const p = await api.createProject(root);
      await this.refreshProjects();
      return p;
    },
    async createSession(opts?: { title?: string; model?: string }) {
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
    async search(q: string) {
      return api.search(q);
    },
  },
});
