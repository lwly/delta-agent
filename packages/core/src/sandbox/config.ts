/**
 * F-30 沙箱配置体系（设计 §3）：
 *  - 两级 JSON（`~/.y-zero/sandbox.json` < `.y-zero/sandbox.json`）+ 会话覆盖，**逐字段 merge**
 *  - 非法值 ⇒ 降级默认 + warning，**永不 throw**（配置写错不该让 agent 起不来）
 *  - 敏感键（mounts / privileged / …）⇒ 该层**硬拒**
 *  - `enforce: true` ⇒ 会话覆盖只能更严（偏序表），且 fallback 强制 deny
 *  - 工作区根守卫（`assertSafeWorkspaceRoot`）⇒ 唯一「宁可失败」的地方
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEFAULT_SANDBOX_CONFIG,
  DEFAULT_SANDBOX_IMAGE,
  SANDBOX_MERGE_FIELDS,
  SandboxPathError,
  type ResolvedSandboxConfig,
  type SandboxConfig,
  type SandboxConfigError,
  type SandboxConfigLayer,
  type SandboxConfigProvenance,
  type SandboxConfigSource,
  type SandboxConfigWarning,
  type SandboxMergeField,
  type SandboxNetwork,
  type SandboxSessionOverrides,
} from './types.js';

/**
 * 敏感未知键：出现即硬拒（PRD §6「挂载不可配」+ §2.3「不做任意挂载点配置」）。
 * 语义等价于「mounts 校验」：本特性不提供任何挂载面，写了就是试图削弱隔离。
 */
const SENSITIVE_KEYS = new Set([
  'mounts',
  'mount',
  'volumes',
  'volume',
  'privileged',
  'cap_add',
  'cap-add',
  'devices',
  'security_opt',
  'security-opt',
  'pid',
  'ipc',
  'network_mode',
  'network-mode',
]);

const KNOWN_KEYS = new Set<string>(SANDBOX_MERGE_FIELDS);

const USER_PATTERN = /^\d+:\d+$/;
const TMPFS_PATTERN = /^\/[A-Za-z0-9._/@-]+$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ── 单层归一化 ──────────────────────────────────────────────────────────────

/**
 * 单层归一化：非法值降级为「未声明」+ warning；敏感键 / 危险镜像名 → error（该层整体不生效）。
 * 该函数**从不抛异常**，所有异常情况都转成 warnings / errors。
 */
