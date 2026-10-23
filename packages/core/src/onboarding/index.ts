/**
 * F-34 项目 onboarding：新项目首次启动自动扫描（docs/prd-f34-project-onboarding.md）
 *  - 用一次 LLM 调用从扫描输入生成「项目摘要 + agent.md 草案 + MEMORY.md 草案」（仿 distillMemories 的一次性调用模式）
 *  - 草案落成 `*.draft` 文件，`yzero onboarding confirm` 采纳后改名到位；目标已存在**绝不覆盖**（只提示手工合并）
 *  - 状态存 `.y-zero/onboarding.json`（tmp+rename 原子写；坏 JSON 视为 pending，永不 throw）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LLMProvider } from '@y-zero/shared';
import { scanProjectLayout, type ProjectScan, type ScanOptions, SCAN_SKIP_DIRS } from './scan.js';

// 扫描器符号随模块一起导出（core index.ts 从本模块统一 re-export）
export { scanProjectLayout, SCAN_SKIP_DIRS };
export type { ProjectScan, ScanOptions };

export type OnboardingStatus = 'pending' | 'draft' | 'confirmed' | 'skipped';

export interface OnboardingState {
  status: OnboardingStatus;
  /** 草案生成时间（ISO 8601） */
  generatedAt?: string;
  /** 生成草案使用的模型 */
  model?: string;
  /** 项目摘要快照（status 展示用） */
  summary?: string;
  /** 是否允许首次注册时自动扫描（缺省 true；显式 false 后首次启动不再自动跑） */
  auto?: boolean;
}

export interface RunOnboardingResult {
  /** true = 未执行（状态不是 pending 且未 force，或 auto 已关） */
  skipped: boolean;
  reason?: string;
  summary?: string;
  /** 草案文件路径（skipped 时缺省） */
  agentMdDraftPath?: string;
  memoryMdDraftPath?: string;
}

export interface ConfirmOnboardingResult {
  /** 已采纳（草案改名到位）的目标文件 */
  applied: string[];
  /** 目标已存在而被跳过、需手工合并的草案文件 */
  skipped: Array<{ draft: string; target: string }>;
  status: OnboardingStatus;
}

// ── 路径约定 ────────────────────────────────────────────────────────────────

/** 状态文件路径：`<root>/.y-zero/onboarding.json` */
export function onboardingStatePath(projectRoot: string): string {
  return path.join(projectRoot, '.y-zero', 'onboarding.json');
}

/** agent.md 草案路径：`<root>/.y-zero/agent.md.draft` */
export function agentMdDraftPath(projectRoot: string): string {
  return path.join(projectRoot, '.y-zero', 'agent.md.draft');
}

/** MEMORY.md 草案路径：`<root>/MEMORY.md.draft` */
export function memoryMdDraftPath(projectRoot: string): string {
  return path.join(projectRoot, 'MEMORY.md.draft');
}

/** agent.md 正式目标：`<root>/.y-zero/agent.md`（Prompt 组装的静态记忆来源之一） */
export function agentMdTargetPath(projectRoot: string): string {
  return path.join(projectRoot, '.y-zero', 'agent.md');
}

/** MEMORY.md 正式目标：`<root>/MEMORY.md` */
export function memoryMdTargetPath(projectRoot: string): string {
  return path.join(projectRoot, 'MEMORY.md');
}

// ── 状态读写（读永不 throw；写 tmp+rename 原子）────────────────────────────

/**
 * 读取 onboarding 状态。文件缺失 / 坏 JSON / 非对象一律视为
 * `{ status: 'pending' }`（坏文件不覆盖，待下次成功写入时自然修复）。
 */
export function loadOnboardingState(projectRoot: string): OnboardingState {
  try {
    const file = onboardingStatePath(projectRoot);
    if (!fs.existsSync(file)) return { status: 'pending' };
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'pending' };
    const r = raw as Record<string, unknown>;
    const status = r.status;
    return {
      status: status === 'draft' || status === 'confirmed' || status === 'skipped' ? status : 'pending',
      generatedAt: typeof r.generatedAt === 'string' ? r.generatedAt : undefined,
      model: typeof r.model === 'string' ? r.model : undefined,
      summary: typeof r.summary === 'string' ? r.summary : undefined,
      auto: typeof r.auto === 'boolean' ? r.auto : undefined,
    };
  } catch {
    return { status: 'pending' };
  }
}

