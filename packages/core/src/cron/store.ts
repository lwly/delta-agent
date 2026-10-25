/**
 * F-22 定时任务 —— 调度存储。
 *
 * 职责：管理 cron 任务清单（`~/.delta/cron.json`，用户级单文件，每条任务自带
 * 运行目录 cwd）。约束：
 *  - 读路径**永不 throw**：坏 JSON / 非法条目降级为 warning + 跳过该条（对齐 notify 惯例）；
 *  - 写路径**先读后写**：既有文件坏 JSON 时拒绝写入（覆盖用户文件属破坏性动作，宁可失败）；
 *  - tmp + rename 原子写（进程中断不会留下半个 JSON）；
 *  - 每条任务保留最近 MAX_RUN_HISTORY 条运行记录，旧记录滚动淘汰。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { nextRun } from './parse.js';
import { FILES, userConfigDir } from '../paths.js';

/** 单次运行记录 */
export interface CronRunRecord {
  /** 触发方式：schedule = 调度到期；manual = 手动补跑 */
  trigger: 'schedule' | 'manual';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  status: 'completed' | 'failed' | 'max_turns' | 'budget_exhausted' | 'aborted' | 'timeout' | 'error';
  /** CLI 退出码（headless 退出码协议）；executor 内部错误时为 null */
  exitCode: number | null;
  sessionId?: string;
  costUsd?: number;
  turns?: number;
  error?: string;
  /** 最终结果预览（截断存储，避免 cron.json 无限膨胀） */
  resultPreview?: string;
}

/** 单条定时任务 */
export interface CronJob {
  id: string;
  /** 名称（唯一，用于 CLI 引用） */
  name: string;
  /** 5 字段 cron 表达式或 @别名 */
  cron: string;
  /** 任务描述（以 `delta run -p` 语义执行） */
  prompt: string;
  /** 运行目录（决定项目与上下文） */
  cwd: string;
  enabled: boolean;
  /** 单次运行费用预算（USD），缺省用 CLI 默认 */
  maxCostUsd?: number;
  /** F-22b 任务级权限模式：缺省 'default'（标准确认）。yolo 写入前由 Web 端二次确认 */
  permission?: 'plan' | 'default' | 'yolo';
  /** F-22b 有效期起点（ISO）；缺省 = 长期有效（无下界） */
  validFrom?: string;
  /** F-22b 有效期终点（ISO）；缺省 = 长期有效（无上界）。Web 端提交「当日」时落 23:59:59 */
  validUntil?: string;
  createdAt: string;
  updatedAt: string;
  /** 下次到期时间（ISO 字符串，本地时区语义；缺失时视为到期待计算） */
  nextRunAt?: string;
  /** 运行中标记（执行前写入、完成后清除；残留超过 STALE_RUNNING_MS 视为崩溃残留） */
  runningSince?: string;
  lastRun?: CronRunRecord;
  /** 运行历史（最近 MAX_RUN_HISTORY 条，旧→新） */
  runs: CronRunRecord[];
}

/** cron.json 顶层结构（预留 version 字段便于后续迁移） */
export interface CronStoreFile {
  version: 1;
  jobs: CronJob[];
}

export interface CronStoreWarning {
  message: string;
}

export interface LoadedCronStore {
  jobs: CronJob[];
  warnings: CronStoreWarning[];
  /** true = 文件存在但无法解析（写操作应拒绝） */
  corrupt: boolean;
}

/** 运行历史保留条数 */
export const MAX_RUN_HISTORY = 20;

/** 任务级权限模式枚举（Web 下拉与 API 校验共用口径） */
export const CRON_PERMISSIONS = ['plan', 'default', 'yolo'] as const;

/**
 * 到期时刻是否落在有效期窗口内（含两端）。缺省字段 = 无界。
 * 纯函数：runner 调度过滤与单测共用；窗口判定基准是 dueAt（计划到期时刻），不是 now。
 */
export function isInValidWindow(job: Pick<CronJob, 'validFrom' | 'validUntil'>, dueAt: Date): boolean {
  const t = dueAt.getTime();
  if (job.validFrom !== undefined) {
    const from = Date.parse(job.validFrom);
    if (!Number.isNaN(from) && t < from) return false;
  }
  if (job.validUntil !== undefined) {
    const until = Date.parse(job.validUntil);
    if (!Number.isNaN(until) && t > until) return false;
  }
  return true;
}
/** runningSince 残留超过该时长视为上次进程崩溃（默认 24h） */
export const STALE_RUNNING_MS = 24 * 60 * 60 * 1000;

