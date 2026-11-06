// F-55 外部 CLI Agent：进程生命周期底座（docs/design-f55-external-cli-agents.md §9）
//
// 纯进程层：只管 spawn / 逐行输出 / stderr 环形缓冲 / 取消杀进程组。
// 不做任何协议解析（JSON-RPC / JSONL 归 adapter），不做 ExternalEvent 映射（归 engine/external.ts），
// 不 import llm/ 或 engine/ 下任何模块。

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

/** stdout 单行字节上限：超限截断并记 stderr 警告，防一行巨型序列化输出爆内存 */
export const MAX_LINE_BYTES = 1024 * 1024;
/** stderr 环形缓冲行数：只保留最近 N 行 */
export const STDERR_RING_LINES = 200;
/** cancel() 后给协议取消钩子的宽限期（ms），仍未退则强杀进程组 */
export const ABORT_KILL_DELAY_MS = 300;

/** stdout 单行截断时写入 stderr 环形缓冲的警告文本 */
const STDOUT_TRUNCATED_WARNING = '[delta] stdout line exceeded 1MiB, truncated';

/** 基础环境白名单：子进程正常工作至少需要这些 */
const BASE_ENV_KEYS = ['PATH', 'HOME', 'SHELL', 'LANG', 'TMPDIR'] as const;

/** Windows 额外必带：node spawn 在 Windows 缺 SystemRoot 会直接挂 */
const WIN_ENV_KEYS = ['SystemRoot', 'COMPUTERNAME', 'USERNAME', 'PATHEXT'] as const;

export interface SpawnOptions {
  /** 绝对路径或可执行名 */
  command: string;
  args: string[];
  /** 调用方固定传 projectRoot（F-17 硬边界）；本模块不解析、不回退 process.cwd() */
  cwd: string;
  /** 额外放行的变量名（如 provider 自身变量 ANTHROPIC_API_KEY）；基础白名单固定包含 PATH/HOME/SHELL/LANG/TMPDIR */
  envWhitelist?: string[];
  /** 直接注入子进程的变量（优先于白名单透传；adapter 传单次运行参数用，不改父进程 env） */
  extraEnv?: Record<string, string>;
  /** abort → 先 onAbort 协议取消钩子，ABORT_KILL_DELAY_MS 后仍未退则杀进程组 */
  signal: AbortSignal;
  /** 协议级取消钩子（如 ACP session/cancel）；可缺省 */
  onAbort?: () => void;
  /**
   * Windows：command 解析到 .cmd/.ps1 shim 时必须 shell:true，此时用此包装整条命令行。
   * 缺省实现见 defaultWindowsShellQuote。
   */
  windowsShellQuote?: (command: string, args: string[]) => string;
}

export type ProcEvent =
  | { type: 'line'; text: string } // stdout 一行（不含换行符）
  | { type: 'stderr_line'; text: string } // stderr 一行
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null };

export interface SpawnedProcess {
  /** 单消费者事件流（exit 恒为最后一个事件）；多迭代者会互相抢事件，勿并发迭代 */
  events: AsyncIterable<ProcEvent>;
  /** 等待进程退出（events 迭代结束后即退出）；返回退出码/信号 */
  wait(): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** 主动取消：调 onAbort 钩子，ABORT_KILL_DELAY_MS 后仍存活则杀进程组（POSIX kill(-pid) / Windows taskkill）；幂等 */
  cancel(): Promise<void>;
  /** stderr 环形缓冲快照（最近 ≤ STDERR_RING_LINES 行） */
  stderrTail(): string[];
  /**
   * 向子进程 stdin 写一行（自动补 \n）。供协议 adapter 发 JSON-RPC 请求用（F-55 P1 ACP）。
   * stdin 已关闭/进程已退时返回 false（不抛错）；写入后的 EPIPE 由内部兜底进环形缓冲。
   */
  writeLine(text: string): boolean;
  /** 关闭子进程 stdin（ACP：prompt result 到达后通知 agent 自然退出） */
  endStdin(): void;
  pid: number | undefined;
}

