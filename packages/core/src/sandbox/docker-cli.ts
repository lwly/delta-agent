/**
 * `DockerCli` —— 可测试性架构的核心（设计 §2.2 / D4）。
 *
 * 全部容器逻辑（探测判定、argv 组装、清理序列、降级决策）都跑在这个端口之上，
 * 因此「没有 Docker daemon 的机器」也能 100% 单测：
 * 测试注入 `FakeDockerCli`（test/helpers/fake-docker.ts），生产用 `realDockerCli`。
 *
 * 硬约束：
 *  - `spawn('docker', args, { shell: false })` —— 永不 shell 解释（argv 即契约）
 *  - 清理路径只用 `execSync`（spawnSync + 短超时 + 绝不抛异常），不会被挂起的 Promise 拖住
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface DockerInvokeOptions {
  /** 缺省 = 不限时（`docker run` 由命令超时控制，`pull` 用 pullTimeoutMs） */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** 子进程 env；缺省 = `localDockerEnv(process.env)`（显式拒绝远端 DOCKER_HOST，PRD §2.3） */
  env?: NodeJS.ProcessEnv;
  /** stderr 逐行回调（拉取进度旁路到用户侧，不进模型上下文） */
  onStderrLine?: (line: string) => void;
}

export interface DockerCli {
  /** 异步执行（探测、inspect、pull、docker run 本体） */
  exec(args: string[], opts?: DockerInvokeOptions): Promise<DockerResult>;
  /**
   * 同步执行：**清理路径专用**（D5）。
   * spawnSync + 强制短超时 + 绝不抛异常；无异步等待 ⇒ finally 里不会被挂起的 Promise 拖住。
   */
  execSync(args: string[], opts?: { timeoutMs?: number }): DockerResult;
}

/**
 * 真实 CLI 调用计数（**测试护栏，零行为影响**）。
 * test/helpers/fake-docker.ts 在每个用例后断言它没有增长，防止有用例漏注入 Fake 而打到真实 docker。
 */
export const realDockerCliStats = { exec: 0, execSync: 0 };

export function resetRealDockerCliStats(): void {
  realDockerCliStats.exec = 0;
  realDockerCliStats.execSync = 0;
}

export function realDockerCliCallCount(): number {
  return realDockerCliStats.exec + realDockerCliStats.execSync;
}

/** 远端 docker host（tcp/ssh/http）判定：本特性只连本机 daemon（PRD §2.3 非目标）。 */
function isRemoteDockerHost(value: string): boolean {
  return /^(tcp|ssh|http|https):\/\//i.test(value.trim());
}

/**
 * 子进程环境：去掉指向远端 daemon 的 `DOCKER_HOST`（本机 unix/npipe 保留，兼容 rootless）。
 * 其余变量原样继承 —— `-e NAME` 形式的 env 透传依赖它。
 */
export function localDockerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  const host = out.DOCKER_HOST;
  if (host && isRemoteDockerHost(host)) delete out.DOCKER_HOST;
  return out;
}

/** 默认实现：`spawn('docker', args, { shell: false })` —— 注意 shell 恒为 false。 */
export const realDockerCli: DockerCli = {
  exec(args: string[], opts: DockerInvokeOptions = {}): Promise<DockerResult> {
    realDockerCliStats.exec++;
    return new Promise<DockerResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn('docker', args, {
          shell: false,
          windowsHide: true,
          env: opts.env ?? localDockerEnv(process.env),
        });
      } catch (e) {
        resolve({ code: -1, stdout: '', stderr: String((e as Error).message), timedOut: false });
        return;
      }

      let stdout = '';
      let stderr = '';
      let stderrBuffer = '';
      let timedOut = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (r: DockerResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const onAbort = (): void => {
        timedOut = false; // abort ≠ timeout（与 runWithShell 口径一致）
        try {
          child.kill('SIGKILL');
        } catch {
          // 子进程已退出
        }
      };

      if (opts.timeoutMs && opts.timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill('SIGKILL');
          } catch {
            // 子进程已退出
          }
        }, opts.timeoutMs);
      }
      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      const emitLines = (chunk: string): void => {
        if (!opts.onStderrLine) return;
        stderrBuffer += chunk;
        const lines = stderrBuffer.split(/\r?\n/);
        stderrBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() !== '') opts.onStderrLine(line);
        }
      };

      child.stdout?.on('data', (d) => {
        stdout += String(d);
      });
      child.stderr?.on('data', (d) => {
        const chunk = String(d);
        stderr += chunk;
        emitLines(chunk);
      });
      child.on('error', (e) => {
        finish({ code: -1, stdout, stderr: stderr + String(e.message), timedOut });
      });
      child.on('close', (code) => {
        if (stderrBuffer.trim() !== '') opts.onStderrLine?.(stderrBuffer);
        finish({ code, stdout, stderr, timedOut });
      });
    });
  },

  execSync(args: string[], opts: { timeoutMs?: number } = {}): DockerResult {
    realDockerCliStats.execSync++;
    const timeoutMs = opts.timeoutMs ?? 2_000;
    try {
      const r = spawnSync('docker', args, {
        timeout: timeoutMs,
        encoding: 'utf8',
        windowsHide: true,
        env: localDockerEnv(process.env),
      });
      const errorMessage = r.error ? String(r.error.message) : '';
      const timedOut = Boolean(r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT');
      return {
        code: r.status ?? null,
        stdout: r.stdout ?? '',
        stderr: `${r.stderr ?? ''}${errorMessage}`,
        timedOut,
      };
    } catch (e) {
      // 清理路径绝不抛异常（清理失败只 warning，不影响命令结果）
      return { code: null, stdout: '', stderr: String((e as Error).message), timedOut: false };
    }
  },
};
