/**
 * ShellAdapter（technical-design §9 跨平台方案）
 * win32: pwsh 7 优先（原生支持 && 管道链）→ Windows PowerShell 5.1 → cmd /d /s /c
 * darwin: $SHELL → /bin/zsh；linux: $SHELL → /bin/sh
 */
import { spawn } from 'node:child_process';

export interface ShellAdapter {
  /** platform identifier the adapter was resolved for */
  platform: 'win32' | 'darwin' | 'linux' | 'other';
  bin: string;
  /** spawn args for a given command line */
  args(command: string): string[];
  /** how the adapter reports shell-level failure (e.g. bin missing) */
  label: string;
}

export function detectShell(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): ShellAdapter {
  if (platform === 'win32') {
    // Windows PowerShell 5.1 兜底：不支持 && 管道链，pwsh 7 探测成功时不走这里；
    // 预置 [Console]::OutputEncoding=UTF8：PS 按 UTF-8 解码原生命令（git 等）输出、
    // 并以 UTF-8 编码自身 stdout，中文系统（cp936）下避免双层乱码。
    return {
      platform: 'win32',
      bin: 'powershell.exe',
      args: (c) => [
        '-NoProfile',
        '-Command',
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${c}`,
      ],
      label: 'powershell',
    };
  }
  const userShell = env.SHELL?.trim();
  if (platform === 'darwin') {
    return {
      platform: 'darwin',
      bin: userShell || '/bin/zsh',
      args: (c) => ['-c', c],
      label: userShell || '/bin/zsh',
    };
  }
  return {
    platform: platform === 'linux' ? 'linux' : 'other',
    bin: userShell || '/bin/sh',
    args: (c) => ['-c', c],
    label: userShell || '/bin/sh',
  };
}

/** cmd.exe fallback args（win32 专属）。 */
export function cmdAdapter(): ShellAdapter {
  return {
    platform: 'win32',
    bin: 'cmd.exe',
    args: (c) => ['/d', '/s', '/c', c],
    label: 'cmd',
  };
}

/** pwsh（PowerShell 7+）适配器：原生支持 && / || 管道链；UTF-8 预置同 PS 5.1。 */
export function pwshAdapter(): ShellAdapter {
  return {
    platform: 'win32',
    bin: 'pwsh.exe',
    args: (c) => [
      '-NoProfile',
      '-Command',
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ${c}`,
    ],
    label: 'pwsh',
  };
}

let win32ShellPromise: Promise<ShellAdapter> | undefined;

/**
 * win32 shell 探测（进程级缓存）：pwsh 7 存在则优先（支持 &&，Windows PowerShell
 * 5.1 会把 `&&` 当语法错误）；否则回退 powershell.exe 5.1，spawn 失败再由
 * runWithShell 降级 cmd。探测一次缓存整个进程生命周期，不给每条命令加开销。
 */
export function resolveWin32Shell(): Promise<ShellAdapter> {
  win32ShellPromise ??= new Promise<boolean>((resolve) => {
    const probe = spawn('where.exe', ['pwsh'], { windowsHide: true, stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('close', (code) => resolve(code === 0));
  }).then((hasPwsh) => (hasPwsh ? pwshAdapter() : detectShell('win32')));
  return win32ShellPromise;
}

export interface ShellSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** 实际使用的 shell（降级诊断用） */
  shellUsed: string;
}

/**
 * Run a command line through the platform shell adapter.
 * 显式传入 adapter 时按传入值执行（测试/DI 用）；默认路径下 win32 先做 pwsh
 * 探测（进程级缓存），pwsh 7 → powershell.exe 5.1 → cmd（spawn error 兜底降级）。
 * win32 上任一 shell 启动失败（ENOENT/EACCES）自动降级 cmd 重试一次。
 */
export function runWithShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  adapter?: ShellAdapter,
  killGraceMs?: number,
): Promise<ShellSpawnResult> {
  const run = (a: ShellAdapter) =>
    spawnOnce(command, cwd, timeoutMs, signal, a, killGraceMs).then((r) => {
      const fallbackNeeded =
        a.platform === 'win32' &&
        r.code === -1 &&
        /ENOENT|EACCES/i.test(r.stderr);
      if (!fallbackNeeded) return r;
      return spawnOnce(command, cwd, timeoutMs, signal, cmdAdapter(), killGraceMs);
    });
  if (adapter) return run(adapter);
  if (process.platform === 'win32') return resolveWin32Shell().then(run);
  return run(detectShell());
}

/**
 * Decode child process output.
 * 严格 UTF-8 优先；非法序列时 win32 回退 GBK（gb18030 超集）——中文 Windows
 * 的控制台代码页是 cp936，cmd 内建命令与 PowerShell 本地化报错都按 GBK 编码，
 * 直接按 UTF-8 解码会得到 replacement char 乱码（用户可见的 `��`/锟斤拷）。
 * 其他平台维持 UTF-8 宽松解码（非法字节替换，不掩盖二进制输出）。
 */
export function decodeShellOutput(buf: Buffer, platform: ShellAdapter['platform']): string {
  if (buf.length === 0) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    if (platform === 'win32') {
      try {
        return new TextDecoder('gb18030').decode(buf);
      } catch {
        /* fall through to lossy utf-8 */
      }
    }
    return buf.toString('utf8');
  }
}

/**
 * kill（超时/中止）后的强制收尾宽限期：直接子进程被 SIGKILL 后，孙进程若仍持有
 * stdout/stderr 管道（Windows 尤其常见），`close` 事件永不触发、上层 Promise 永不
 * resolve —— 并发槽位随之永久泄漏。宽限期后用已收集的输出强制 resolve。
 */
export const KILL_FORCE_RESOLVE_MS = 5_000;

function spawnOnce(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  adapter: ShellAdapter,
  killGraceMs: number = KILL_FORCE_RESOLVE_MS,
): Promise<ShellSpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(adapter.bin, adapter.args(command), { cwd, env: process.env, windowsHide: true });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    const finish = (code: number | null, stderrSuffix = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signal.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout: decodeShellOutput(Buffer.concat(stdoutChunks), adapter.platform),
        stderr: decodeShellOutput(Buffer.concat(stderrChunks), adapter.platform) + stderrSuffix,
        timedOut,
        shellUsed: adapter.label,
      });
    };
    // kill 后宽限期兜底：close 事件被孙进程管道卡死时，用已收集的输出强制收尾
    const armForceResolve = () => {
      clearTimeout(forceTimer);
      forceTimer = setTimeout(
        () => finish(timedOut ? null : (child.exitCode ?? null)),
        killGraceMs,
      );
      forceTimer.unref?.();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
      armForceResolve();
    }, timeoutMs);
    const onAbort = () => {
      timedOut = false;
      child.kill('SIGKILL');
      armForceResolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
    child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));
    child.on('error', (e) => {
      finish(-1, String(e.message));
    });
    child.on('close', (code) => {
      finish(code);
    });
  });
}
