/**
 * F-22b cron 表单态 ↔ cron 表达式双向转换（纯函数，可单测）。
 *
 * 规则表（见 docs/design-f22b-cron-workbuddy-ui.md §3.3）：
 *  - hourly  → `0 * * * *`（另识别 `@hourly`）
 *  - daily   → `MM HH * * *`（另识别 `@daily` / `@midnight`）
 *  - weekly  → `MM HH * * D,D`（D = JS getDay 0–6，升序去重；另识别 `@weekly`）
 *  - monthly → `MM HH D * *`（另识别 `@monthly`）
 *  - custom  → 原样提交（步进 / 区间 / 其它别名一律回填 custom）
 */

export type RepeatMode = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

/** cron 调度部分的表单态（time='HH:MM'，hourly 忽略） */
export interface CronFormSchedule {
  mode: RepeatMode;
  time: string;
  weekDays: number[];
  monthDay: number | null;
  customExpr: string;
}

/** CronJobForm 表单全集（validateCronForm 的入参） */
export interface CronJobFormValues {
  name: string;
  prompt: string;
  cwd: string;
  schedule: CronFormSchedule;
  permission: 'plan' | 'default' | 'yolo';
  validity: 'forever' | 'custom';
  /** 'YYYY-MM-DD'（validity='custom' 时必填） */
  validFrom: string;
  /** 'YYYY-MM-DD'（validity='custom' 时必填） */
  validUntil: string;
}

/** 两位数字补零（本目录若干格式化共用，不引 dayjs） */
export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 'HH:MM' → { hh, mm }；非法返回 null（严格 0-23 / 0-59） */
function parseTime(time: string): { hh: number; mm: number } | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(time.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

/** 数字数组 → 升序去重字符串（7 归一为 0 = 周日） */
function daysToCronField(days: number[]): string {
  const normalized = [...new Set(days.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  return normalized.join(',');
}

/**
 * 表单态 → cron 表达式；非法组合返回 null（weekly 未选星期、时间非法、custom 为空等）。
 * 数值输出不补零（PRD 验收 2：每天 09:00 → `0 9 * * *`）。
 */
export function buildCron(s: CronFormSchedule): string | null {
  switch (s.mode) {
    case 'hourly':
      return '0 * * * *';
    case 'daily': {
      const t = parseTime(s.time);
      return t ? `${t.mm} ${t.hh} * * *` : null;
    }
    case 'weekly': {
      const t = parseTime(s.time);
      if (!t || s.weekDays.length === 0) return null;
      return `${t.mm} ${t.hh} * * ${daysToCronField(s.weekDays)}`;
    }
    case 'monthly': {
      const t = parseTime(s.time);
      if (!t || s.monthDay === null) return null;
      const d = Number(s.monthDay);
      if (!Number.isInteger(d) || d < 1 || d > 31) return null;
      return `${t.mm} ${t.hh} ${d} * *`;
    }
    case 'custom':
      return s.customExpr.trim() || null;
  }
}

/** cron 别名 → 结构化表单态（未命中别名返回 null） */
function parseAlias(expr: string): CronFormSchedule | null {
  const midnight = '00:00';
  switch (expr.trim().toLowerCase()) {
    case '@hourly':
      return { mode: 'hourly', time: midnight, weekDays: [], monthDay: null, customExpr: '' };
    case '@daily':
    case '@midnight':
      return { mode: 'daily', time: midnight, weekDays: [], monthDay: null, customExpr: '' };
    case '@weekly':
      return { mode: 'weekly', time: midnight, weekDays: [0], monthDay: null, customExpr: '' };
    case '@monthly':
      return { mode: 'monthly', time: midnight, weekDays: [], monthDay: 1, customExpr: '' };
    default:
      return null;
  }
}

/** 时分是否在合法范围（用于拒绝 `99 99 * * *` 这类正则可过但语义非法的表达式） */
function timeInRange(hh: number, mm: number): boolean {
  return hh <= 23 && mm <= 59;
}

/**
 * cron 表达式 → 表单态；未识别（含步进 / 区间 / @yearly 等别名 / 字段越界）
 * → mode='custom' 且 customExpr 原值保留。
 */
export function parseCronToForm(expr: string): CronFormSchedule {
  const trimmed = expr.trim();
  const alias = parseAlias(trimmed);
  if (alias) return alias;

  const hourly = /^0 \* \* \* \*$/.exec(trimmed);
  if (hourly) return { mode: 'hourly', time: '00:00', weekDays: [], monthDay: null, customExpr: '' };

  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(trimmed);
  if (daily && timeInRange(Number(daily[2]), Number(daily[1]))) {
    const time = `${pad2(Number(daily[2]))}:${pad2(Number(daily[1]))}`;
    return { mode: 'daily', time, weekDays: [], monthDay: null, customExpr: '' };
  }

  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7](,[0-7])*)$/.exec(trimmed);
  if (weekly && timeInRange(Number(weekly[2]), Number(weekly[1]))) {
    const weekDays = [...new Set(weekly[3]!.split(',').map((d) => (Number(d) === 7 ? 0 : Number(d))))].sort((a, b) => a - b);
    return {
      mode: 'weekly',
      time: `${pad2(Number(weekly[2]))}:${pad2(Number(weekly[1]))}`,
      weekDays,
      monthDay: null,
      customExpr: '',
    };
  }

  const monthly = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/.exec(trimmed);
  if (monthly && timeInRange(Number(monthly[2]), Number(monthly[1])) && Number(monthly[3]) >= 1 && Number(monthly[3]) <= 31) {
    return {
      mode: 'monthly',
      time: `${pad2(Number(monthly[2]))}:${pad2(Number(monthly[1]))}`,
      weekDays: [],
      monthDay: Number(monthly[3]),
      customExpr: '',
    };
  }

  return { mode: 'custom', time: '00:00', weekDays: [], monthDay: null, customExpr: trimmed };
}

/**
 * 表单全集校验：字段名 → 错误文案；返回空对象 = 通过。
 * 覆盖 PRD §5.2：name/prompt/cwd 必填、cwd 绝对路径、每周至少一星期、
 * 每月必选日期、自定义 cron 非空、自定义有效期起止齐全且 start<=end。
 */
export function validateCronForm(f: CronJobFormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!f.name.trim()) errors.name = '任务名称必填';
  if (!f.prompt.trim()) errors.prompt = '任务描述必填';
  if (!f.cwd.trim()) errors.cwd = '工作空间必填';
  else if (!f.cwd.trim().startsWith('/')) errors.cwd = '工作空间必须是绝对路径';

  const s = f.schedule;
  if (s.mode === 'daily' || s.mode === 'weekly' || s.mode === 'monthly') {
    if (!parseTime(s.time)) errors.time = '请选择有效时间（HH:MM）';
  }
  if (s.mode === 'weekly' && s.weekDays.length === 0) errors.weekDays = '请至少选择一个星期';
  if (s.mode === 'monthly' && s.monthDay === null) errors.monthDay = '请选择日期';
  if (s.mode === 'custom' && !s.customExpr.trim()) errors.customExpr = '请填写 cron 表达式';

  if (f.validity === 'custom') {
    if (!f.validFrom) errors.validFrom = '请选择开始日期';
    if (!f.validUntil) errors.validUntil = '请选择结束日期';
    if (f.validFrom && f.validUntil && f.validFrom > f.validUntil) {
      errors.validUntil = '开始日期不能晚于结束日期';
    }
  }
  return errors;
}