export function normalizeSandboxLayer(
  raw: unknown,
  source: SandboxConfigSource,
  warnings: SandboxConfigWarning[],
  errors: SandboxConfigError[],
): SandboxConfigLayer {
  const layer: SandboxConfigLayer = {};
  if (raw === undefined) return layer;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push({ source, message: `sandbox 配置（${source}）不是 JSON 对象，已忽略该层` });
    return layer;
  }
  const record = raw as Record<string, unknown>;

  // 1) 敏感未知键 → 整层硬拒（这次真的「宁可失败」）
  const sensitive = Object.keys(record).filter((k) => SENSITIVE_KEYS.has(k.toLowerCase()));
  if (sensitive.length > 0) {
    errors.push({
      source,
      message:
        `sandbox 配置不允许设置 ${sensitive.join(', ')}：本特性只允许挂载项目工作区、` +
        `不提供自定义挂载/特权/命名空间配置（已整体忽略 ${source} 层配置）`,
    });
    return layer;
  }

  const warn = (field: string, message: string): void => {
    warnings.push({ source, field, message });
  };

  // 2) 逐字段校验
  if (record.mode !== undefined) {
    const v = record.mode;
    if (v === 'local' || v === 'seatbelt' || v === 'docker') layer.mode = v;
    else warn('mode', `mode 非法值 ${JSON.stringify(v)}，已忽略（可选 local | seatbelt | docker）`);
  }

  if (record.enforce !== undefined) {
    if (source !== 'project') {
      warn('enforce', `enforce 仅在项目级（.y-zero/sandbox.json）生效，已忽略 ${source} 层的 enforce`);
    } else if (typeof record.enforce === 'boolean') {
      layer.enforce = record.enforce;
    } else {
      warn('enforce', `enforce 必须为 boolean，收到 ${JSON.stringify(record.enforce)}，已忽略`);
    }
  }

  if (record.fallback !== undefined) {
    const v = record.fallback;
    if (v === 'deny' || v === 'ask' || v === 'local') layer.fallback = v;
    else warn('fallback', `fallback 非法值 ${JSON.stringify(v)}，已用默认 ${DEFAULT_SANDBOX_CONFIG.fallback}`);
  }

  if (record.image !== undefined) {
    const v = record.image;
    if (typeof v !== 'string' || v.trim() === '') {
      warn('image', `image 必须为非空字符串，收到 ${JSON.stringify(v)}，已忽略`);
    } else if (v.trim().startsWith('-')) {
      // 会被 docker 当成命令行参数（如 --privileged），属于削弱隔离的硬错误
      errors.push({
        source,
        message:
          `sandbox 配置不允许镜像名以 - 开头（"${v}"）：会被 docker 当成命令行参数（已整体忽略 ${source} 层配置）`,
      });
      return {};
    } else if (/\s/.test(v.trim())) {
      warn('image', `image 不能包含空白字符（"${v}"），已忽略`);
    } else {
      layer.image = v.trim();
    }
  }

  if (record.network !== undefined) {
    const v = record.network;
    if (v === 'none' || v === 'bridge') layer.network = v;
    else warn('network', `network 非法值 ${JSON.stringify(v)}，已忽略（可选 none | bridge）`);
  }

  layer.memoryMb = intField(record.memoryMb, 'memoryMb', 128, 65_536, warn, layer.memoryMb);
  layer.cpus = numberField(record.cpus, 'cpus', 0.1, 64, warn, layer.cpus);
  layer.pidsLimit = intField(record.pidsLimit, 'pidsLimit', 16, 65_536, warn, layer.pidsLimit);
  layer.pullTimeoutMs = intField(record.pullTimeoutMs, 'pullTimeoutMs', 5_000, 3_600_000, warn, layer.pullTimeoutMs);

  layer.readOnlyRoot = boolField(record.readOnlyRoot, 'readOnlyRoot', warn, layer.readOnlyRoot);
  layer.keepContainer = boolField(record.keepContainer, 'keepContainer', warn, layer.keepContainer);

  if (record.user !== undefined) {
    const v = record.user;
    if (v === null) layer.user = null;
    else if (typeof v === 'string' && USER_PATTERN.test(v.trim())) layer.user = v.trim();
    else warn('user', `user 必须为 "uid:gid" 形式或 null，收到 ${JSON.stringify(v)}，已忽略`);
  }

  if (record.tmpfs !== undefined) {
    const v = record.tmpfs;
    if (!Array.isArray(v)) {
      warn('tmpfs', `tmpfs 必须为字符串数组，收到 ${JSON.stringify(v)}，已忽略`);
    } else {
      const kept: string[] = [];
      for (const item of v) {
        if (typeof item === 'string' && TMPFS_PATTERN.test(item)) kept.push(item);
        else warn('tmpfs', `tmpfs 项 ${JSON.stringify(item)} 不是绝对路径（或含非法字符），已丢弃`);
      }
      layer.tmpfs = kept;
    }
  }

  if (record.env !== undefined) {
    const v = record.env;
    if (!Array.isArray(v)) {
      warn('env', `env 必须为变量名数组，收到 ${JSON.stringify(v)}，已忽略`);
    } else {
      const kept: string[] = [];
      for (const item of v) {
        // 只允许「名字」：NAME=value 形式会让值落进 argv（--debug 泄漏 + 违背白名单语义）
        if (typeof item === 'string' && ENV_NAME_PATTERN.test(item)) kept.push(item);
        else warn('env', `env 项 ${JSON.stringify(item)} 不是合法变量名（禁止 NAME=value 形式），已丢弃`);
      }
      layer.env = kept;
    }
  }

  if (record.cacheVolume !== undefined) {
    const v = record.cacheVolume;
    if (v === null || typeof v === 'string') {
      layer.cacheVolume = v;
      warn('cacheVolume', 'cacheVolume 为 P2 预留字段，本期未实现，已忽略');
    } else {
      warn('cacheVolume', `cacheVolume 必须为字符串或 null，收到 ${JSON.stringify(v)}，已忽略`);
    }
  }

  // 3) 普通未知键：warning 忽略（不阻断，避免版本升级时旧配置炸掉）
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) warn(key, `未知配置项 ${key}，已忽略`);
  }

  return layer;
}

