/**
 * F-27 Hook 系统 —— 生命周期钩子，用户注入自定义逻辑
 * （保存前 lint、禁改 main、任务结束后跑测试等）。
 *
 * 配置：~/.y-zero/hooks.json（用户级）+ .y-zero/hooks.json（项目级），
 * 两个来源的钩子都执行（用户级先、项目级后）。
 *
 * 事件：
 * - PreToolUse   工具执行前（可阻断：exit 2 = 阻断，stderr 作为原因回传给模型）
 * - PostToolUse  工具执行后（仅记录，不影响结果）
 * - SessionStart 会话/进程启动
 * - Stop         单次任务运行结束
 * - SessionEnd   会话/进程结束
 *
 * 执行语义：spawn shell，事件上下文以 JSON 写入 stdin；退出码 0=成功，
 * PreToolUse 专有：2=阻断；其余非 0=告警放行；超时=告警放行（默认 10s）。
 * 钩子失败永不阻断主流程（PostToolUse 及生命周期事件仅记录）。
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type HookEvent = 'PreToolUse' | 'PostToolUse' | 'SessionStart' | 'SessionEnd' | 'Stop';

export const HOOK_EVENTS: readonly HookEvent[] = [
  'PreToolUse',
  'PostToolUse',
  'SessionStart',
  'SessionEnd',
  'Stop',
];

export interface HookDef {
  event: HookEvent;
  /** 工具匹配器：缺省或 '*' = 全部工具；否则精确匹配工具名（仅 PreToolUse/PostToolUse 生效） */
  tool?: string;
  /** shell 命令（工作目录 = 项目根） */
  command: string;
  /** 超时毫秒（默认 10_000） */
  timeout_ms?: number;
  /** 加载来源（load 时自动标注，不来自配置文件） */
  source?: 'user' | 'project';
}

export interface HookPayload {
  event: HookEvent;
  timestamp: string;
  session_id?: string;
  project_id?: string;
  /** 工具事件附带给 */
  tool?: string;
  args?: Record<string, unknown>;
  result?: { ok: boolean; content: string; error?: string };
}

export interface HookOutcome {
  hook: HookDef;
  ok: boolean;
  exitCode: number | null;
  blocked?: boolean;
  reason?: string;
  timedOut?: boolean;
  stderr: string;
}

export interface PreToolUseVerdict {
  blocked: boolean;
  reason?: string;
  outcomes: HookOutcome[];
}

export interface HookFiles {
  hooks: HookDef[];
  user: HookDef[];
  project: HookDef[];
  errors: string[];
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** 读取单个 hooks.json（支持 { hooks: [...] } 或裸数组）；缺失返回空，坏文件记错误。 */
function readHookFile(file: string, source: 'user' | 'project', errors: string[]): HookDef[] {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list: unknown[] = Array.isArray(raw) ? raw : (raw?.hooks ?? []);
    const out: HookDef[] = [];
    for (const item of list) {
      const h = item as Partial<HookDef>;
      if (!h || typeof h.command !== 'string' || !h.command.trim()) continue;
      if (!HOOK_EVENTS.includes(h.event as HookEvent)) {
        errors.push(`${source}: 未知事件 ${String(h.event)}（跳过）`);
        continue;
      }
      out.push({
        event: h.event as HookEvent,
        tool: typeof h.tool === 'string' && h.tool !== '' ? h.tool : undefined,
        command: h.command,
        timeout_ms: typeof h.timeout_ms === 'number' && h.timeout_ms > 0 ? h.timeout_ms : undefined,
        source,
      });
    }
    return out;
  } catch (e) {
    errors.push(`${source}: ${(e as Error).message}`);
    return [];
  }
}

/** 加载用户级 + 项目级 hooks.json（缺失/坏文件不抛错，错误记录在 errors）。 */
export function loadHookFiles(projectRoot: string, homeDir: string = os.homedir()): HookFiles {
  const errors: string[] = [];
  const user = readHookFile(path.join(homeDir, '.y-zero', 'hooks.json'), 'user', errors);
  const project = readHookFile(path.join(projectRoot, '.y-zero', 'hooks.json'), 'project', errors);
  return { hooks: [...user, ...project], user, project, errors };
}

/** 工具匹配：缺省/'*' = 全部；否则精确匹配。 */
export function hookMatches(hook: HookDef, tool?: string): boolean {
  if (hook.event !== 'PreToolUse' && hook.event !== 'PostToolUse') return true;
  if (!hook.tool || hook.tool === '*') return true;
  return hook.tool === tool;
}

export class HookManager {
  readonly projectRoot: string;