/** 原子写入状态（tmp + rename；目录自动创建）。 */
export function saveOnboardingState(projectRoot: string, state: OnboardingState): void {
  const file = onboardingStatePath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 原子写文本文件（目录自动创建）。 */
function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/** 首次注册后是否应自动扫描：状态为 pending（含无状态文件）且 auto 未显式关闭。 */
export function shouldAutoOnboard(projectRoot: string): boolean {
  const state = loadOnboardingState(projectRoot);
  return state.status === 'pending' && state.auto !== false;
}

// ── LLM 生成（仿 distillMemories：system 约束 JSON + 容错解析）──────────────

const ONBOARDING_SYSTEM = `你是项目 onboarding 分析器。根据给定的项目目录树、README 与工程清单，产出项目静态记忆草案。
严格按以下分段格式输出（三段都要有，段标记独占一行，不要输出其它内容、不要用 markdown 围栏）：
===SUMMARY===
一段话项目摘要（120 字内：项目是什么、技术栈、模块划分）
===AGENT_MD===
给 AI 编码代理看的项目指令草案（Markdown）：含 ## 项目摘要、## 目录结构、## 工作约定 三个小节；全文控制在 40 行内；只依据给定材料可推断的事实，不要臆造；无把握的条目标注（待确认）
===MEMORY_MD===
团队共享静态记忆草案（Markdown）：5-10 条以 '- ' 开头的条目（技术栈、关键目录、构建/测试命令等可直接从材料推断的事实）；无材料支撑时本段留空`;

export interface RunOnboardingOptions {
  projectRoot: string;
  provider: LLMProvider;
  model: string;
  signal?: AbortSignal;
  /** 忽略状态强制重新生成（结果直接覆盖草案） */
  force?: boolean;
}

/**
 * 扫描 + 生成草案：状态非 pending 且未 force 时跳过；目录为空（tree 无内容）时跳过。
 * LLM 调用或解析失败会 throw（由调用方决定提示方式），状态保持在 pending 以便重试。
 */
export async function runOnboardingScan(opts: RunOnboardingOptions): Promise<RunOnboardingResult> {
  const state = loadOnboardingState(opts.projectRoot);
  if (!opts.force && state.status !== 'pending') {
    return { skipped: true, reason: `onboarding 状态为 ${state.status}（--force 可重新生成）` };
  }
  if (state.auto === false && !opts.force) {
    return { skipped: true, reason: 'onboarding.auto 已关闭' };
  }

  const scan: ProjectScan = scanProjectLayout(opts.projectRoot);
  if (!scan.tree.trim()) {
    return { skipped: true, reason: '项目目录为空或不可读，无内容可扫描' };
  }

  let text = '';
  for await (const ev of opts.provider.chat({
    messages: [
      { role: 'system', content: ONBOARDING_SYSTEM },
      { role: 'user', content: scan.text },
    ],
    tools: [],
    model: opts.model,
    maxTokens: 4096,
    signal: opts.signal,
  })) {
    if (ev.type === 'text_delta') text += ev.text;
    if (ev.type === 'error') throw new Error(`onboarding llm error: ${ev.message}`);
  }

  const parsed = parseDraft(text);
  if (!parsed) {
    // 附上原始输出头尾片段便于排查（截断 / 偏离格式都会在两端露馅）
    const t = text.trim();
    const preview = t.length > 400 ? `${t.slice(0, 200)}\n…（省略 ${t.length - 400} 字）…\n${t.slice(-200)}` : t;
    throw new Error(`onboarding 输出解析失败（未得到合法 JSON）：${preview || '（空输出）'}`);
  }

  const agentDraft = agentMdDraftPath(opts.projectRoot);
  const memoryDraft = memoryMdDraftPath(opts.projectRoot);
  writeFileAtomic(agentDraft, `${parsed.agentMd.trim()}\n`);
  writeFileAtomic(memoryDraft, `${parsed.memoryMd.trim()}\n`);
  saveOnboardingState(opts.projectRoot, {
    status: 'draft',
    generatedAt: new Date().toISOString(),
    model: opts.model,
    summary: parsed.summary.trim(),
    auto: state.auto,
  });
  return {
    skipped: false,
    summary: parsed.summary.trim(),
    agentMdDraftPath: agentDraft,
    memoryMdDraftPath: memoryDraft,
  };
}

/**
 * 解析 LLM 输出：优先按分段标记（===SUMMARY=== 等，对弱模型最稳健——
 * Markdown 正文里的换行/引号/反引号都无需转义）；没有标记时兜底尝试 JSON（围栏容错）。
 */
function parseDraft(text: string): { summary: string; agentMd: string; memoryMd: string } | undefined {
  const sections = parseMarkedSections(text);
  if (sections) {
    if (!sections.summary.trim() || !sections.agentMd.trim()) return undefined;
    return sections;
  }
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1]! : text;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    const raw = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    if (typeof raw.summary !== 'string' || typeof raw.agentMd !== 'string') return undefined;
    return {
      summary: raw.summary,
      agentMd: raw.agentMd,
      memoryMd: typeof raw.memoryMd === 'string' ? raw.memoryMd : '',
    };
  } catch {
    return undefined;
  }
}

