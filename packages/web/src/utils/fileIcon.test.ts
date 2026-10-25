/**
 * F-38：文件类型图标分类单测（PRD §5.7 七类 + 其它）
 * 关键约束：类型图标色板**不含绿/红**（绿加红减只表达增删语义）。
 */
import { describe, expect, it } from 'vitest';
import { classifyFile, type FileIconKind } from './fileIcon.js';

const GREEN_RED_HINTS = ['green', 'red', '--green', '--red', '3fb950', 'f85149'];

describe('classifyFile —— 七类图标', () => {
  const cases: Array<[string, FileIconKind]> = [
    ['README.md', 'doc'],
    ['notes.markdown', 'doc'],
    ['spec.mdx', 'doc'],
    ['changelog.txt', 'doc'],
    ['flow.mmd', 'chart'],
    ['diagram.drawio', 'chart'],
    ['index.ts', 'code'],
    ['app.tsx', 'code'],
    ['main.js', 'code'],
    ['tool.py', 'code'],
    ['server.go', 'code'],
    ['App.vue', 'component'],
    ['theme.css', 'component'],
    ['page.html', 'component'],
    ['package.json', 'config'],
    ['ci.yml', 'config'],
    ['Cargo.toml', 'config'],
    ['logo.png', 'asset'],
    ['icon.svg', 'asset'],
    ['font.woff2', 'asset'],
  ];

  for (const [name, kind] of cases) {
    it(`${name} → ${kind}`, () => {
      expect(classifyFile(name).kind).toBe(kind);
    });
  }

  it('大小写不敏感（扩展名统一小写比较）', () => {
    expect(classifyFile('README.MD').kind).toBe('doc');
    expect(classifyFile('Main.TS').kind).toBe('code');
  });

  it('无扩展名 / 未收录扩展名 → other', () => {
    expect(classifyFile('Makefile').kind).toBe('other');
    expect(classifyFile('dockerfile').kind).toBe('other');
    expect(classifyFile('.gitignore').kind).toBe('other');
    expect(classifyFile('weird.zzz').kind).toBe('other');
    expect(classifyFile('').kind).toBe('other');
  });
});

describe('classifyFile —— 角标与色板', () => {
  it('角标最多 2 字符', () => {
    for (const name of ['a.ts', 'b.py', 'c.yml', 'd.vue', 'e.png', 'f.unknown', 'g']) {
      expect(classifyFile(name).label.length).toBeLessThanOrEqual(2);
      expect(classifyFile(name).label.length).toBeGreaterThan(0);
    }
  });

  it('同类不同文种给出区分度角标（ts/tsx、json/yaml）', () => {
    expect(classifyFile('a.ts').label).toBe('TS');
    expect(classifyFile('a.tsx').label).toBe('TX');
    expect(classifyFile('a.json').label).toBe('JN');
    expect(classifyFile('a.yaml').label).toBe('YM');
  });

  it('颜色一律走局部 CSS 变量，且不含绿/红语义', () => {
    const names = ['a.md', 'b.mmd', 'c.ts', 'd.vue', 'e.json', 'f.png', 'g'];
    for (const name of names) {
      const icon = classifyFile(name);
      expect(icon.color.startsWith('var(--file-icon-')).toBe(true);
      for (const hint of GREEN_RED_HINTS) {
        expect(icon.color.toLowerCase()).not.toContain(hint);
      }
    }
  });
});