/** cron.json 路径（`~/.delta/cron.json`） */
export function userCronConfigPath(homeDir: string = os.homedir()): string {
  return path.join(userConfigDir(homeDir), FILES.cron);
}

/**
 * 加载任务清单。永不 throw：坏 JSON → corrupt=true + warning（ jobs 为空）；
 * 单条任务结构非法 → 跳过该条 + warning。
 */
export function loadCronJobs(homeDir: string = os.homedir()): LoadedCronStore {
  const file = userCronConfigPath(homeDir);
  const warnings: CronStoreWarning[] = [];
  if (!fs.existsSync(file)) return { jobs: [], warnings, corrupt: false };
  let raw: unknown;
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim() === '') return { jobs: [], warnings, corrupt: false };
    raw = JSON.parse(text);
  } catch (e) {
    warnings.push({ message: `cron 配置 ${file} 无法解析：${(e as Error).message}` });
    return { jobs: [], warnings, corrupt: true };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push({ message: `cron 配置 ${file} 不是 JSON 对象` });
    return { jobs: [], warnings, corrupt: true };
  }
  const record = raw as Record<string, unknown>;
  if (!Array.isArray(record.jobs)) {
    warnings.push({ message: `cron 配置 ${file} 缺少 jobs 数组，视为空清单` });
    return { jobs: [], warnings, corrupt: false };
  }
  const jobs: CronJob[] = [];
  for (const item of record.jobs) {
    const job = normalizeJob(item);
    if (job) jobs.push(job);
    else warnings.push({ message: `cron 配置中存在非法任务条目，已跳过：${JSON.stringify(item).slice(0, 120)}` });
  }
  return { jobs, warnings, corrupt: false };
}