/** 按独占一行的 `===NAME===` 标记切分输出段（NAME ∈ SUMMARY / AGENT_MD / MEMORY_MD）。 */
function parseMarkedSections(text: string): { summary: string; agentMd: string; memoryMd: string } | undefined {
  const names = ['SUMMARY', 'AGENT_MD', 'MEMORY_MD'] as const;
  const marks: Array<{ name: (typeof names)[number]; start: number; contentStart: number }> = [];
  for (const name of names) {
    const re = new RegExp(`^===\\s*${name}\\s*===\\s*$`, 'm');
    const m = re.exec(text);
    if (!m || m.index < 0) return undefined; // 缺任一段标记 → 走兜底
    marks.push({ name, start: m.index, contentStart: m.index + m[0].length });
  }
  marks.sort((a, b) => a.start - b.start);
  const pick = (i: number): string =>
    i + 1 < marks.length ? text.slice(marks[i]!.contentStart, marks[i + 1]!.start) : text.slice(marks[i]!.contentStart);
  return {
    summary: pick(marks.findIndex((m) => m.name === 'SUMMARY')).trim(),
    agentMd: pick(marks.findIndex((m) => m.name === 'AGENT_MD')).trim(),
    memoryMd: pick(marks.findIndex((m) => m.name === 'MEMORY_MD')).trim(),
  };
}

// ── 采纳 / 跳过 ─────────────────────────────────────────────────────────────

/**
 * 采纳草案：草案改名到位（`.y-zero/agent.md` / `MEMORY.md`）。
 * 目标文件已存在时**绝不覆盖**（团队共享文件可能含手工维护内容），归入 skipped 供手工合并。
 */
export function confirmOnboarding(projectRoot: string): ConfirmOnboardingResult {
  const pairs: Array<{ draft: string; target: string }> = [
    { draft: agentMdDraftPath(projectRoot), target: agentMdTargetPath(projectRoot) },
    { draft: memoryMdDraftPath(projectRoot), target: memoryMdTargetPath(projectRoot) },
  ];
  const applied: string[] = [];
  const skipped: ConfirmOnboardingResult['skipped'] = [];
  for (const p of pairs) {
    if (!fs.existsSync(p.draft)) continue;
    if (fs.existsSync(p.target)) {
      skipped.push({ draft: p.draft, target: p.target });
      continue;
    }
    fs.mkdirSync(path.dirname(p.target), { recursive: true });
    fs.renameSync(p.draft, p.target);
    applied.push(p.target);
  }
  const state = loadOnboardingState(projectRoot);
  const next: OnboardingState = { ...state, status: 'confirmed' };
  saveOnboardingState(projectRoot, next);
  return { applied, skipped, status: next.status };
}

/** 跳过 onboarding（不再自动扫描；草案保留待手工处理）。 */
export function skipOnboarding(projectRoot: string): OnboardingState {
  const state = loadOnboardingState(projectRoot);
  const next: OnboardingState = { ...state, status: 'skipped' };
  saveOnboardingState(projectRoot, next);
  return next;
}

// ── 首次注册自动触发（三端入口共用）────────────────────────────────────────

export interface AutoOnboardOptions {
  projectRoot: string;
  provider: LLMProvider;
  model: string;
  signal?: AbortSignal;
}

/**
 * 首次注册项目后的自动扫描入口：仅当 shouldAutoOnboard 为真时执行一次扫描。
 * 返回 undefined 表示未触发或扫描跳过；失败直接 throw，由入口决定提示方式
 * （headless 同步等待并提示，TUI / serve fire-and-forget）。
 */
export async function autoOnboardProject(opts: AutoOnboardOptions): Promise<RunOnboardingResult | undefined> {
  if (!shouldAutoOnboard(opts.projectRoot)) return undefined;
  return runOnboardingScan(opts);
}