function intField(
  raw: unknown,
  field: string,
  min: number,
  max: number,
  warn: (field: string, message: string) => void,
  current: number | undefined,
): number | undefined {
  if (raw === undefined) return current;
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= min && raw <= max) return raw;
  warn(field, `${field} 必须是 [${min}, ${max}] 内的整数，收到 ${JSON.stringify(raw)}，已用默认值`);
  return current;
}

function numberField(
  raw: unknown,
  field: string,
  min: number,
  max: number,
  warn: (field: string, message: string) => void,
  current: number | undefined,
): number | undefined {
  if (raw === undefined) return current;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= min && raw <= max) return raw;
  warn(field, `${field} 必须是 [${min}, ${max}] 内的数字，收到 ${JSON.stringify(raw)}，已用默认值`);
  return current;
}

function boolField(
  raw: unknown,
  field: string,
  warn: (field: string, message: string) => void,
  current: boolean | undefined,
): boolean | undefined {
  if (raw === undefined) return current;
  if (typeof raw === 'boolean') return raw;
  warn(field, `${field} 必须为 boolean，收到 ${JSON.stringify(raw)}，已用默认值`);
  return current;
}

// ── 逐字段 merge ────────────────────────────────────────────────────────────

/**
 * 逐字段 merge（后者覆盖前者：user → project → session）。
 * 未声明（undefined）的字段不参与 merge，`provenance` 保持原值。
 */
export function mergeSandboxLayers(
  layers: Array<{ source: SandboxConfigSource; layer: SandboxConfigLayer }>,
): { config: SandboxConfig; provenance: SandboxConfigProvenance } {
  const config: SandboxConfig = { ...DEFAULT_SANDBOX_CONFIG };
  const provenance = {} as SandboxConfigProvenance;
  for (const f of SANDBOX_MERGE_FIELDS) provenance[f] = 'default';

  for (const field of SANDBOX_MERGE_FIELDS) {
    for (const { source, layer } of layers) {
      const value = layer[field as SandboxMergeField];
      if (value !== undefined) {
        // 逐字段赋值（各类字段类型在 normalize 阶段已收敛，此处只需结构化写入）
        (config as unknown as Record<string, unknown>)[field] = value;
        provenance[field] = source;
      }
    }
  }

  // 派生字段：user 与 image 的联动 —— 自定义镜像默认用「镜像自带用户」
  const userExplicit = layers.some((l) => l.layer.user !== undefined);
  config.userExplicit = userExplicit;
  config.user = userExplicit
    ? config.user
    : config.image === DEFAULT_SANDBOX_IMAGE
      ? DEFAULT_SANDBOX_CONFIG.user
      : null;

  return { config, provenance };
}

// ── 加载（两级文件 + 会话覆盖）───────────────────────────────────────────────

export interface LoadSandboxConfigOptions {
  projectRoot: string;
  /** 缺省 os.homedir() */
  homeDir?: string;
  /** CLI flag / Web 会话设置 */
  session?: SandboxSessionOverrides;
}

/** 全局配置文件路径（`sandbox enable/disable` 与 status 展示复用，保证单点）。 */
export function userSandboxConfigPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.y-zero', 'sandbox.json');
}

/** 项目配置文件路径。 */
export function projectSandboxConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.y-zero', 'sandbox.json');
}

/**
 * 加载生效配置。**永不 throw**：坏 JSON / 非法值都降级为 warning 或「该层不生效」。
 * 文件缺失时只做一次 `existsSync`（Z2：启动零成本，不 readFile / 不 parse）。
 */
export function loadSandboxConfig(opts: LoadSandboxConfigOptions): ResolvedSandboxConfig {
  const warnings: SandboxConfigWarning[] = [];
  const errors: SandboxConfigError[] = [];

  const homeDir = opts.homeDir ?? os.homedir();
  const userRaw = readSandboxFile(userSandboxConfigPath(homeDir), 'user', warnings, errors);
  const projectRaw = readSandboxFile(projectSandboxConfigPath(opts.projectRoot), 'project', warnings, errors);

  const userLayer = normalizeSandboxLayer(userRaw, 'user', warnings, errors);
  const projectLayer = normalizeSandboxLayer(projectRaw, 'project', warnings, errors);
  const sessionLayer = normalizeSandboxLayer(
    opts.session ? { ...opts.session } : undefined,
    'session',
    warnings,
    errors,
  );

  const { config, provenance } = mergeSandboxLayers([
    { source: 'user', layer: userLayer },
    { source: 'project', layer: projectLayer },
    { source: 'session', layer: sessionLayer },
  ]);

  // enforce：项目策略已强制容器执行 → fallback 恒定 deny（不 throw，保持「配置写错不该让 agent 起不来」）
  if (config.enforce) {
    if (config.fallback !== 'deny') {
      warnings.push({
        source: 'project',
        field: 'fallback',
        message: `enforce:true 下 fallback 固定为 deny（配置值 "${config.fallback}" 已被忽略）`,
      });
      config.fallback = 'deny';
      provenance.fallback = 'project';
    }
  }

  const explicit = SANDBOX_MERGE_FIELDS.some((f) => provenance[f] !== 'default');

  return { config, provenance, warnings, errors, explicit };
}

