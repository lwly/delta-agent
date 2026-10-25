/**
 * F-38 文件树类型图标分类（纯函数，无副作用）
 *
 * 依据 PRD §5.7 色板：七类 + 其它；**刻意避开 `--green` / `--red`**，
 * 避免与「绿加红减」语义混淆（PRD §5.7 约束）。
 *
 * 落地方式：色板以 CSS 变量写入各组件的 scoped style（`--file-icon-doc` …），
 * 本模块只返回变量引用（`var(--file-icon-doc)`），因此不改 theme.css 全局令牌。
 */

export type FileIconKind = 'doc' | 'chart' | 'code' | 'component' | 'config' | 'asset' | 'other';

export interface FileIcon {
  kind: FileIconKind;
  /** 14×14 圆角方块内的角标（最多 2 字符，避免撑破图标） */
  label: string;
  /** CSS 变量引用（组件 scoped 内定义具体色值） */
  color: string;
}

const ICON: Readonly<Record<FileIconKind, Omit<FileIcon, 'kind'>>> = {
  doc: { label: 'MD', color: 'var(--file-icon-doc)' },
  chart: { label: 'CH', color: 'var(--file-icon-chart)' },
  code: { label: 'TS', color: 'var(--file-icon-code)' },
  component: { label: 'VU', color: 'var(--file-icon-component)' },
  config: { label: 'CF', color: 'var(--file-icon-config)' },
  asset: { label: 'IM', color: 'var(--file-icon-asset)' },
  other: { label: '·', color: 'var(--file-icon-other)' },
};

/** 各类扩展名（小写、含点）→ 类型。 */
const KIND_BY_EXT: Readonly<Record<string, FileIconKind>> = {
  // 文档
  '.md': 'doc',
  '.markdown': 'doc',
  '.mdx': 'doc',
  '.txt': 'doc',
  '.log': 'doc',
  '.rst': 'doc',
  '.pdf': 'doc',
  // 图表
  '.mmd': 'chart',
  '.mermaid': 'chart',
  '.drawio': 'chart',
  '.puml': 'chart',
  // 代码
  '.ts': 'code',
  '.tsx': 'code',
  '.mts': 'code',
  '.cts': 'code',
  '.js': 'code',
  '.jsx': 'code',
  '.mjs': 'code',
  '.cjs': 'code',
  '.py': 'code',
  '.go': 'code',
  '.rs': 'code',
  '.java': 'code',
  '.kt': 'code',
  '.rb': 'code',
  '.php': 'code',
  '.sh': 'code',
  '.bash': 'code',
  '.zsh': 'code',
  '.c': 'code',
  '.h': 'code',
  '.cc': 'code',
  '.cpp': 'code',
  '.hpp': 'code',
  '.cs': 'code',
  '.swift': 'code',
  '.lua': 'code',
  '.sql': 'code',
  // 组件 / 样式
  '.vue': 'component',
  '.css': 'component',
  '.scss': 'component',
  '.less': 'component',
  '.html': 'component',
  '.htm': 'component',
  '.svelte': 'component',
  // 配置
  '.json': 'config',
  '.jsonc': 'config',
  '.yaml': 'config',
  '.yml': 'config',
  '.toml': 'config',
  '.ini': 'config',
  '.env': 'config',
  '.conf': 'config',
  '.config': 'config',
  // 资源
  '.png': 'asset',
  '.jpg': 'asset',
  '.jpeg': 'asset',
  '.gif': 'asset',
  '.webp': 'asset',
  '.svg': 'asset',
  '.ico': 'asset',
  '.bmp': 'asset',
  '.woff': 'asset',
  '.woff2': 'asset',
  '.ttf': 'asset',
};

/** 角标细分：同类不同文种给出更贴切的 2 字母标记（视觉区分，不影响 kind/配色）。 */
const LABEL_BY_EXT: Readonly<Record<string, string>> = {
  '.ts': 'TS',
  '.tsx': 'TX',
  '.js': 'JS',
  '.jsx': 'JX',
  '.py': 'PY',
  '.go': 'GO',
  '.rs': 'RS',
  '.sh': 'SH',
  '.md': 'MD',
  '.txt': 'TX',
  '.json': 'JN',
  '.yml': 'YM',
  '.yaml': 'YM',
  '.toml': 'TM',
  '.env': 'EN',
  '.vue': 'VU',
  '.css': 'CS',
  '.scss': 'SC',
  '.less': 'LE',
  '.html': 'HT',
  '.png': 'PN',
  '.jpg': 'JP',
  '.jpeg': 'JP',
  '.gif': 'GF',
  '.svg': 'SV',
  '.webp': 'WB',
};

/** 取小写扩展名（无扩展名 → ''；`.gitignore` 这类点开头文件名视为无扩展名）。 */
function extname(name: string): string {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

/**
 * 文件名 → 类型图标（七类 + other）。
 * - 只看扩展名（大小写不敏感），不看内容
 * - 无扩展名 / 未收录扩展名 → `other`（`--text-dim`）
 */
export function classifyFile(name: string): FileIcon {
  const ext = extname(name || '');
  const kind = KIND_BY_EXT[ext] ?? 'other';
  const base = ICON[kind];
  const label = LABEL_BY_EXT[ext] ?? base.label;
  return { kind, label, color: base.color };
}