/** 原子写整个任务清单（调用方负责先 load 再改再 save）。 */
export function saveCronJobs(jobs: CronJob[], homeDir: string = os.homedir()): void {
  const file = userCronConfigPath(homeDir);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const payload: CronStoreFile = { version: 1, jobs };
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 新任务输入（id/时间戳/派生字段由本函数生成） */
export interface AddCronJobInput {
  name: string;
  cron: string;
  prompt: string;
  cwd: string;
  enabled?: boolean;
  maxCostUsd?: number;
  /** F-22b 权限模式；缺省 'default' */
  permission?: 'plan' | 'default' | 'yolo';
  /** F-22b 有效期起点（ISO）；缺省长期有效 */
  validFrom?: string;
  /** F-22b 有效期终点（ISO）；缺省长期有效 */
  validUntil?: string;
  /** 从该时间起计算首次 nextRunAt；缺省 new Date() */
  from?: Date;
}

/**
 * 新增任务（写路径：load → 校验 → 追加 → save）。
 * 校验：name 非空且不与既有重名；cron 表达式合法（parse 失败原样抛出）；
 * cwd 解析为绝对路径。成功返回新任务（含预计算的 nextRunAt）。
 */
export function addCronJob(input: AddCronJobInput, homeDir: string = os.homedir()): CronJob {
  const { jobs, warnings, corrupt } = loadCronJobs(homeDir);
  if (corrupt) throw new Error(`cron 配置无法解析（${warnings[0]?.message ?? ''}），请手工修复后再试`);
  const name = input.name.trim();
  if (!name) throw new Error('任务名称不能为空');
  if (jobs.some((j) => j.name === name)) throw new Error(`任务名称已存在：${name}`);
  if (!input.prompt.trim()) throw new Error('任务描述（prompt）不能为空');
  const cwd = path.resolve(input.cwd);
  if (!fs.existsSync(cwd)) throw new Error(`运行目录不存在：${cwd}`);
  // 表达式合法性在此校验（非法直接抛错，不落库）
  const next = nextRun(input.cron, input.from ?? new Date());

  const now = new Date().toISOString();
  const job: CronJob = {
    id: `cron-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    cron: input.cron.trim(),
    prompt: input.prompt,
    cwd,
    enabled: input.enabled ?? true,
    ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
    ...(input.permission !== undefined ? { permission: input.permission } : {}),
    ...(input.validFrom !== undefined ? { validFrom: input.validFrom } : {}),
    ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
    createdAt: now,
    updatedAt: now,
    ...(next ? { nextRunAt: next.toISOString() } : {}),
    runs: [],
  };
  jobs.push(job);
  saveCronJobs(jobs, homeDir);
  return job;
}

/** 更新任务的补丁（F-22b：permission/validFrom/validUntil 支持 null = 清除恢复缺省；undefined = 不动） */
export interface CronJobPatch {
  name?: string;
  cron?: string;
  prompt?: string;
  cwd?: string;
  enabled?: boolean;
  maxCostUsd?: number;
  /** null = 清除（恢复默认权限）；undefined = 不动 */
  permission?: 'plan' | 'default' | 'yolo' | null;
  /** null = 清除（恢复长期有效）；undefined = 不动 */
  validFrom?: string | null;
  /** null = 清除（恢复长期有效）；undefined = 不动 */
  validUntil?: string | null;
}

/** 更新任务的可编辑字段（name/cron/prompt/cwd/enabled/maxCostUsd/permission/有效期）；返回更新后的任务。 */
export function updateCronJob(
  idOrName: string,
  patch: CronJobPatch,
  homeDir: string = os.homedir(),
): CronJob {
  const { jobs, warnings, corrupt } = loadCronJobs(homeDir);
  if (corrupt) throw new Error(`cron 配置无法解析（${warnings[0]?.message ?? ''}），请手工修复后再试`);
  const job = findCronJob(jobs, idOrName);
  if (!job) throw new Error(`未找到任务：${idOrName}`);
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error('任务名称不能为空');
    if (jobs.some((j) => j.id !== job.id && j.name === name)) throw new Error(`任务名称已存在：${name}`);
    job.name = name;
  }
  if (patch.cron !== undefined) {
    job.cron = patch.cron.trim();
    job.nextRunAt = nextRun(job.cron, new Date())?.toISOString(); // 表达式非法时在此抛出
  }
  if (patch.prompt !== undefined) job.prompt = patch.prompt;
  if (patch.cwd !== undefined) {
    const cwd = path.resolve(patch.cwd);
    if (!fs.existsSync(cwd)) throw new Error(`运行目录不存在：${cwd}`);
    job.cwd = cwd;
  }
  if (patch.enabled !== undefined) {
    job.enabled = patch.enabled;
    // 重新启用时从现在起重新计算下次运行，避免补跑停用期间积压的错过的时刻
    if (patch.enabled) job.nextRunAt = nextRun(job.cron, new Date())?.toISOString();
  }
  if (patch.maxCostUsd !== undefined) job.maxCostUsd = patch.maxCostUsd;
  // F-22b：null = 清除字段（存储 JSON 缺省即清除态，不落 null）；undefined = 不动
  if (patch.permission !== undefined) {
    if (patch.permission === null) delete job.permission;
    else job.permission = patch.permission;
  }
  if (patch.validFrom !== undefined) {
    if (patch.validFrom === null) delete job.validFrom;
    else job.validFrom = patch.validFrom;
  }
  if (patch.validUntil !== undefined) {
    if (patch.validUntil === null) delete job.validUntil;
    else job.validUntil = patch.validUntil;
  }
  job.updatedAt = new Date().toISOString();
  saveCronJobs(jobs, homeDir);
  return job;
}

/** 删除任务；返回被删任务。 */
export function removeCronJob(idOrName: string, homeDir: string = os.homedir()): CronJob {
  const { jobs, warnings, corrupt } = loadCronJobs(homeDir);
  if (corrupt) throw new Error(`cron 配置无法解析（${warnings[0]?.message ?? ''}），请手工修复后再试`);
  const idx = jobs.findIndex((j) => j.id === idOrName || j.name === idOrName);
  if (idx === -1) throw new Error(`未找到任务：${idOrName}`);
  const [removed] = jobs.splice(idx, 1);
  saveCronJobs(jobs, homeDir);
  return removed!;
}

/** 按 id 或 name 精确匹配查找（无写副作用，可直接用于只读场景）。 */
export function findCronJob(jobs: CronJob[], idOrName: string): CronJob | undefined {
  return jobs.find((j) => j.id === idOrName || j.name === idOrName);
}

// ── JSON 视图（Web /api/cron 传输口径：snake_case，与 usage/memory 端点一致）──

/** 运行记录 → 传输 JSON（result_preview 截断已在写入时完成，这里只做字段重命名） */
export function cronRunToJson(r: CronRunRecord): Record<string, unknown> {
  return {
    trigger: r.trigger,
    started_at: r.startedAt,
    finished_at: r.finishedAt,
    duration_ms: r.durationMs,
    status: r.status,
    exit_code: r.exitCode,
    ...(r.sessionId ? { session_id: r.sessionId } : {}),
    ...(r.costUsd !== undefined ? { cost_usd: r.costUsd } : {}),
    ...(r.turns !== undefined ? { turns: r.turns } : {}),
    ...(r.error ? { error: r.error } : {}),
    ...(r.resultPreview ? { result_preview: r.resultPreview } : {}),
  };
}

/** 任务 → 传输 JSON（清单/单查/编辑返回共用，字段口径见 docs/design-f22-cron.md §3） */
export function cronJobToJson(j: CronJob): Record<string, unknown> {
  return {
    id: j.id,
    name: j.name,
    cron: j.cron,
    prompt: j.prompt,
    cwd: j.cwd,
    enabled: j.enabled,
    ...(j.maxCostUsd !== undefined ? { max_cost_usd: j.maxCostUsd } : {}),
    ...(j.permission ? { permission: j.permission } : {}),
    ...(j.validFrom ? { valid_from: j.validFrom } : {}),
    ...(j.validUntil ? { valid_until: j.validUntil } : {}),
    created_at: j.createdAt,
    updated_at: j.updatedAt,
    ...(j.nextRunAt ? { next_run_at: j.nextRunAt } : {}),
    ...(j.runningSince ? { running_since: j.runningSince } : {}),
    ...(j.lastRun ? { last_run: cronRunToJson(j.lastRun) } : {}),
    runs: j.runs.map(cronRunToJson),
  };
}

// ── 内部 ────────────────────────────────────────────────────────────────────

/** 单条任务结构校验：必填字段齐全且类型正确才接受，否则返回 undefined（由调用方记 warning）。 */
function normalizeJob(raw: unknown): CronJob | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.name !== 'string') return undefined;
  if (typeof r.cron !== 'string' || typeof r.prompt !== 'string' || typeof r.cwd !== 'string') return undefined;
  if (typeof r.createdAt !== 'string' || typeof r.updatedAt !== 'string') return undefined;
  // F-22b 字段级降级：单字段非法只丢弃该字段（按缺省语义处理），不丢整条任务
  const permission = (r as { permission?: unknown }).permission;
  const validFrom = (r as { validFrom?: unknown }).validFrom;
  const validUntil = (r as { validUntil?: unknown }).validUntil;
  return {
    id: r.id,
    name: r.name,
    cron: r.cron,
    prompt: r.prompt,
    cwd: r.cwd,
    enabled: r.enabled !== false,
    ...(typeof r.maxCostUsd === 'number' ? { maxCostUsd: r.maxCostUsd } : {}),
    // permission ∉ 枚举 → 丢弃（按 'default' 处理）
    ...(typeof permission === 'string' && (CRON_PERMISSIONS as readonly string[]).includes(permission)
      ? { permission: permission as CronJob['permission'] }
      : {}),
    // 非 ISO 可解析字符串 → 丢弃（按长期有效处理）
    ...(typeof validFrom === 'string' && !Number.isNaN(Date.parse(validFrom)) ? { validFrom } : {}),
    ...(typeof validUntil === 'string' && !Number.isNaN(Date.parse(validUntil)) ? { validUntil } : {}),
    ...(typeof r.nextRunAt === 'string' ? { nextRunAt: r.nextRunAt } : {}),
    ...(typeof r.runningSince === 'string' ? { runningSince: r.runningSince } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(isRunRecord(r.lastRun) ? { lastRun: r.lastRun } : {}),
    runs: Array.isArray(r.runs) ? r.runs.filter(isRunRecord).slice(-MAX_RUN_HISTORY) : [],
  };
}

/** 运行记录结构校验（宽松：核心字段存在即可）。 */
function isRunRecord(raw: unknown): raw is CronRunRecord {
  if (raw === null || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return (
    typeof r.startedAt === 'string' &&
    typeof r.finishedAt === 'string' &&
    typeof r.status === 'string' &&
    (r.trigger === undefined || r.trigger === 'schedule' || r.trigger === 'manual')
  );
}