function readSandboxFile(
  file: string,
  source: SandboxConfigSource,
  warnings: SandboxConfigWarning[],
  errors: SandboxConfigError[],
): unknown {
  try {
    if (!fs.existsSync(file)) return undefined;
    const text = fs.readFileSync(file, 'utf8');
    if (text.trim() === '') {
      warnings.push({ source, message: `sandbox 配置（${source}）为空文件，已忽略：${file}` });
      return undefined;
    }
    return JSON.parse(text) as unknown;
  } catch (e) {
    // 坏 JSON 不致命：该层不生效 + 结构化 error（对齐 hooks/manager.ts 的既有惯例）
    errors.push({
      source,
      message: `sandbox 配置（${source}）无法解析 ${file}：${(e as Error).message}（已忽略该层）`,
    });
    return undefined;
  }
}

// ── enforce 偏序（只能更严）─────────────────────────────────────────────────

export interface EnforceViolation {
  field: keyof SandboxSessionOverrides;
  projectValue: unknown;
  overrideValue: unknown;
  message: string;
}

/**
 * 隔离强度偏序（§19）：local（无隔离）< seatbelt（macOS 进程级白名单）
 * < docker（容器级：文件系统/用户/资源上限全换）。enforce 下会话覆盖只能沿序收紧。
 */
const MODE_ORDER: Record<SandboxConfig['mode'], number> = { local: 0, seatbelt: 1, docker: 2 };
const NETWORK_ORDER: Record<SandboxNetwork, number> = { bridge: 0, none: 1 };

/**
 * `enforce: true` 时的「只能更严」判定（§3.4 偏序表，唯一事实来源）。
 *
 * 不可比字段（image 等）允许覆盖：enforce 的承诺是「容器 + 断网 + 只读根 + 资源上限」
 * 这四条不可被会话削弱；换镜像不削弱任何一条，且团队换基础镜像是正常需求。
 * 只有**可比的安全序字段**才做「只能更严」。
 */
