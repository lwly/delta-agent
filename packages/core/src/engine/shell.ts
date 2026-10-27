/**
 * ShellAdapter（technical-design §9 跨平台方案）
 * win32: PowerShell 优先（探测失败降级 cmd /d /s /c）
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
    // PowerShell 启动失败（spawn error）时由 runWithShell 自动降级 cmd 重试；
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
 * win32 上 PowerShell 启动失败（spawn error）自动降级 cmd 重试一次。
 */
export function runWithShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  adapter: ShellAdapter = detectShell(),
): Promise<ShellSpawnResult> {
  return spawnOnce(command, cwd, timeoutMs, signal, adapter).then((r) => {
    const fallbackNeeded =
      adapter.platform === 'win32' &&
      r.code === -1 &&
      /ENOENT|EACCES/i.test(r.stderr);
    if (!fallbackNeeded) return r;
    return spawnOnce(command, cwd, timeoutMs, signal, cmdAdapter());
  });
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

function spawnOnce(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
  adapter: ShellAdapter,
): Promise<ShellSpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(adapter.bin, adapter.args(command), { cwd, env: process.env, windowsHide: true });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => {
      timedOut = false;
      child.kill('SIGKILL');
    };
    signal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (d: Buffer) => stdoutChunks.push(d));
    child.stderr?.on('data', (d: Buffer) => stderrChunks.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({
        code: -1,
        stdout: decodeShellOutput(Buffer.concat(stdoutChunks), adapter.platform),
        stderr: decodeShellOutput(Buffer.concat(stderrChunks), adapter.platform) + String(e.message),
        timedOut,
        shellUsed: adapter.label,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve({
        code,
        stdout: decodeShellOutput(Buffer.concat(stdoutChunks), adapter.platform),
        stderr: decodeShellOutput(Buffer.concat(stderrChunks), adapter.platform),
        timedOut,
        shellUsed: adapter.label,
      });
    });
  });
}
