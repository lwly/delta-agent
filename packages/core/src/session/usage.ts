/**
 * F-31 成本与用量报告 —— 用量聚合查询层（只读，纯 SQL GROUP BY，无 ORM）。
 *
 * 数据来源：usage 表（逐轮落库，v3 起带 model / created_at）。
 * 口径（design-f31 §1.2 D8 / §9.6）：
 * - 「轮次」= usage 行数；费用为 Provider 层已算好的 cost_usd 直加，不做二次计价；
 * - 软删除会话的费用计入汇总（沉没成本），bySession 明细列表仅列活跃会话；
 * - 孤儿 usage 行（session 已物理消失）计入 totals / byProject「未知项目」，
 *   bySession 因 INNER JOIN 天然排除。
 * 时间：created_at 一律 ISO 8601 UTC；today 边界按本地时区 0 点计算后转 ISO。
 */
import type Database from 'better-sqlite3';

export type UsageRange = 'today' | '7d' | '30d' | 'all';

export interface UsageFilter {
  range?: UsageRange;
  projectId?: string;
}

/** 聚合行（SQL 结果直出，snake_case 对齐现有 API/CLI --json 约定） */
export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** usage 行数 = 轮次 */
  turns: number;
  /** COUNT(DISTINCT session_id) */
  sessions: number;
}

export interface UsageProjectRow extends UsageTotals {
  /** 孤儿 usage 行（session 已消失）归为 null */
  project_id: string | null;
  project_name: string;
}

export interface UsageModelRow extends UsageTotals {
  /** 空 model（历史回填失败行）归入「未知」 */
  model: string;
}

export interface UsageSessionRow extends UsageTotals {
  session_id: string;
  project_id: string;
  title: string;
  model: string;
}

export interface UsageReport {
  /** 回显实际生效范围（非法输入已归一化为 all） */
  range: UsageRange;
  totals: UsageTotals;
  byProject: UsageProjectRow[];
  byModel: UsageModelRow[];
}

/** API / CLI --json 同构输出形态（snake_case 外层键，对齐 buildHeadlessReport 约定） */
export interface UsageReportJson {
  range: UsageRange;
  project: string | null;
  totals: UsageTotals;
  by_project: UsageProjectRow[];
  by_model: UsageModelRow[];
}