export function checkEnforce(
  projectLayer: SandboxConfigLayer,
  override: SandboxSessionOverrides,
): EnforceViolation[] {
  const out: EnforceViolation[] = [];
  if (projectLayer.enforce !== true) return out;

  const projectMode = projectLayer.mode ?? DEFAULT_SANDBOX_CONFIG.mode;
  if (override.mode !== undefined && MODE_ORDER[override.mode] < MODE_ORDER[projectMode]) {
    out.push({
      field: 'mode',
      projectValue: projectMode,
      overrideValue: override.mode,
      message:
        projectMode === 'local'
          ? '项目策略已强制沙箱隔离执行：不能用会话覆盖降低隔离强度'
          : '项目策略已强制沙箱隔离执行：不能用 --sandbox local 降低隔离强度',
    });
  }

  const projectNetwork = projectLayer.network ?? DEFAULT_SANDBOX_CONFIG.network;
  if (override.network !== undefined && NETWORK_ORDER[override.network] < NETWORK_ORDER[projectNetwork]) {
    out.push({
      field: 'network',
      projectValue: projectNetwork,
      overrideValue: override.network,
      message:
        projectNetwork === 'none'
          ? '项目策略已关闭容器网络：不能用 --sandbox-network bridge 放开网络（只能维持 none）'
          : '项目策略要求断网外的最小暴露：不允许放开网络',
    });
  }

  // enforce 下 fallback 恒为 deny：任何非 deny 的会话覆盖都是「变宽松」
  if (override.fallback !== undefined && override.fallback !== 'deny') {
    out.push({
      field: 'fallback',
      projectValue: 'deny',
      overrideValue: override.fallback,
      message: '项目策略已强制容器执行：不能用 --sandbox-fallback 允许降级到本地执行',
    });
  }

  // 可比的安全序字段：只允许收紧
  const tightenings: Array<{ field: keyof SandboxSessionOverrides; project: unknown }> = [
    { field: 'readOnlyRoot', project: projectLayer.readOnlyRoot },
    { field: 'memoryMb', project: projectLayer.memoryMb },
    { field: 'cpus', project: projectLayer.cpus },
    { field: 'pidsLimit', project: projectLayer.pidsLimit },
  ];
  for (const { field, project } of tightenings) {
    const ov = override[field];
    if (ov === undefined || project === undefined) continue;
    if (field === 'readOnlyRoot') {
      if (project === true && ov === false) {
        out.push({
          field,
          projectValue: project,
          overrideValue: ov,
          message: '项目策略已强制只读根文件系统：不能用 --sandbox-readwrite 关闭',
        });
      }
      continue;
    }
    if (typeof project === 'number' && typeof ov === 'number' && ov > project) {
      out.push({
        field,
        projectValue: project,
        overrideValue: ov,
        message: `项目策略已限定 ${field} 上限为 ${project}：会话覆盖只能更小，不能放大到 ${ov}`,
      });
    }
  }

  // 不可比字段只做合法性校验：镜像名不得以 - 开头（否则会被当成 docker flag）
  if (override.image !== undefined && override.image.trim().startsWith('-')) {
    out.push({
      field: 'image',
      projectValue: projectLayer.image ?? DEFAULT_SANDBOX_IMAGE,
      overrideValue: override.image,
      message: 'sandbox 配置不允许镜像名以 - 开头：会被 docker 当成命令行参数',
    });
  }

  return out;
}

// ── 工作区根守卫（任何 docker 调用之前）─────────────────────────────────────

/**
 * 工作区根目录守卫（设计 §3.5 / R3）：
 * 拒绝把「文件系统根 / home / os.tmpdir() / 含 docker.sock」的目录挂进容器。
 *
 * 这些拒绝都发生在**任何 docker 调用之前**；文案必须包含「sandbox 配置不允许」（PRD F-30.6）。
 */
export function assertSafeWorkspaceRoot(realRoot: string): void {
  const root = samePathBase(realpathOr(path.resolve(realRoot)));
  const parsed = path.parse(root);
  const isFsRoot = parsed.root === root || /^[A-Za-z]:[\\/]?$/.test(root);
  if (isFsRoot) {
    throw new SandboxPathError(
      `[sandbox] sandbox 配置不允许在文件系统根（${root}）运行容器：` +
        `容器会把整个文件系统挂进 /workspace。请在具体项目目录运行，或改用 --sandbox local。`,
    );
  }

  if (samePath(root, realpathOr(os.homedir()))) {
    throw new SandboxPathError(
      `[sandbox] sandbox 配置不允许把 home 目录（${root}）作为工作区挂进容器：` +
        `其中包含 ~/.ssh 与 ~/.y-zero（Provider Key），隔离会失效。` +
        `请在具体项目目录运行，或改用 --sandbox local。`,
    );
  }

  if (samePath(root, realpathOr(os.tmpdir()))) {
    throw new SandboxPathError(
      `[sandbox] sandbox 配置不允许把系统临时目录（${root}）作为工作区挂进容器：` +
        `共享临时目录会把他人临时文件一并挂进去。请在具体项目目录运行，或改用 --sandbox local。`,
    );
  }

  const sock = path.join(root, 'docker.sock');
  if (fs.existsSync(sock) || /docker\.sock/i.test(root)) {
    throw new SandboxPathError(
      `[sandbox] sandbox 配置不允许工作区包含 docker.sock（${sock}）：` +
        `挂 docker.sock = 容器内 root ≈ 宿主 root。请将工作区移动到不含 docker.sock 的目录。`,
    );
  }
}

/** realpath（不存在/无权限时退回 resolve），供挂载源归一与守卫复用。 */
export function realpathOr(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  }
}

function samePathBase(p: string): string {
  const stripped = p.length > 1 ? p.replace(/[\\/]+$/, '') : p;
  return process.platform === 'win32' ? stripped.toLowerCase() : stripped;
}

function samePath(a: string, b: string): boolean {
  return samePathBase(a) === samePathBase(b);
}
