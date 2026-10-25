/**
 * F-34 项目 onboarding —— 项目布局扫描器：
 * 有限深度/有限条数地收集目录树、根目录工程清单与 README 头部，
 * 组装为一次 LLM 调用可消化的扫描输入全文。纯只读、无副作用、永不 throw。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR } from '../paths.js';

/** 扫描时跳过的目录名（依赖产物 / 版本库 / 构建输出等，避免噪声挤占输入预算） */
export const SCAN_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  CONFIG_DIR,
  '.next',
  '.nuxt',
  'vendor',
  'Pods',
]);

/** 根目录探测的工程清单文件（存在才读） */
const MANIFEST_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'pyproject.toml',
  'requirements.txt',
  'pom.xml',
  'build.gradle',
  'go.mod',
  'Cargo.toml',
  'composer.json',
];

export interface ProjectScan {
  /** 项目根目录绝对路径 */
  root: string;
  /** 缩进目录树文本（目录带 `/` 后缀，限深限条） */
  tree: string;
  /** 探测到的工程清单（头部内容已截断） */
  manifests: Array<{ name: string; head: string }>;
  /** README 头部（不存在为空串） */
  readme: string;
  /** 组装后的扫描输入全文（喂给 LLM 的 user 内容，已按 maxChars 截断） */
  text: string;
}

export interface ScanOptions {
  /** 目录树最大深度（默认 3） */
  maxDepth?: number;
  /** 目录树最大条目数（默认 300） */
  maxEntries?: number;
  /** 组装输入全文的最大字符数（默认 16_000，对齐 distill 的输入预算） */
  maxChars?: number;
  /** README / 清单头部最大字符数（默认 2_000） */
  maxHeadChars?: number;
}

/**
 * 扫描项目布局（只读）。目录不存在或不可读时返回空树（tree 为空串），
 * 调用方据 tree 是否为空决定是否继续生成。
 */
export function scanProjectLayout(root: string, opts?: ScanOptions): ProjectScan {
  const maxDepth = opts?.maxDepth ?? 3;
  const maxEntries = opts?.maxEntries ?? 300;
  const maxChars = opts?.maxChars ?? 16_000;
  const maxHeadChars = opts?.maxHeadChars ?? 2_000;

  const tree = walkTree(root, maxDepth, maxEntries);
  const readme = readHead(
    ['README.md', 'readme.md', 'Readme.md', 'README.zh-CN.md']
      .map((f) => path.join(root, f))
      .find((f) => fs.existsSync(f)) ?? '',
    maxHeadChars,
  );
  const manifests: ProjectScan['manifests'] = [];
  for (const name of MANIFEST_FILES) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    const head = readHead(file, maxHeadChars);
    if (head) manifests.push({ name, head });
  }

  const parts: string[] = [`<project_root>${root}</project_root>`];
  if (tree) parts.push(`<directory_tree depth=${maxDepth}>\n${tree}\n</directory_tree>`);
  if (readme) parts.push(`<readme>\n${readme}\n</readme>`);
  for (const m of manifests) parts.push(`<manifest name="${m.name}">\n${m.head}\n</manifest>`);

  return { root, tree, manifests, readme, text: parts.join('\n\n').slice(0, maxChars) };
}

/** 递归收集目录树文本：目录优先、按名称排序、限深限条，失败静默。 */
function walkTree(root: string, maxDepth: number, maxEntries: number): string {
  const lines: string[] = [];
  const walk = (dir: string, prefix: string, depth: number): void => {
    if (depth > maxDepth || lines.length >= maxEntries) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 不可读目录静默跳过
    }
    entries.sort((a, b) => {
      const da = a.isDirectory() ? 0 : 1;
      const db = b.isDirectory() ? 0 : 1;
      return da - db || a.name.localeCompare(b.name);
    });
    for (const e of entries) {
      if (lines.length >= maxEntries) {
        lines.push(`${prefix}…（已达条目上限）`);
        return;
      }
      if (e.name.startsWith('.') && e.name !== '.github') continue; // 隐藏项默认跳过
      if (e.isDirectory() && SCAN_SKIP_DIRS.has(e.name)) continue;
      if (e.isDirectory()) {
        lines.push(`${prefix}${e.name}/`);
        walk(path.join(dir, e.name), `${prefix}  `, depth + 1);
      } else {
        lines.push(`${prefix}${e.name}`);
      }
    }
  };
  walk(root, '', 1);
  return lines.join('\n');
}

/** 读文件头部（不存在/不可读返回空串） */
function readHead(file: string, maxChars: number): string {
  try {
    const text = fs.readFileSync(file, 'utf-8');
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n（已截断）` : text;
  } catch {
    return '';
  }
}
