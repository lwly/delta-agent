/**
 * F-22 定时任务 —— cron 表达式解析与下次运行时间计算。
 *
 * 职责：解析 5 字段 cron 表达式（分 时 日 月 周），计算下一次到期时间（本地时区）。
 * 约束：
 *  - 仅支持标准 5 字段语法：`*`、单值、`a-b` 区间、`a,b` 列表、`/step` 步进（可组合）；
 *    另支持 `@hourly` / `@daily` / `@midnight` / `@weekly` / `@monthly` / `@yearly` / `@annually` 别名；
 *  - 周字段 0 与 7 都表示周日（POSIX 惯例），与 JS `getDay()`（0=周日）对齐；
 *  - 「日」与「周」都受限时取 **OR**（POSIX 惯例）：任一命中即视为日期命中；
 *  - 不支持秒级精度、不支持英文月份/星期名、不支持 `?`（保持零依赖、口径最小）；
 *  - 非法表达式 parseCron 抛 Error（调用方决定如何降级），nextRun 对找不到的合法表达
 *    （如 `0 0 30 2 *` 四年内无 2 月 30 日）返回 null。
 */

/** 已解析的表达式：每个字段为值域布尔表 + 该字段是否被显式限制（非 `*`） */
export interface CronFields {
  /** 分钟（0–59） */
  minutes: boolean[];
  /** 小时（0–23） */
  hours: boolean[];
  /** 日（1–31，索引 = 日-1） */
  doms: boolean[];
  /** 月（1–12，索引 = 月-1） */
  months: boolean[];
  /** 周（0–7，7 归一到 0 = 周日） */
  dows: boolean[];
  /** 日字段是否被显式限制（非 `*`） */
  domRestricted: boolean;
  /** 周字段是否被显式限制（非 `*`） */
  dowRestricted: boolean;
}

/** 别名 → 5 字段展开 */
const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

/** 字段定义：名称 / 最小值 / 最大值 / 是否星期字段（7→0 归一） */
const FIELD_SPECS: Array<{ name: string; min: number; max: number; isDow: boolean }> = [
  { name: '分钟', min: 0, max: 59, isDow: false },
  { name: '小时', min: 0, max: 23, isDow: false },
  { name: '日', min: 1, max: 31, isDow: false },
  { name: '月', min: 1, max: 12, isDow: false },
  { name: '周', min: 0, max: 7, isDow: true },
];

/**
 * 解析 cron 表达式；非法时抛 Error（message 含字段名与原因，供 CLI 直接展示）。
 */
export function parseCron(expr: string): CronFields {
  const trimmed = expr.trim();
  const expanded = ALIASES[trimmed.toLowerCase()] ?? trimmed;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 表达式非法：需要 5 个字段（分 时 日 月 周），收到 ${parts.length} 个：「${expr}」`);
  }

  const minutes = parseField(parts[0]!, FIELD_SPECS[0]!, expr);
  const hours = parseField(parts[1]!, FIELD_SPECS[1]!, expr);
  const doms = parseField(parts[2]!, FIELD_SPECS[2]!, expr);
  const months = parseField(parts[3]!, FIELD_SPECS[3]!, expr);
  const dowsRaw = parseField(parts[4]!, FIELD_SPECS[4]!, expr);
  // 7 归一为 0（周日）
  const dows = dowsRaw.slice(0, 7);
  if (dowsRaw[7]) dows[0] = true;

  return {
    minutes,
    hours,
    doms,
    months,
    dows,
    domRestricted: !isWildcard(parts[2]!),
    dowRestricted: !isWildcard(parts[4]!),
  };
}

/**
 * 计算下一次到期时间（严格晚于 from，本地时区，秒位清零）。
 * 逐级跳转：月不命中 → 跳到下月 1 日 00:00；日期不命中 → 跳到次日 00:00；
 * 小时不命中 → 跳到下一小时整点；分钟不命中 → 跳到下一分钟。
 * 向前搜索上限 4 年，找不到返回 null。
 */
export function nextRun(expr: string, from: Date): Date | null {
  const f = parseCron(expr);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // 结果严格晚于 from

  // 上限 4 年的分钟迭代（逐级跳转使实际迭代远小于该值，仅作硬上界防死循环）
  const limit = new Date(from.getTime() + 4 * 366 * 24 * 60 * 60 * 1000);
  while (d <= limit) {
    // 表按 cron 语义 1 基建表（月 1–12、日 1–31），Date getter 是 0 基，查询时 +1 对齐
    if (!f.months[d.getMonth() + 1]) {
      // 跳到下月 1 日 00:00
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    const domHit = f.doms[d.getDate()] ?? false;
    const dowHit = f.dows[d.getDay()] ?? false;
    // dom 与 dow 都受限 → OR（POSIX）；否则 AND
    const dayOk = f.domRestricted && f.dowRestricted ? domHit || dowHit : domHit && dowHit;
    if (!dayOk) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }
    if (!f.hours[d.getHours()]) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!f.minutes[d.getMinutes()]) {
      d.setMinutes(d.getMinutes() + 1);
      continue;
    }
    return new Date(d.getTime());
  }
  return null;
}

// ── 内部 ────────────────────────────────────────────────────────────────────

/** 判断字段是否为纯 `*`（用于 dom/dow 限制标记） */
function isWildcard(part: string): boolean {
  return part === '*';
}

/** 解析单个字段为值域布尔表（长度 = max+1，dow 长度 8 以容纳 7→0 归一） */
function parseField(part: string, spec: { name: string; min: number; max: number; isDow: boolean }, expr: string): boolean[] {
  const table = new Array<boolean>(spec.max + 1).fill(false);
  for (const item of part.split(',')) {
    const seg = item.trim();
    if (seg.length === 0) {
      throw new Error(`cron 表达式非法：${spec.name}字段存在空项：「${expr}」`);
    }
    // 拆步进：`a-b/step`、`*/step`、`a/step`
    const slash = seg.indexOf('/');
    const base = slash === -1 ? seg : seg.slice(0, slash);
    let step = 1;
    if (slash !== -1) {
      step = Number(seg.slice(slash + 1));
      if (!Number.isInteger(step) || step < 1) {
        throw new Error(`cron 表达式非法：${spec.name}字段步进必须为正整数，收到「${seg.slice(slash + 1)}」`);
      }
    }
    // 拆区间：`a-b` 或 `*` 或单值
    let lo: number;
    let hi: number;
    if (base === '*') {
      lo = spec.min;
      hi = spec.max;
    } else if (base.includes('-')) {
      const bits = base.split('-');
      if (bits.length !== 2) {
        throw new Error(`cron 表达式非法：${spec.name}字段区间格式应为 a-b，收到「${base}」`);
      }
      lo = Number(bits[0]);
      hi = Number(bits[1]);
    } else {
      lo = Number(base);
      hi = slash === -1 ? lo : spec.max; // 单值 + 步进：`5/10` 视为 5-max/10
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < spec.min || hi > spec.max || lo > hi) {
      throw new Error(`cron 表达式非法：${spec.name}字段值域应为 [${spec.min}, ${spec.max}]，收到「${item}」（表达式：「${expr}」）`);
    }
    for (let v = lo; v <= hi; v += step) table[v] = true;
  }
  return table;
}