  constructor(
    readonly hooks: HookDef[],
    projectRoot: string,
    /** 钩子输出观察口（CLI/Web 可接日志；缺省丢弃） */
    private readonly onOutcome?: (o: HookOutcome) => void,
  ) {
    this.projectRoot = projectRoot;
  }

  static load(projectRoot: string, homeDir?: string, onOutcome?: (o: HookOutcome) => void): HookManager {
    const files = loadHookFiles(projectRoot, homeDir);
    return new HookManager(files.hooks, projectRoot, onOutcome);
  }

  has(event: HookEvent, tool?: string): boolean {
    return this.hooks.some((h) => h.event === event && hookMatches(h, tool));
  }

  /** PreToolUse：任一钩子 exit 2 即阻断（首因返回）；超时/其他非 0 记告警放行。 */
  async preToolUse(
    tool: string,
    args: Record<string, unknown> | undefined,
    session: { sessionId?: string; projectId?: string },
  ): Promise<PreToolUseVerdict> {
    const targets = this.hooks.filter((h) => h.event === 'PreToolUse' && hookMatches(h, tool));
    if (targets.length === 0) return { blocked: false, outcomes: [] };
    const outcomes: HookOutcome[] = [];
    let blocked = false;
    let reason: string | undefined;
    for (const hook of targets) {
      const o = await this.run(hook, {
        event: 'PreToolUse',
        timestamp: new Date().toISOString(),
        session_id: session.sessionId,
        project_id: session.projectId,
        tool,
        args: args ?? {},
      });
      outcomes.push(o);
      this.onOutcome?.(o);
      if (o.blocked) {
        blocked = true;
        reason = reason ?? o.reason;
      }
    }
    return { blocked, reason, outcomes };
  }

  /** PostToolUse：结果只记录，永不影响工具结果。 */
  async postToolUse(
    tool: string,
    args: Record<string, unknown> | undefined,
    result: { ok: boolean; content: string; error?: string },
    session: { sessionId?: string; projectId?: string },
  ): Promise<HookOutcome[]> {
    const targets = this.hooks.filter((h) => h.event === 'PostToolUse' && hookMatches(h, tool));
    const outcomes: HookOutcome[] = [];
    for (const hook of targets) {
      const o = await this.run(hook, {
        event: 'PostToolUse',
        timestamp: new Date().toISOString(),
        session_id: session.sessionId,
        project_id: session.projectId,
        tool,
        args: args ?? {},
        result: { ok: result.ok, content: result.content, error: result.error },
      });
      outcomes.push(o);
      this.onOutcome?.(o);
    }
    return outcomes;
  }

  /** 生命周期事件（SessionStart / SessionEnd / Stop）。 */
  async emit(
    event: Exclude<HookEvent, 'PreToolUse' | 'PostToolUse'>,
    session: { sessionId?: string; projectId?: string } = {},
  ): Promise<HookOutcome[]> {
    const targets = this.hooks.filter((h) => h.event === event);
    const outcomes: HookOutcome[] = [];
    for (const hook of targets) {
      const o = await this.run(hook, {
        event,
        timestamp: new Date().toISOString(),
        session_id: session.sessionId,
        project_id: session.projectId,
      });
      outcomes.push(o);
      this.onOutcome?.(o);
    }
    return outcomes;
  }

  /** 执行单个钩子：stdin 注入 JSON payload；exit 2（仅 PreToolUse）→ blocked。 */
  private run(hook: HookDef, payload: HookPayload): Promise<HookOutcome> {
    return new Promise((resolve) => {
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const timeoutMs = hook.timeout_ms ?? DEFAULT_TIMEOUT_MS;

      let child;
      try {
        child = spawn(hook.command, {
          shell: true,
          cwd: this.projectRoot,
          stdio: ['pipe', 'ignore', 'pipe'],
        });
      } catch (e) {
        resolve({
          hook,
          ok: false,
          exitCode: null,
          stderr: `spawn failed: ${(e as Error).message}`,
        });
        return;
      }

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const blocked = !timedOut && exitCode === 2;
        resolve({
          hook,
          ok: !timedOut && exitCode === 0,
          exitCode,
          blocked,
          timedOut,
          reason: blocked
            ? stderr.trim() || `hook 阻断（${hook.command}）`
            : timedOut
              ? `hook 超时（${timeoutMs}ms）`
              : undefined,
          stderr,
        });
      };

      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
        if (stderr.length > 8192) stderr = stderr.slice(0, 8192);
      });
      child.on('error', (e) => {
        stderr += `spawn error: ${e.message}`;
        finish(null);
      });
      child.on('close', (code) => finish(code));

      try {
        child.stdin?.end(JSON.stringify(payload, null, 2));
      } catch {
        // stdin 写入失败不改变退出语义
      }
    });
  }
}
