import * as fs from 'node:fs';
import * as path from 'node:path';
import { BROWSE_IGNORED_DIRS } from '../files/browse.js';

/**
 * Composer「@ 文件引用」候选收集（只读、白名单边界内）：
 * - 只返回相对路径；遍历范围锁定在项目根内，不跟随任何符号链接（防目录逃逸）
 * - 跳过构建产物/依赖目录（BROWSE_IGNORED_DIRS，F-38 D5 共享常量）与隐藏目录（. 开头），控制噪声
 * - maxEntries 截断 + 最大深度限制，防止大仓库/深目录拖垮端点
 */
const IGNORED_DIRS: ReadonlySet<string> = new Set(BROWSE_IGNORED_DIRS);
const MAX_FILE_CANDIDATES = 500;
const MAX_WALK_DEPTH = 8;

export async function collectProjectFiles(root: string, q: string, maxEntries = MAX_FILE_CANDIDATES): Promise<string[]> {
  const out: string[] = [];
  const needle = q.toLowerCase();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= maxEntries || depth > MAX_WALK_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      if (e.isSymbolicLink()) continue;
      const rel = path.relative(root, path.join(dir, e.name));
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.')) continue;
        await walk(path.join(dir, e.name), depth + 1);
        continue;
      }
      if (!e.isFile()) continue;
      if (needle && !rel.toLowerCase().includes(needle)) continue;
      out.push(rel.split(path.sep).join('/'));
    }
  };
  await walk(root, 0);
  return out.sort();
}
