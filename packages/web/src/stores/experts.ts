/**
 * F-39 专家库 store：列表 / 详情 / 头像缓存 / 加载与错误态
 */
import { defineStore } from 'pinia';
import { api, type ExpertDetail, type ExpertListItem } from '../api/client';

export const useExpertsStore = defineStore('experts', {
  state: () => ({
    list: [] as ExpertListItem[],
    /** 发现期警告（坏包等），面板内联展示 */
    errors: [] as string[],
    /** P1：停用清单（召唤面板过滤；设置页展示开关状态） */
    disabled: [] as string[],
    details: {} as Record<string, ExpertDetail>,
    /** name → data_url|null（null = 无头像已确认，避免重复请求） */
    avatars: {} as Record<string, string | null>,
    loading: false,
    error: '',
    loaded: false,
  }),
  getters: {
    byName(state) {
      return (name: string): ExpertListItem | undefined => state.list.find((e) => e.name === name);
    },
  },
  actions: {
    async load(projectId?: string) {
      this.loading = true;
      this.error = '';
      try {
        const r = await api.listExperts(projectId);
        this.list = r.experts;
        this.errors = r.errors;
        this.disabled = (r as { disabled?: string[] }).disabled ?? [];
        this.loaded = true;
      } catch (e) {
        this.error = (e as Error).message;
      } finally {
        this.loading = false;
      }
    },
    async loadDetail(name: string): Promise<ExpertDetail | null> {
      if (this.details[name]) return this.details[name]!;
      try {
        const d = await api.getExpert(name);
        this.details[name] = d;
        return d;
      } catch {
        return null;
      }
    },
    async loadAvatar(name: string): Promise<string | null> {
      if (name in this.avatars) return this.avatars[name]!;
      try {
        const r = await api.getExpertAvatar(name);
        this.avatars[name] = r.data_url;
      } catch {
        this.avatars[name] = null;
      }
      return this.avatars[name]!;
    },
    invalidate() {
      this.loaded = false;
    },
  },
});
