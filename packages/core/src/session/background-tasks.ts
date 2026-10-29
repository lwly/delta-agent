/**
 * F-54 会话内后台任务：run_command 的 run_in_background 执行后端。
 *
 * 职责（设计见 docs/design-f54-background-tasks.md）：
 * - spawn 后不等待完成，立即返回任务 id；模型可稍后用 task_output 工具取结果
 * - 输出环形收集（保尾巴），完成后保留记录供 task_output 查询
 * - kill 终止单个任务（SIGKILL）；killAll 供 serve dispose 兜底（防孤儿进程）
 * - 与运行的 AbortSignal 解耦：本轮 abort / 会话停止不影响后台任务（这正是后台语义）
 *
 * 已知限制（v1 明确不做）：不持久化（serve 重启即丢）；沙箱模式下不支持后台执行；
 * 完成不产生 AgentEvent（Web 侧轮询 GET /api/sessions/:id/background-tasks）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { detectShell } from '../engine/shell.js';

/** 单任务输出保留上限（字符，保尾巴；task_output 只回尾段） */
export const MAX_BG_OUTPUT = 50_000;
/** 每会话保留的已完成任务记录上限（超限淘汰最旧，防无界增长） */
export const MAX_FINISHED_PER_SESSION = 30;

export type BackgroundTaskStatus = 'running' | 'done' | 'failed' | 'killed';

export interface BackgroundTaskView {
  id: string;
  session_id: string;
  command: string;
  /** 模型给的短描述（缺省 = 命令前 60 字符）；Web 任务条展示用 */
  description: string;
  started_at: number;
  finished_at: number | null;
  status: BackgroundTaskStatus;
  exit_code: number | null;
}

interface BgTask {
  id: string;
  sessionId: string;
  command: string;
  description: string;
  startedAt: number;
  finishedAt: number | null;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  child: ChildProcess | null;
  output: string;
  killedByUser: boolean;
}

let seq = 0;

function nextId(): string {
  seq += 1;
  return `bg_${Date.now().toString(36)}_${seq}`;
}

export class BackgroundTaskManager {
  private tasks = new Map<string, BgTask>();

  /**
   * 启动后台命令并立即返回任务 id。cwd 必须是已解析的安全路径
   * （工具层先过 resolveInSandbox，本层不做沙箱判定）。
   */
  start(sessionId: string, command: string, cwd: string, description?: string): string {
    const id = nextId();
    const task: BgTask = {
      id,
      sessionId,
      command,
      description: (description ?? '').trim() || command.slice(0, 60),
      startedAt: Date.now(),
      finishedAt: null,
      status: 'running',
      exitCode: null,
      child: null,
      output: '',
      killedByUser: false,
    };
    this.tasks.set(id, task);

    try {
      const adapter = detectShell();
      const child = spawn(adapter.bin, adapter.args(command), {
        cwd,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      task.child = child;
      child.stdout?.on('data', (d: Buffer) => this.appendOutput(task, d.toString('utf8')));
      child.stderr?.on('data', (d: Buffer) => this.appendOutput(task, d.toString('utf8')));
      child.on('error', (e: Error) => {
        this.appendOutput(task, String(e.message));
        this.finish(task, -1);
      });
      child.on('close', (code) => this.finish(task, code));
    } catch (e) {
      this.appendOutput(task, String((e as Error).message));
      this.finish(task, -1);
    }
    return id;
  }

  /** 任务视图列表（running 在前、按开始时间倒序；sessionId 缺省 = 全部） */
  list(sessionId?: string): BackgroundTaskView[] {
    const all = [...this.tasks.values()]
      .filter((t) => sessionId === undefined || t.sessionId === sessionId)
      .map(toView);
    return all.sort((a, b) => {
      if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1;
      return b.started_at - a.started_at;
    });
  }

  /** 终止单个任务；返回 false = 不存在或已结束 */
  kill(sessionId: string, id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.sessionId !== sessionId || task.status !== 'running') return false;
    task.killedByUser = true;
    try {
      task.child?.kill('SIGKILL');
    } catch {
      /* 已退出等场景：close 兜底收尾 */
    }
    return true;
  }

  /** 状态 + 输出尾（task_output 工具数据源；未知 id 返回 undefined） */
  getOutput(id: string): { status: BackgroundTaskStatus; exit_code: number | null; output: string } | undefined {
    const task = this.tasks.get(id);
    if (!task) return undefined;
    return { status: task.status, exit_code: task.exitCode, output: task.output };
  }

  /** serve dispose 兜底：全杀运行中任务（防孤儿进程） */
  killAll(): void {
    for (const task of this.tasks.values()) {
      if (task.status !== 'running') continue;
      task.killedByUser = true;
      try {
        task.child?.kill('SIGKILL');
      } catch {
        /* 忽略 */
      }
    }
  }

  private appendOutput(task: BgTask, chunk: string): void {
    task.output += chunk;
    if (task.output.length > MAX_BG_OUTPUT) task.output = task.output.slice(-MAX_BG_OUTPUT);
  }

  private finish(task: BgTask, code: number | null): void {
    if (task.status !== 'running') return;
    task.status = task.killedByUser ? 'killed' : code === 0 ? 'done' : 'failed';
    task.exitCode = code;
    task.finishedAt = Date.now();
    task.child = null;
    this.pruneFinished(task.sessionId);
  }

  /** 每会话已完成记录封顶（F-54：超限淘汰最旧，运行中不受影响） */
  private pruneFinished(sessionId: string): void {
    const finished = [...this.tasks.values()]
      .filter((t) => t.sessionId === sessionId && t.status !== 'running')
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const t of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_PER_SESSION))) {
      this.tasks.delete(t.id);
    }
  }
}

function toView(t: BgTask): BackgroundTaskView {
  return {
    id: t.id,
    session_id: t.sessionId,
    command: t.command,
    description: t.description,
    started_at: t.startedAt,
    finished_at: t.finishedAt,
    status: t.status,
    exit_code: t.exitCode,
  };
}
