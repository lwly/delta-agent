/**
 * F-22b cron 人话化描述与下次执行倒计时（纯函数，可单测，不依赖组件生命周期）。
 * 倒计时自刷新由 CronView 持 nowTick（30s setInterval）注入 now。
 */
import { pad2 } from './cronBuilder.js';

/** JS getDay（0=周日…6=周六）→ 中文单字 */
const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'] as const;

/** 'HH:MM' → { hh, mm }；非法返回 null */
function parseTime(time: string): { hh: number; mm: number } | null {
  const m = /^(\d{1,2}):(\d{1,2})$/.exec(time.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  return hh <= 23 && mm <= 59 ? { hh, mm } : null;
}

/**
 * cron → 人话化描述。标准模式返回 { text, standard: true }：
 *  - '每天 09:00' / '每周一、周五 09:00' / '每月 15 日 09:00' / '每小时（整点）' / '每 15 分钟'
 * 未识别 → { text: 原表达式, standard: false }（前端以等宽代码样式展示，兼容 CLI 创建任务）。
 */
export function describeCron(expr: string): { text: string; standard: boolean } {
  const trimmed = expr.trim();
  switch (trimmed.toLowerCase()) {
    case '@hourly':
      return { text: '每小时（整点）', standard: true };
    case '@daily':
    case '@midnight':
      return { text: '每天 00:00', standard: true };
    case '@weekly':
      return { text: '每周日 00:00', standard: true };
    case '@monthly':
      return { text: '每月 1 日 00:00', standard: true };
  }

  // 常见步进：'*/15 * * * *' → 「每 15 分钟」（仅 describe 用；表单态仍回填 custom）
  const step = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(trimmed);
  if (step) return { text: `每 ${step[1]} 分钟`, standard: true };

  const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(trimmed);
  if (daily) {
    const mm = Number(daily[1]);
    const hh = Number(daily[2]);
    if (hh <= 23 && mm <= 59) return { text: `每天 ${pad2(hh)}:${pad2(mm)}`, standard: true };
  }

  const weekly = /^(\d{1,2}) (\d{1,2}) \* \* ([0-7](,[0-7])*)$/.exec(trimmed);
  if (weekly) {
    const hh = Number(weekly[2]);
    const mm = Number(weekly[1]);
    if (hh <= 23 && mm <= 59) {
      const days = [...new Set(weekly[3]!.split(',').map((d) => (Number(d) === 7 ? 0 : Number(d))))].sort((a, b) => a - b);
      return { text: `每周${days.map((d) => WEEK_CN[d]).join('、')} ${pad2(hh)}:${pad2(mm)}`, standard: true };
    }
  }

  const monthly = /^(\d{1,2}) (\d{1,2}) (\d{1,2}) \* \*$/.exec(trimmed);
  if (monthly) {
    const hh = Number(monthly[2]);
    const mm = Number(monthly[1]);
    const d = Number(monthly[3]);
    if (hh <= 23 && mm <= 59 && d >= 1 && d <= 31) {
      return { text: `每月 ${d} 日 ${pad2(hh)}:${pad2(mm)}`, standard: true };
    }
  }

  if (/^0 \* \* \* \*$/.test(trimmed)) return { text: '每小时（整点）', standard: true };

  return { text: expr, standard: false };
}

/** 本地时区取「当日 00:00」的时间戳（用于跨日计算） */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * next_run_at → 倒计时文案（相对 now）：
 *  - <1h → 'N 分钟后执行'；当天 → 'N 小时后执行'；明天 → '明天 HH:MM 执行'；
 *  - 跨日 ≤7 天 → 'N 天后执行'；>7 天 → 'YYYY-MM-DD 执行'；
 *  - nextRunAt 缺失 / 不可解析 / 已过 → '待补跑'（daemon 停机积压语义）。
 */
export function countdownText(nextRunAt: string | undefined, now: Date): string {
  if (!nextRunAt) return '待补跑';
  const t = Date.parse(nextRunAt);
  if (Number.isNaN(t)) return '待补跑';
  const diff = t - now.getTime();
  if (diff <= 0) return '待补跑';

  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟后执行`;

  const dayDiff = Math.round((startOfDay(new Date(t)) - startOfDay(now)) / 86_400_000);
  if (dayDiff < 1) {
    // 同一天：'N 小时后执行'
    return `${Math.ceil(diff / 3_600_000)} 小时后执行`;
  }
  const target = new Date(t);
  const hm = `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
  if (dayDiff === 1) return `明天 ${hm} 执行`;
  if (dayDiff <= 7) return `${dayDiff} 天后执行`;
  return `${target.getFullYear()}-${pad2(target.getMonth() + 1)}-${pad2(target.getDate())} 执行`;
}
