/**
 * `docker run` 参数组装器（设计 §5）。
 *
 * 铁律（§15.3/§15.4）：
 *  - 返回**有序字符串数组**（argv 即契约，测试逐元素断言）
 *  - 绝不 `argv.join(' ')`、绝不模板字符串拼命令、宿主的 spawn 永不启用 shell（该选项恒为 false）
 *  - 命令只作为 `['-c', command]` 的第二个元素 —— 其中的引号/`$()`/`&&` 由容器内 `sh` 解释
 *    （与本地 `runWithShell` 的 `-c command` 语义一致），宿主侧无任何二次解释
 */
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { realpathOr } from './config.js';
import { SandboxPathError, type SandboxConfig } from './types.js';

export interface DockerRunSpec {
  config: SandboxConfig;
  /** 已 realpath 的宿主项目根 */
  projectRoot: string;
  /** 相对项目根的 cwd，POSIX 分隔符，'' 表示根 */
  relativeCwd: string;
  command: string;
  containerName: string;
  labels: { session: string; project: string; created: string };
  /** 宿主 env：仅用于判断白名单变量是否存在 + 取 TZ 值 */
  hostEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * 产出 docker run 的**有序 argv 数组**（不含 'docker' 本身）。
 * 元素顺序即公开契约（§5.2 表 24 段），新增参数只能追加在 `--entrypoint` 之前。
 */
export function buildDockerRunArgs(spec: DockerRunSpec): string[] {
  const cfg = spec.config;
  const argv: string[] = ['run'];

  // 2 --rm（keepContainer=true 时不带，供事后 inspect）
  if (!cfg.keepContainer) argv.push('--rm');

  // 3-6 容器名与 label（label 是 gc/残留清理的锚点）
  argv.push('--name', spec.containerName);
  argv.push('--label', `yzero.session=${spec.labels.session}`);
  argv.push('--label', `yzero.project=${spec.labels.project}`);
  argv.push('--label', `yzero.created=${spec.labels.created}`);

  // 7-9 加固基线（cap-drop / no-new-privileges 不可配）
  if (cfg.readOnlyRoot) argv.push('--read-only');
  argv.push('--cap-drop', 'ALL');
  argv.push('--security-opt', 'no-new-privileges');

  // 10 网络
  argv.push('--network', cfg.network);

  // 11-13 资源上限
  argv.push('--memory', `${cfg.memoryMb}m`, '--memory-swap', `${cfg.memoryMb}m`);
  argv.push('--cpus', `${cfg.cpus}`);
  argv.push('--pids-limit', `${cfg.pidsLimit}`);

  // 14 唯一挂载：项目工作区 → /workspace
  argv.push(
    '--mount',
    `type=bind,source=${normalizeMountSource(spec.projectRoot, spec.platform)},target=/workspace`,
  );

  // 15 tmpfs（/tmp 与 HOME，随容器销毁）
  for (const item of cfg.tmpfs) argv.push('--tmpfs', item);

  // 16 user（null 则整段省略 = 用镜像默认用户）
  if (cfg.user !== null) argv.push('--user', cfg.user);

  // 17-19 语言/时区固定注入 + env 白名单（只给名字，值由 docker 子进程 env 继承）
  argv.push('-e', 'LANG=C.UTF-8');
  argv.push('-e', `TZ=${resolveTimezone(spec.hostEnv)}`);
  for (const name of passthroughEnvNames(cfg, spec.hostEnv)) argv.push('-e', name);

  // 20 工作目录
  argv.push('--workdir', containerWorkdir(spec.relativeCwd));

  // 21-24 覆盖 ENTRYPOINT + 命令作为单个 argv 元素
  argv.push('--entrypoint', '/bin/sh');
  argv.push(cfg.image);
  argv.push('-c', spec.command);

  return argv;
}

/**
 * env 白名单中**宿主确实存在**的变量名（只给名字，绝不把值放进 argv）。
 * 数量进 `meta.sandbox.passthroughEnv`。
 */
export function passthroughEnvNames(
  cfg: SandboxConfig,
  hostEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  return cfg.env.filter((name) => hostEnv[name] !== undefined);
}

/** 容器内 TZ：宿主 env.TZ → Intl 时区 → UTC。 */
export function resolveTimezone(hostEnv: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = hostEnv.TZ?.trim();
  if (fromEnv) return fromEnv;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && tz.trim() !== '') return tz.trim();
  } catch {
    // Intl 不可用（极简运行时）→ 兜底 UTC
  }
  return 'UTC';
}