/**
 * Windows cmd.exe 引号包装缺省实现：逐段引用（command 与各 arg 独立加引号），空格拼接。
 * cmd.exe 自身不认单引号，旧实现「外层单引号 + 内层 JSON.stringify」在 `cmd /d /s /c` 下
 * 会被 /s 剥掉首尾引号后把外层单引号当命令名一部分（F-55 Windows 实测 5/5 CLI 探测失败），
 * 改为对含空格/cmd 元字符（"&|<>^）的 token 加双引号、内部双引号转义——即 Node spawn
 * 对文件名参数的标准引用法。完全不含特殊字符的裸名不加重引号。
 */
export const defaultWindowsShellQuote = (command: string, args: string[]): string => {
  const quoteToken = (token: string): string =>
    /[\s"&|<>^]/.test(token) ? `"${token.replace(/"/g, '\\"')}"` : token;
  return [command, ...args].map(quoteToken).join(' ');
};

/** 组装子进程 env：仅 { 基础白名单 + envWhitelist 中存在于 process.env 的项 + extraEnv 直注入 }，
 * 不透传 delta 进程的其余变量（不注入 delta 的密钥）。extraEnv 供 adapter 传单次运行的
 * 场景参数（如 ScriptedExternalAdapter 的 FAKE_CLI_SCRIPT），不改父进程 env（P4 并发安全）。 */
function buildChildEnv(
  envWhitelist: string[] | undefined,
  extraEnv: Record<string, string> | undefined,
  command: string,
): NodeJS.ProcessEnv {
  const allowed = new Set<string>(BASE_ENV_KEYS);
  for (const key of envWhitelist ?? []) allowed.add(key);
  const isWin = process.platform === 'win32';
  if (isWin) for (const key of WIN_ENV_KEYS) allowed.add(key);

  const env: NodeJS.ProcessEnv = {};
  for (const key of allowed) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    env[key] = value;
  }
  if (!isWin) {
    // POSIX 至少补 `_`：让 `command --version` 类调用有 argv0 观感
    env['_'] = process.env['_'] ?? command;
  }
  return env;
}

/**
 * F-56（Windows 中文环境实测）：行缓冲解码。严格 UTF-8 解码出现替换符（U+FFFD）时回退 GBK
 * ——中文 Windows 的 cmd shim / 控制台错误按本地码页（cp936）输出，UTF-8 硬解必出乱码；
 * Node 20 full-icu 原生支持 GBK 解码。合法 UTF-8 内容不受影响（正常路径零开销）。
 */
function decodeLineBuffer(line: Buffer): string {
  const utf8 = line.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const gbk = new TextDecoder('gbk').decode(line);
    if (!gbk.includes('\uFFFD')) return gbk;
  } catch {
    /* 运行时无 GBK 支持（非 full-icu 构建）：保持 UTF-8 结果 */
  }
  return utf8;
}

/**
 * 逐行拆分器：按 \n 切行（剥离行尾 \r），单行超 maxBytes 截断输出并置 truncated=true，
 * 残余字节丢弃直到下一个换行——不崩、不丢后续行。流结束时若有残余行（无换行结尾）也产出。
 */
function attachLineSplitter(
  stream: NodeJS.ReadableStream,
  opts: { maxBytes: number; onLine: (text: string, truncated: boolean) => void; onEnd: () => void },
): void {
  let buf: Buffer = Buffer.alloc(0);
  let discarding = false; // 超长行截断后，丢弃残余字节直到下一个换行
  stream.on('data', (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    for (;;) {
      if (discarding) {
        const idx = buf.indexOf(0x0a);
        if (idx === -1) {
          buf = Buffer.alloc(0);
          return;
        }
        buf = buf.subarray(idx + 1);
        discarding = false;
        continue;
      }
      const idx = buf.indexOf(0x0a);
      if (idx === -1) {
        // 没等到换行就超限：先产出截断段，进入丢弃态
        if (buf.length > opts.maxBytes) {
          opts.onLine(decodeLineBuffer(buf.subarray(0, opts.maxBytes)), true);
          buf = Buffer.alloc(0);
          discarding = true;
        }
        return;
      }
      let line = buf.subarray(0, idx);
      buf = buf.subarray(idx + 1);
      let truncated = false;
      if (line.length > opts.maxBytes) {
        line = line.subarray(0, opts.maxBytes);
        truncated = true;
      }
      let text = decodeLineBuffer(line);
      if (text.endsWith('\r')) text = text.slice(0, -1);
      opts.onLine(text, truncated);
    }
  });
  stream.on('end', () => {
    if (!discarding && buf.length > 0) {
      const truncated = buf.length > opts.maxBytes;
      let text = decodeLineBuffer(truncated ? buf.subarray(0, opts.maxBytes) : buf);
      if (text.endsWith('\r')) text = text.slice(0, -1);
      opts.onLine(text, truncated);
    }
    opts.onEnd();
  });
}

/** 强杀整个进程树：POSIX 杀进程组（spawn 时 detached:true 建组），Windows 用 taskkill 连子树一起杀 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // Windows 无进程组语义；detached 未建组，用 taskkill /T 连子进程一起强杀
    const tk = nodeSpawn('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
    tk.on('error', () => {
      // taskkill 不可用等异常场景兜底：直接杀主进程
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出，忽略 */
      }
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 进程组已不存在（可能刚自然退出）——忽略
  }
}

