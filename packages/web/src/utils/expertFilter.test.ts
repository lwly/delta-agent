import { describe, expect, it } from 'vitest';
import { filterExperts, sortExperts } from './expertFilter';
import type { ExpertListItem } from '../api/client';

const item = (over: Partial<ExpertListItem>): ExpertListItem => ({
  name: 'x',
  displayName: { en: 'X', zh: '某专家' },
  profession: { en: 'Eng', zh: '工程师' },
  expertType: 'agent',
  layer: 'builtin',
  description: '',
  keywords: [],
  categoryId: null,
  memberCount: 0,
  missingMcp: [],
  hasAvatar: false,
  ...over,
});

const list: ExpertListItem[] = [
  item({ name: 'code-architect', displayName: { en: 'Code Architect', zh: '代码架构师' }, profession: { en: 'A', zh: '系统架构' } }),
  item({ name: 'test-engineer', displayName: { en: 'Test Engineer', zh: '测试工程师' }, profession: { en: 'QA', zh: '质量保障' } }),
  item({ name: 'software-dev-team', displayName: { en: 'Dev Team', zh: '软件开发团队' }, expertType: 'team', memberCount: 4 }),
  item({ name: 'commit-helper', keywords: ['提交', 'commit'] }),
];

describe('filterExperts', () => {
  it('空查询 → 全量', () => {
    expect(filterExperts(list, '')).toHaveLength(4);
    expect(filterExperts(list, '  ')).toHaveLength(4);
  });

  it('name 前缀 / 子串', () => {
    expect(filterExperts(list, 'code').map((e) => e.name)).toEqual(['code-architect']);
    expect(filterExperts(list, 'ENGINEER').map((e) => e.name)).toEqual(['test-engineer']);
  });

  it('displayName 中文 / profession 中文 / keywords', () => {
    expect(filterExperts(list, '架构').map((e) => e.name)).toEqual(['code-architect']);
    expect(filterExperts(list, '质量').map((e) => e.name)).toEqual(['test-engineer']);
    expect(filterExperts(list, '提交').map((e) => e.name)).toEqual(['commit-helper']);
  });

  it('无命中 → 空数组', () => {
    expect(filterExperts(list, '不存在的词')).toEqual([]);
  });
});

describe('sortExperts', () => {
  it('团队排同组末尾；组内按 displayName localeCompare(zh) 序', () => {
    const sorted = sortExperts(list);
    // 团队恒在末尾
    expect(sorted[sorted.length - 1]!.name).toBe('software-dev-team');
    expect(sorted.slice(0, 3).every((e) => e.expertType === 'agent')).toBe(true);
    // 组内顺序与 localeCompare('zh') 一致（跨 ICU 环境稳定断言）
    const names = sorted.slice(0, 3).map((e) => e.displayName.zh || e.displayName.en);
    expect([...names].sort((a, b) => a.localeCompare(b, 'zh'))).toEqual(names);
  });
});
