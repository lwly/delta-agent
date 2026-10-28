/**
 * F-47 Web 内置终端：node-pty 多路复用管理层（可选依赖，缺失/不可用时明确降级）。
 *
 * 职责边界（design-f41-f53 F-47）：
 * - 终端是用户本人操作，**物理隔离**于 Agent 工具沙箱/权限模式（不经确认流，UI 常驻警示）；
 * - pty 会话上限（默认 4）+ 空闲回收（默认 30min）+ serve 退出全杀；
 * - 工作根创建时固化（resolveWorkRoot），切会话/分支/worktree 后旧 pty 保留、新开跟随（D4）；
 * - WS 断线：pty 保留 + 输出环形缓冲（重连回放）；pty 退出 → 移除会话并通知。
 *
 * WS 协议（JSON 文本帧）：
 *   client → server: {type:'input',data} | {type:'resize',cols,rows}
 *   server → client: {type:'ready',terminalId,workRoot,shell} | {type:'output',data}
 *                    | {type:'exit',exitCode} | {type:'error',message}
 */
import type { WebSocket } from 'ws';

/** node-pty 模块的最小类型面（optionalDependencies，缺失时不得阻塞加载） */
interface IPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  readonly pid: number;
}
type PtyModule = {
  spawn(file: string, args: string[], opts: { name: string; cwd: string; env: Record<string, string> }): IPty;
};

export interface TerminalManagerDeps {
  /** 会话工作根解析（hub 提供：worktree 绑定跟随 F-37） */
  resolveWorkRoot(sessionId: string): string | undefined;
  /** pty 并发上限（默认 4） */
  maxSessions?: number;
  /** 空闲回收毫秒（默认 30min） */
  idleMs?: number;
  /** pty 模块注入（测试用 Fake；缺省动态 import('node-pty')）。显式传 null = 强制不可用（降级路径测试） */
  pty?: PtyModule | null;
}

interface PtySession {
  id: string;
  sessionId: string;
  workRoot: string;
  shell: string;
  pty: IPty;
  /** 重连回放缓冲（上限 8KB） */
  buffer: string;
  ws: WebSocket | null;
  lastActive: number;
}

export interface TerminalCreateResult {
  ok: boolean;
  terminalId?: string;
  workRoot?: string;
  shell?: string;
  reason?: string;
}

/** node-pty 可用性探测（缓存；缺失/不可用均为明确降级，不阻塞 serve 启动） */
let ptyModule: PtyModule | undefined;
let ptyUnavailable: string | undefined;

async function loadPty(): Promise<PtyModule | undefined> {
  if (ptyModule) return ptyModule;
  if (ptyUnavailable) return undefined;
  try {
    ptyModule = (await import('node-pty')) as unknown as PtyModule;
    return ptyModule;
  } catch (e) {
    ptyUnavailable = `node-pty 不可用（${(e as Error).message}）；可重装依赖或使用「在文件管理器中显示」替代`;
    return undefined;
  }
}

