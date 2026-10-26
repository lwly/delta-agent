/**
 * 三层目录公共遍历（F-39 D10）
 *
 * 抽自 `skills/loader.ts` 的循环体，供 Skills 与 Experts 共用：
 *   builtin（最低）→ user → project（最高），同名高层覆盖低层；
 *   单条解析失败不阻塞其他条目，计入 errors；
 *   单层超过 maxPerLayer 时按名称排序截断并告警。
 */
import { promises as fs } from 'node:fs';

export type LayerName = 'builtin' | 'user' | 'project';

export interface LayeredDir {
  layer: LayerName;
  dir?: string;
}

export interface LayeredOutcome<T> {
  /** 覆盖合并后的条目（Map 迭代顺序 = 首次出现顺序，即 builtin → user → project） */
  byName: Map<string, { layer: LayerName; name: string; value: T }>;
  /** 每层被覆盖的低层项（设置页「已被用户级覆盖」用；list() 不返回） */
  shadowed: Array<{ layer: LayerName; name: string; value: T }>;
  /** 全部解析成功的条目（按读取顺序，含被覆盖项） */
  entries: Array<{ layer: LayerName; name: string; value: T }>;
  errors: string[];
}

export const DEFAULT_MAX_PER_LAYER = 200;

export async function discoverLayered<T>(opts: {
  layers: LayeredDir[];
  maxPerLayer?: number;
  /** 目录名 → 解析结果；抛错 = 该条目失败（计入 errors，不影响其他） */
  readEntry: (dir: string, entryName: string, layer: LayerName) => Promise<T>;
  /** 条目名（默认 = 目录名），决定覆盖键 */
  keyOf?: (entryName: string, value: T) => string;
}): Promise<LayeredOutcome<T>> {
  const maxPerLayer = opts.maxPerLayer ?? DEFAULT_MAX_PER_LAYER;
  const errors: string[] = [];
  const byName = new Map<string, { layer: LayerName; name: string; value: T }>();
  const shadowed: Array<{ layer: LayerName; name: string; value: T }> = [];
  const entries: Array<{ layer: LayerName; name: string; value: T }> = [];

  for (const { layer, dir } of opts.layers) {
    if (!dir) continue;
    let dirNames: string[];
    try {
      dirNames = (await fs.readdir(dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      continue; // 目录不存在 → 该层无条目
    }
    if (dirNames.length > maxPerLayer) {
      errors.push(`${layer}: 条目数量超过上限 ${maxPerLayer}，已截断（实际 ${dirNames.length}）`);
      dirNames = dirNames.slice(0, maxPerLayer);
    }
    for (const name of dirNames) {
      try {
        const value = await opts.readEntry(dir, name, layer);
        const key = opts.keyOf ? opts.keyOf(name, value) : name;
        const prev = byName.get(key);
        if (prev) shadowed.push(prev);
        const entry = { layer, name: key, value };
        byName.set(key, entry);
        entries.push(entry); // 高层覆盖低层（遍历顺序 builtin→user→project）
      } catch (e) {
        errors.push(`${layer}/${name}: ${(e as Error).message}`);
      }
    }
  }

  return { byName, shadowed, entries, errors };
}