/** 范围 → UTC ISO 下界（all → null 表示不过滤）；today 用本地时区 0 点。 */
export function rangeCutoff(range: UsageRange): string | null {
  if (range === 'all') return null;
  const now = new Date();
  if (range === 'today') {
    now.setHours(0, 0, 0, 0);
    return now.toISOString();
  }
  const days = range === '7d' ? 7 : 30;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/** 非法值归一化为 'all'（API/CLI 共用）。 */
export function normalizeRange(input: string | null | undefined): UsageRange {
  return input === 'today' || input === '7d' || input === '30d' ? input : 'all';
}

/** UsageReport → API / CLI --json 同构 snake_case 形态（同一查询层产出，双端零漂移）。 */
export function usageReportToJson(report: UsageReport, projectId: string | null): UsageReportJson {
  return {
    range: report.range,
    project: projectId,
    totals: report.totals,
    by_project: report.byProject,
    by_model: report.byModel,
  };
}

interface AggRow {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  turns: number;
  sessions: number;
}

const ZERO_TOTALS: UsageTotals = { input_tokens: 0, output_tokens: 0, cost_usd: 0, turns: 0, sessions: 0 };

/**
 * UsageStore：与 SessionStore 同库（复用其 SQLite 连接），只读聚合。
 * 挂载于 SessionService.usage（对齐 tasks/memory/changes/search 既有模式）。
 */
export class UsageStore {
  constructor(private readonly db: Database.Database) {}

  /** 汇总 + 按项目 + 按模型（一次调用，三个查询；API 与 CLI --json 共用）。 */
  summary(filter: UsageFilter = {}): UsageReport {
    const range = filter.range ?? 'all';
    const cutoff = rangeCutoff(range);
    const params = { cutoff, project: filter.projectId ?? null };

    const totals = this.db.prepare(
      `SELECT COALESCE(SUM(input_tokens), 0)  AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cost_usd), 0)      AS cost_usd,
              COUNT(*)                        AS turns,
              COUNT(DISTINCT session_id)      AS sessions
       FROM usage
       WHERE (@cutoff IS NULL OR created_at >= @cutoff)
         AND (@project IS NULL OR session_id IN
              (SELECT id FROM sessions WHERE project_id = @project))`,
    ).get(params) as AggRow | undefined;

    // byProject：LEFT JOIN 保留孤儿行（归入「未知项目」）；不过滤 deleted_at（D8 沉没成本）
    const byProject = this.db.prepare(
      `SELECT s.project_id                                              AS project_id,
              COALESCE(p.name, '（未知项目）')                          AS project_name,
              COALESCE(SUM(u.input_tokens), 0)                          AS input_tokens,
              COALESCE(SUM(u.output_tokens), 0)                         AS output_tokens,
              COALESCE(SUM(u.cost_usd), 0)                              AS cost_usd,
              COUNT(*)                                                  AS turns,
              COUNT(DISTINCT u.session_id)                              AS sessions
       FROM usage u
       LEFT JOIN sessions s ON s.id = u.session_id
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE (@cutoff IS NULL OR u.created_at >= @cutoff)
         AND (@project IS NULL OR s.project_id = @project)
       GROUP BY s.project_id, p.name
       ORDER BY cost_usd DESC`,
    ).all(params) as UsageProjectRow[];

    // byModel：空 model（回填失败的历史行）归入「未知」
    const byModel = this.db.prepare(
      `SELECT COALESCE(NULLIF(u.model, ''), '（未知）')                 AS model,
              COALESCE(SUM(u.input_tokens), 0)                          AS input_tokens,
              COALESCE(SUM(u.output_tokens), 0)                         AS output_tokens,
              COALESCE(SUM(u.cost_usd), 0)                              AS cost_usd,
              COUNT(*)                                                  AS turns,
              COUNT(DISTINCT u.session_id)                              AS sessions
       FROM usage u
       LEFT JOIN sessions s ON s.id = u.session_id
       WHERE (@cutoff IS NULL OR u.created_at >= @cutoff)
         AND (@project IS NULL OR s.project_id = @project)
       GROUP BY COALESCE(NULLIF(u.model, ''), '（未知）')
       ORDER BY cost_usd DESC`,
    ).all(params) as UsageModelRow[];

    return {
      range,
      totals: totals ?? ZERO_TOTALS,
      byProject,
      byModel,
    };
  }

  /** 逐会话明细（仅活跃会话：deleted_at IS NULL，软删除口径见 D8）。 */
  bySession(filter: UsageFilter = {}): UsageSessionRow[] {
    const range = filter.range ?? 'all';
    const cutoff = rangeCutoff(range);
    return this.db.prepare(
      `SELECT u.session_id                                              AS session_id,
              s.project_id                                              AS project_id,
              s.title                                                   AS title,
              s.model                                                   AS model,
              COALESCE(SUM(u.input_tokens), 0)                          AS input_tokens,
              COALESCE(SUM(u.output_tokens), 0)                         AS output_tokens,
              COALESCE(SUM(u.cost_usd), 0)                              AS cost_usd,
              COUNT(*)                                                  AS turns,
              COUNT(DISTINCT u.session_id)                              AS sessions
       FROM usage u
       JOIN sessions s ON s.id = u.session_id
       WHERE s.deleted_at IS NULL
         AND (@cutoff IS NULL OR u.created_at >= @cutoff)
         AND (@project IS NULL OR s.project_id = @project)
       GROUP BY u.session_id
       ORDER BY cost_usd DESC`,
    ).all({ cutoff, project: filter.projectId ?? null }) as UsageSessionRow[];
  }
}
