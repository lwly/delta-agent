/**
 * F-39 召唤面板的过滤与排序（纯函数，可直测）
 */
import type { ExpertListItem } from '../api/client';

/** 搜索过滤：name 前缀 / displayName 中文 / profession 中文 / keywords 模糊；空查询全量 */
export function filterExperts(list: ExpertListItem[], query: string): ExpertListItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return list.slice();
  return list.filter((e) => {
    if (e.name.toLowerCase().includes(q)) return true;
    if ((e.displayName.zh || '').toLowerCase().includes(q)) return true;
    if ((e.displayName.en || '').toLowerCase().includes(q)) return true;
    if ((e.profession.zh || '').toLowerCase().includes(q)) return true;
    if ((e.profession.en || '').toLowerCase().includes(q)) return true;
    if (e.keywords.some((k) => k.toLowerCase().includes(q))) return true;
    return false;
  });
}

/** 排序：单人优先于团队（团队排同组末尾），组内按 displayName 中文拼音序 */
export function sortExperts(list: ExpertListItem[]): ExpertListItem[] {
  return list.slice().sort((a, b) => {
    if (a.expertType !== b.expertType) return a.expertType === 'agent' ? -1 : 1;
    const an = a.displayName.zh || a.displayName.en;
    const bn = b.displayName.zh || b.displayName.en;
    return an.localeCompare(bn, 'zh');
  });
}
