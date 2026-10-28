/**
 * F-41 运行日志 —— 核心日志模块。
 *
 * RunLog 一体承担三个消费面（design-f41 D1）：
 *  - 内存环形缓冲（HTTP 尾读 /api/logs）
 *  - 实时订阅扇出（SSE /api/logs/stream）
 *  - 按日文件落盘（~/.delta/logs/serve-YYYYMMDD.log，人工 tail -f / 事后排查）
 *
 * 约束：
 *  - 写入/订阅回调一律 try/catch 静默，绝不影响主流程（AC-5，对齐 F-33 fire-and-forget）；
 *  - 同步写（appendFileSync）：本地单进程低频写入，异步化收益为零（D2）；
 *  - 目录/时钟/环形大小全部可注入（测试隔离，对齐 cronHomeDir 模式）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type LogLevel = 'info' | 'warn' | 'error';

export interface LogEntry {
  /** ISO 时间 */
  ts: string;
  level: LogLevel;
  /** 来源：'serve' | 'hub' | 'cron' | 'run' … */
  source: string;
  /** 会话维度日志携带（Web 过滤用） */
  sessionId?: string;
  message: string;
}

/** 埋点方（hub 等）依赖的最小接口（design-f41 D4，测试可伪造） */
export interface RunLogSink {
  append(level: LogLevel, source: string, message: string, sessionId?: string): void;
}

export interface RunLogOptions {
  /** 日志目录；缺省不落盘（仅内存 + 订阅，轻量宿主用） */
  dir?: string;
  /** 文件名（缺省 serve-YYYYMMDD.log，按日滚动） */
  fileName?: string;
  /** 环形缓冲条数（缺省 1000） */
  ringSize?: number;
  /** 构造时清理 N 天前的 .log 文件（缺省 14；0 = 不清理） */
  retentionDays?: number;
  /** 时钟（测试注入） */
  now?: () => Date;
}

const DEFAULT_RING_SIZE = 1000;
const DEFAULT_RETENTION_DAYS = 14;

export class RunLog implements RunLogSink {
  private readonly ring: LogEntry[] = [];
  private readonly ringSize: number;
  private readonly subs = new Set<(e: LogEntry) => void>();
  private readonly dir?: string;
  private readonly fileName?: string;
  private readonly now: () => Date;

  constructor(opts: RunLogOptions = {}) {
    this.ringSize = opts.ringSize ?? DEFAULT_RING_SIZE;
    this.dir = opts.dir;
    this.fileName = opts.fileName;
    this.now = opts.now ?? (() => new Date());
    if (this.dir) this.pruneOldLogs(opts.retentionDays ?? DEFAULT_RETENTION_DAYS);
  }

  append(level: LogLevel, source: string, message: string, sessionId?: string): void {
    const entry: LogEntry = {
      ts: this.now().toISOString(),
      level,
      source,
      message,
      ...(sessionId ? { sessionId } : {}),
    };
    // ① 环形缓冲
    this.ring.push(entry);
    if (this.ring.length > this.ringSize) this.ring.splice(0, this.ring.length - this.ringSize);
    // ② 订阅扇出（回调异常不影响其他订阅者与主流程）
    for (const fn of this.subs) {
      try {
        fn(entry);
      } catch {
        // 忽略订阅者异常
      }
    }
    // ③ 文件落盘（失败静默，AC-5）
    if (this.dir) this.writeToFile(entry);
  }

  /** 尾读（时间正序；limit 缺省 200、上限 ringSize；非正数返回空） */
  tail(limit = 200): LogEntry[] {
    const n = Math.max(0, Math.min(limit, this.ringSize));
    if (n === 0) return [];
    return this.ring.slice(-n);
  }

  /** 订阅实时日志（返回退订函数） */
  subscribe(fn: (e: LogEntry) => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  /** 单行文本格式：`<ISO> [LEVEL] [source] [sessionId] message`（D10，可直接 tail -f） */
  static format(entry: LogEntry): string {
    const sid = entry.sessionId ? ` [${entry.sessionId}]` : '';
    return `${entry.ts} [${entry.level.toUpperCase()}] [${entry.source}]${sid} ${entry.message}`;
  }

  private writeToFile(entry: LogEntry): void {
    try {
      fs.mkdirSync(this.dir!, { recursive: true });
      fs.appendFileSync(this.resolveFile(), RunLog.format(entry) + '\n', 'utf8');
    } catch {
      // 目录不可写 / 磁盘满等：降级为仅内存 + console（AC-5）
    }
  }

  private resolveFile(): string {
    // 显式 fileName 时固定文件名；缺省按日滚动 serve-YYYYMMDD.log
    if (this.fileName) return path.join(this.dir!, this.fileName);
    const d = this.now();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return path.join(this.dir!, `serve-${ymd}.log`);
  }

  /** 清理超过保留期的 .log 文件（构造时一次；失败静默） */
  private pruneOldLogs(retentionDays: number): void {
    if (retentionDays <= 0) return;
    try {
      if (!fs.existsSync(this.dir!)) return;
      const cutoff = this.now().getTime() - retentionDays * 24 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(this.dir!)) {
        if (!name.endsWith('.log')) continue;
        const file = path.join(this.dir!, name);
        try {
          if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
        } catch {
          // 单个文件清理失败不影响其余
        }
      }
    } catch {
      // 目录不可读：跳过清理
    }
  }
}

/**
 * 独立追加写入器（headless run 留档用，design-f41 D7）：
 * 多行文本直写单个文件，全程静默失败。返回 path 供调用方在结束行中回显（也供测试断言）。
 */
export function createRunFileLogger(
  dir: string,
  name: string,
): { log(line: string): void; path: string } {
  const file = path.join(dir, name);
  const log = (line: string): void => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(file, line + '\n', 'utf8');
    } catch {
      // 落盘失败静默（AC-5）
    }
  };
  return { log, path: file };
}
