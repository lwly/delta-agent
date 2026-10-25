/**
 * 三级覆盖合并器：builtin < project(.delta/) < session(runtime)
 * 规则（technical-design.md §5）：
 *   - 字符串 section：后者整体覆盖
 *   - 对象：深度合并
 *   - 数组：并集去重
 *   - locked 层（identity）：覆盖请求直接忽略并告警
 */
import type {
  AssembleWarning,
  LayerId,
  LayerOverride,
  LayerValue,
  OverrideSet,
} from './types.js';

/** 对象深度合并：b 覆盖 a；嵌套对象递归；数组走并集去重 */
export function deepMerge(a: LayerValue, b: LayerOverride): LayerValue {
  if (isPlainObject(a) && isPlainObject(b)) {
    const out: Record<string, unknown> = { ...a };
    for (const [key, bv] of Object.entries(b)) {
      const av = (a as Record<string, unknown>)[key];
      out[key] = av === undefined ? bv : deepMerge(av as LayerValue, bv as LayerOverride);
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return unionDedupe(a, b);
  }
  // 字符串 vs 任意、或类型不兼容：后者覆盖
  return b;
}

/** 数组并集去重（以稳定序列化值为键） */
export function unionDedupe(a: unknown[], b: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of [...a, ...b]) {
    const key = stableKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stableKey(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null) {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return JSON.stringify(keys.map((k) => [k, obj[k]]));
  }
  return JSON.stringify(v);
}

/**
 * 对单层应用三级覆盖。
 * @returns 合并后的值；locked 层返回原值并产出告警
 */
export function applyOverrides(
  layer: { id: LayerId; locked: boolean },
  base: LayerValue,
  overrides: OverrideSet,
): { value: LayerValue; warnings: AssembleWarning[] } {
  const warnings: AssembleWarning[] = [];
  let value = base;

  for (const level of ['project', 'session'] as const) {
    const override = overrides[level]?.[layer.id];
    if (override === undefined) continue;

    if (layer.locked) {
      warnings.push({
        layer: layer.id,
        message: `override from "${level}" ignored: layer "${layer.id}" is locked`,
      });
      continue;
    }
    value = deepMerge(value, override);
  }

  return { value, warnings };
}