/** spawn 外部 CLI 进程：白名单 env、逐行事件、stderr 环形缓冲、abort→杀进程组 */
export function spawnExternal(options: SpawnOptions): SpawnedProcess {
  const { command, args, cwd, envWhitelist, extraEnv, signal, onAbort, windowsShellQuote } = options;

  // Windows：command 解析到 .cmd/.bat/.ps1 shim（如 npm 装的 claude.cmd）必须 shell:true，
  // 否则 Node 无法直接执行 shim（CVE-2024-27980 相关限制）；整条命令行经引号包装防拆分。
  const isWinShim = /\.(cmd|bat|ps1)$/i.test(command);
  const spawnOpts: Parameters<typeof nodeSpawn>[2] = {
    cwd,
    env: buildChildEnv(envWhitelist, extraEnv, command),
    stdio: ['pipe', 'pipe', 'pipe'],
    // detached 仅 POSIX：建立进程组，便于 kill(-pid) 连子孙一起杀
    detached: process.platform !== 'win32',
    shell: isWinShim,
    windowsHide: true,
  };
  // shell:true 时 Node 把 command 当整条命令行执行：此时用 windowsShellQuote
  // （缺省：逐段引用，见 defaultWindowsShellQuote）包装整条命令行，防止含空格路径被 cmd 拆散
  const child = isWinShim
    ? nodeSpawn((windowsShellQuote ?? defaultWindowsShellQuote)(command, args), spawnOpts)
    : nodeSpawn(command, args, spawnOpts);

  // ---- 事件队列（单消费者 async generator） ----
  const queue: ProcEvent[] = [];
  let notify: (() => void) | null = null;
  let closed = false;
  const pushEvent = (ev: ProcEvent): void => {
    queue.push(ev);
    const n = notify;
    notify = null;
    n?.();
  };
  const events: AsyncIterable<ProcEvent> = {
    [Symbol.asyncIterator]() {
      return (async function* () {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!;
          if (closed) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      })();
    },
  };

  // ---- stderr 环形缓冲（同时作为 stderr_line 事件产出） ----
  const ring: string[] = [];
  const pushRing = (line: string): void => {
    ring.push(line);
    if (ring.length > STDERR_RING_LINES) ring.shift();
  };

  // ---- 退出收敛：exit 事件必须最后发（stdout/stderr 都结束后） ----
  let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let finished = false;
  let waitResolve: ((r: { code: number | null; signal: NodeJS.Signals | null }) => void) | null = null;
  const waitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    waitResolve = resolve;
  });
  const finish = (): void => {
    if (finished || exitInfo === null) return;
    finished = true;
    closed = true;
    pushEvent({ type: 'exit', code: exitInfo.code, signal: exitInfo.signal });
    const n = notify;
    notify = null;
    n?.();
    waitResolve?.(exitInfo);
    removeAbortHook();
  };

  attachLineSplitter(child.stdout!, {
    maxBytes: MAX_LINE_BYTES,
    onLine: (text, truncated) => {
      pushEvent({ type: 'line', text });
      if (truncated) pushRing(STDOUT_TRUNCATED_WARNING);
    },
    onEnd: () => finish(),
  });
  attachLineSplitter(child.stderr!, {
    maxBytes: MAX_LINE_BYTES,
    onLine: (text) => {
      pushRing(text);
      pushEvent({ type: 'stderr_line', text });
    },
    onEnd: () => finish(),
  });

  // 'close' 在 stdio 流全部关闭后触发，天然满足「exit 事件最后发」的顺序约束
  child.on('close', (code, signalName) => {
    exitInfo = { code, signal: signalName };
    finish();
  });
  // spawn 失败（ENOENT 等）：收敛为 code null 的 exit，避免上层悬挂；错误信息进环形缓冲
  child.on('error', (err: Error) => {
    if (exitInfo === null) {
      // ENOENT 给可行动提示：外部 Agent 手动注册的裸名命令依赖 serve 进程 PATH，
      // 不可达时引导以绝对路径重新注册（F-56 实测：GUI 启动的 serve 常缺用户 PATH）
      const hint =
        err.message.includes('ENOENT')
          ? '（命令不可达：请在设置 → 外部 Agent 重新以绝对路径注册，或检查该 CLI 是否已安装并登录）'
          : '';
      pushRing(`[delta] spawn failed: ${err.message}${hint}`);
      exitInfo = { code: null, signal: null };
      finish();
    }
  });

  // stdin 写错误（EPIPE：子进程已退后才写）：进环形缓冲兜底，防 unhandled 'error' 崩溃
  child.stdin?.on('error', (err: Error) => {
    pushRing(`[delta] stdin 写入失败: ${err.message}`);
  });

  // ---- 取消：onAbort 钩子 → 宽限期 → 杀进程组；幂等 ----
  const exitedBeforeCancel = (): boolean =>
    finished || child.exitCode !== null || child.signalCode !== null;
  const waitForExit = (): Promise<void> =>
    new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      child.once('error', () => resolve());
    });

  let cancelPromise: Promise<void> | null = null;
  const cancel = (): Promise<void> => {
    if (cancelPromise) return cancelPromise;
    cancelPromise = (async () => {
      if (exitedBeforeCancel()) return; // 已退出：幂等，直接 resolve
      onAbort?.();
      const exited = await Promise.race([
        waitForExit().then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ABORT_KILL_DELAY_MS)),
      ]);
      if (!exited) killProcessTree(child);
      await waitPromise; // resolve 前提：进程确认退出
    })();
    return cancelPromise;
  };

  // signal abort → 与 cancel() 同路径
  const onAbortEvent = (): void => {
    void cancel();
  };
  if (signal.aborted) queueMicrotask(onAbortEvent);
  else signal.addEventListener('abort', onAbortEvent, { once: true });
  const removeAbortHook = (): void => {
    signal.removeEventListener('abort', onAbortEvent);
  };

  return {
    events,
    wait: () => waitPromise,
    cancel,
    stderrTail: () => [...ring],
    writeLine: (text: string): boolean => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
      stdin.write(`${text}\n`);
      return true;
    },
    endStdin: () => {
      child.stdin?.end();
    },
    pid: child.pid,
  };
}