export class TerminalManager {
  private sessions = new Map<string, PtySession>();
  private readonly maxSessions: number;
  private readonly idleMs: number;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: TerminalManagerDeps) {
    if (deps.pty) {
      ptyModule = deps.pty;
      ptyUnavailable = undefined;
    } else if (deps.pty === null) {
      // 显式 null = 强制不可用（降级路径测试；生产不受影响——不传走动态 import）
      ptyModule = undefined;
      ptyUnavailable = 'node-pty 不可用（测试注入 null）';
    }
    this.maxSessions = deps.maxSessions ?? 4;
    this.idleMs = deps.idleMs ?? 30 * 60_000;
    this.idleTimer = setInterval(() => this.reapIdle(), 60_000);
    this.idleTimer.unref?.();
  }

  /** 供 GET /api/terminal/status：能力与原因透出（UI 决定渲染内嵌终端还是降级） */
  async status(): Promise<{ available: boolean; reason?: string; active: number; max: number }> {
    const mod = this.deps.pty === null ? undefined : this.deps.pty ?? await loadPty();
    return {
      available: mod !== undefined && this.sessions.size < this.maxSessions,
      reason: ptyUnavailable ?? (this.sessions.size >= this.maxSessions ? `已达并发上限（${this.maxSessions}）` : undefined),
      active: this.sessions.size,
      max: this.maxSessions,
    };
  }

  /** 创建 pty（cwd = 会话工作根，创建时固化）。 */
  async create(sessionId: string): Promise<TerminalCreateResult> {
    const mod = this.deps.pty === null ? undefined : this.deps.pty ?? await loadPty();
    if (!mod) return { ok: false, reason: ptyUnavailable ?? 'node-pty 不可用' };
    if (this.sessions.size >= this.maxSessions) {
      return { ok: false, reason: `已达并发上限（${this.maxSessions}），请先关闭空闲终端` };
    }
    const workRoot = this.deps.resolveWorkRoot(sessionId);
    if (!workRoot) return { ok: false, reason: '会话不存在或项目根不可用' };
    const shell = detectInteractiveShell();
    let pty: IPty;
    try {
      pty = mod.spawn(shell, [], {
        name: 'xterm-256color',
        cwd: workRoot,
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
      });
    } catch (e) {
      return { ok: false, reason: `shell 启动失败：${(e as Error).message}` };
    }
    const id = `tty_${sessionId.slice(0, 8)}_${Date.now().toString(36)}`;
    const session: PtySession = { id, sessionId, workRoot, shell, pty, buffer: '', ws: null, lastActive: Date.now() };
    pty.onData((data) => {
      session.buffer = (session.buffer + data).slice(-8192);
      session.ws?.readyState === 1 && session.ws.send(JSON.stringify({ type: 'output', data }));
    });
    pty.onExit(({ exitCode }) => {
      session.ws?.readyState === 1 && session.ws.send(JSON.stringify({ type: 'exit', exitCode }));
      this.sessions.delete(id);
    });
    this.sessions.set(id, session);
    return { ok: true, terminalId: id, workRoot, shell };
  }

  /** WS 接入：回放环形缓冲后接管输出；旧连接直接让位（单写者语义）。 */
  attach(terminalId: string, ws: WebSocket): void {
    const s = this.sessions.get(terminalId);
    if (!s) {
      ws.send(JSON.stringify({ type: 'error', message: '终端会话不存在或已退出' }));
      ws.close();
      return;
    }
    s.ws = ws;
    s.lastActive = Date.now();
    ws.send(JSON.stringify({ type: 'ready', terminalId, workRoot: s.workRoot, shell: s.shell }));
    if (s.buffer) ws.send(JSON.stringify({ type: 'output', data: s.buffer }));
  }

  handleClientMessage(terminalId: string, raw: string): void {
    const s = this.sessions.get(terminalId);
    if (!s) return;
    s.lastActive = Date.now();
    let msg: { type?: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'input' && typeof msg.data === 'string') s.pty.write(msg.data);
    else if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
      const cols = Math.min(Math.max(msg.cols!, 2), 500);
      const rows = Math.min(Math.max(msg.rows!, 2), 300);
      try {
        s.pty.resize(cols, rows);
      } catch {
        // pty 已退出等竞态：忽略（exit 事件随后清理）
      }
    }
  }

  detach(terminalId: string, ws: WebSocket): void {
    const s = this.sessions.get(terminalId);
    if (s && s.ws === ws) s.ws = null;
  }

  /** 用户主动关闭终端（杀进程并移除）。 */
  close(terminalId: string): boolean {
    const s = this.sessions.get(terminalId);
    if (!s) return false;
    this.sessions.delete(terminalId);
    try {
      s.pty.kill();
    } catch {
      // 已退出：忽略
    }
    return true;
  }

  /** 空闲回收（仅回收无前端连接的会话；有连接的以 lastActive 判定依旧适用——连接本身会刷新）。 */
  private reapIdle(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastActive > this.idleMs) {
        s.ws?.readyState === 1 && s.ws.send(JSON.stringify({ type: 'error', message: '终端空闲超时，已自动回收' }));
        this.close(id);
      }
    }
  }

  /** serve 退出全杀（防孤儿 shell 进程）。 */
  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }
}

/** 交互式 shell 选择（login shell 语义由 pty 自身提供；Windows 走 powershell -NoLogo）。 */
function detectInteractiveShell(): string {
  if (process.platform === 'win32') return process.env.ComSpec?.toLowerCase().includes('powershell') ? process.env.ComSpec : 'powershell.exe';
  return process.env.SHELL?.trim() || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
}