/**
 * 相对 cwd → 容器内工作目录。
 * '' / '.' → '/workspace'；'a/b' → '/workspace/a/b'；含 '..' → throw（路径逃逸的第二道闸）。
 */
export function containerWorkdir(relativeCwd: string): string {
  const normalized = relativeCwd.replace(/\\/g, '/').trim();
  if (normalized === '' || normalized === '.' || normalized === './') return '/workspace';
  if (normalized.startsWith('/')) {
    throw new SandboxPathError(
      `[sandbox] sandbox 配置不允许使用绝对路径作为容器工作目录：${relativeCwd}`,
    );
  }
  const segments = normalized.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) {
    throw new SandboxPathError(
      `[sandbox] sandbox 配置不允许工作目录逃逸项目根（含 '..'）：${relativeCwd}`,
    );
  }
  return `/workspace/${segments.join('/')}`;
}

/**
 * 宿主绝对路径 cwd → 相对项目根（POSIX 分隔符）。含 '..' → throw。
 * 与 `resolveInSandbox` 互补：前者管参数合法性，这里管「容器内工作目录可表达」。
 */
export function relativeCwdOf(projectRoot: string, cwdAbsolute: string): string {
  // macOS 上 /var/folders → /private/var 的软链差异必须先用 realpath 抹平，
  // 否则 path.relative 会算出假的 '..' 逃逸。
  const root = realpathOr(path.resolve(projectRoot));
  const cwd = realpathOr(path.resolve(cwdAbsolute));
  const rel = path.relative(root, cwd);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new SandboxPathError(
      `[sandbox] sandbox 配置不允许工作目录在项目根之外：${cwdAbsolute}`,
    );
  }
  return rel.split(path.sep).join('/');
}

/**
 * 跨平台挂载源归一（§5.4）：
 *  - win32：`\` → `/`，盘符大写（Docker Desktop 推荐正斜杠，`--mount` 的 source= 语义无歧义）
 *  - 通用拒绝：路径含 `,` / `"` / 换行 → throw（docker --mount 不支持这些字符）
 */
export function normalizeMountSource(p: string, platform: NodeJS.Platform = process.platform): string {
  if (/[,"\n\r]/.test(p)) {
    throw new SandboxPathError(
      '[sandbox] sandbox 配置不允许：工作区路径包含 docker --mount 不支持的字符（逗号/引号/换行），' +
        '请将项目移动到不含这些字符的路径',
    );
  }
  let out = p;
  if (platform === 'win32') {
    out = out.replace(/\\/g, '/');
    out = out.replace(/^([a-z]):/, (_m, drive: string) => `${drive.toUpperCase()}:`);
  }
  return out;
}

/**
 * 容器名：`yzero-<sid 前 8 位>-<随机 6 位>`。
 * 随机位用 crypto.randomBytes(3).toString('hex')（零新依赖）；测试可注入 rand。
 */
export function containerName(sessionId: string, rand?: string): string {
  const cleaned = String(sessionId ?? '').replace(/[^A-Za-z0-9]/g, '');
  const sid8 = cleaned.slice(0, 8) || 'session0';
  const suffix = rand ?? randomBytes(3).toString('hex');
  return `yzero-${sid8}-${suffix}`;
}

/**
 * `-e NAME=VALUE` → `-e NAME=***`（`--debug` 打印前的兜底打码）。
 * 设计上 env 透传用 `-e NAME`（值不在 argv），此函数防止未来有人改成 `=value` 形式。
 */
export function redactArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = argv[i + 1];
    if (arg === '-e' && next !== undefined) {
      out.push(arg, next.includes('=') ? `${next.slice(0, next.indexOf('='))}=***` : next);
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}
