/**
 * F-51 `delta doctor` —— 环境自检（AC-51-2）。
 *
 * 体检项：版本/安装渠道、Node 版本、OS/Shell、配置目录、models.json 与
 * API Key 可解密性、SQLite 会话库、Provider 连通性（可 --offline 跳过）。
 *
 * 设计约定：
 *  - 每个检查项产出 DoctorCheckResult；失败项必须带 next（「下一步」指令）；
 *  - 纯逻辑（collectDoctorChecks）与打印（doctorCommand）分离，便于单测注入 homeDir/dbPath；
 *  - 输出符号沿用全仓库约定：✔ 成功 / ⚠ 警告 / ✘ 失败 / ℹ 提示；
 *  - 任一 ✘ 时 process.exitCode = 1（不用 throw，与 models test 等子命令一致）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LATEST_SCHEMA_VERSION, SessionStore } from '@delta/core/session';
import { APP_VERSION, FILES, userConfigDir } from '@delta/core/paths';
import { ProviderManager, decryptKeyDetailed, loadModelsFile } from '@delta/core/llm';
import { KNOWN_AGENTS, checkLoginState, ensureExternalAdapters, externalEnvPathName } from '@delta/core/external';
import { compareVersions, detectChannel } from '@delta/core/update';

/** 最低要求的 Node 主版本（与根 package.json engines / README 环境要求一致） */
export const MIN_NODE_VERSION = '20.0.0';

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'info';

export interface DoctorCheckResult {
  /** 检查项 id（稳定，供测试与 JSON 消费） */
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  /** 失败/警告时的「下一步」修复指令（AC-51-2） */
  next?: string;
}

export interface DoctorOptions {
  /** 注入用户主目录（测试用；缺省 os.homedir()） */
  homeDir?: string;
  /** 注入 SQLite 路径（测试用；缺省 ~/.delta/agent.db） */
  dbPath?: string;
  /** 跳过 Provider 连通性网络请求（CI / 离线环境） */
  offline?: boolean;
  /** Provider 连通性探测超时（ms） */
  timeoutMs?: number;
  /** F-55 外部 agent 版本探测超时（ms；缺省 core PROBE_TIMEOUT_MS，测试可调小） */
  probeTimeoutMs?: number;
}

/** 判定最终退出码：任一 fail → 1（warn/info/ok 均 0）。 */
export function doctorExitCode(results: DoctorCheckResult[]): 0 | 1 {
  return results.some((r) => r.status === 'fail') ? 1 : 0;
}

function ok(id: string, label: string, detail: string): DoctorCheckResult {
  return { id, label, status: 'ok', detail };
}
function fail(id: string, label: string, detail: string, next: string): DoctorCheckResult {
  return { id, label, status: 'fail', detail, next };
}
function warn(id: string, label: string, detail: string, next: string): DoctorCheckResult {
  return { id, label, status: 'warn', detail, next };
}
function info(id: string, label: string, detail: string): DoctorCheckResult {
  return { id, label, status: 'info', detail };
}

/** 版本与安装渠道（SEA 单文件 / npm 全局）——仅陈述，恒 ok。 */
async function checkVersion(): Promise<DoctorCheckResult> {
  const channel = await detectChannel();
  return ok('version', '版本', `delta ${APP_VERSION}（${channel === 'sea' ? 'SEA 单文件' : 'npm'} 渠道）`);
}

/** Node 版本 >= 20。 */
function checkNode(): DoctorCheckResult {
  const v = process.versions.node;
  const cmp = compareVersions(v, MIN_NODE_VERSION);
  if (cmp !== null && cmp < 0) {
    return fail(
      'node',
      'Node.js',
      `当前 ${v}，低于最低要求 ${MIN_NODE_VERSION}`,
      '升级 Node：nvm install 20，或到 https://nodejs.org 下载 LTS 安装包',
    );
  }
  return ok('node', 'Node.js', `v${v}`);
}

/** OS / Shell 信息（仅陈述；Windows 缺 SHELL 时读 COMSPEC）。 */
function checkOsShell(): DoctorCheckResult {
  const shell = process.env.SHELL ?? process.env.COMSPEC ?? '（未知）';
  const detail = `${os.type()} ${os.release()} ${os.arch()} · shell: ${shell}`;
  return ok('os', '系统', detail);
}

/** 用户配置目录存在且可写。 */
function checkConfigDir(homeDir?: string): DoctorCheckResult {
  const dir = userConfigDir(homeDir);
  const probe = path.join(dir, '.doctor-probe');
  if (!fs.existsSync(dir)) {
    return info('config-dir', '配置目录', `${dir} 不存在（首次运行自动创建）`);
  }
  try {
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    return fail(
      'config-dir',
      '配置目录',
      `${dir} 不可写：${(e as Error).message}`,
      process.platform === 'win32'
        ? `检查目录权限：icacls "${dir}"（当前用户需要写权限）`
        : `检查目录权限：ls -ld "${dir}"（当前用户需要写权限）`,
    );
  }
  return ok('config-dir', '配置目录', `${dir} 可写`);
}

/** models.json 可解析 + API Key 可解密（换机器/重装系统后 Key 会失配）。 */
function checkModelsFile(homeDir?: string): DoctorCheckResult {
  const file = path.join(userConfigDir(homeDir), FILES.models);
  if (!fs.existsSync(file)) {
    return info('models', 'Provider 配置', '未配置（还没 models.json）');
  }
  let data;
  try {
    data = loadModelsFile(file);
  } catch (e) {
    return fail(
      'models',
      'Provider 配置',
      `${file} 解析失败：${(e as Error).message}`,
      `备份后修复或删除该文件重新配置：delta models add`,
    );
  }
  const bad = data.providers.filter((p) => p.apiKey && decryptKeyDetailed(p.apiKey).scheme === 'none');
  if (bad.length > 0) {
    return warn(
      'models',
      'Provider 配置',
      `${data.providers.length} 个 Provider，其中 ${bad.map((p) => p.id).join(', ')} 的 Key 无法解密（多半来自其他机器）`,
      '重新录入这些 Provider 的 Key：delta models add',
    );
  }
  return ok('models', 'Provider 配置', `${data.providers.length} 个 Provider（Key 全部可解密）`);
}

/** 会话库完整性：打开 + quick_check + schema 版本对齐。 */
function checkDatabase(opts: Pick<DoctorOptions, 'dbPath' | 'homeDir'>): DoctorCheckResult {
  const file = opts.dbPath ?? path.join(userConfigDir(opts.homeDir), FILES.database);
  if (!fs.existsSync(file)) {
    return info('db', '会话数据库', `${file} 不存在（首次运行自动创建）`);
  }
  let store: SessionStore;
  try {
    store = new SessionStore(file);
  } catch (e) {
    return fail(
      'db',
      '会话数据库',
      `打不开 ${file}：${(e as Error).message}`,
      '关闭占用进程后重试；确认文件未损坏（备份后可删除让 delta 重建）',
    );
  }
  try {
    const checkRow = store.db.pragma('quick_check') as Array<{ quick_check: string }>;
    const integrity = checkRow[0]?.quick_check ?? 'error';
    if (integrity !== 'ok') {
      return fail(
        'db',
        '会话数据库',
        `完整性检查：${integrity}`,
        '备份后删除该库让 delta 重建（历史会话会丢，重要内容先 delta export）',
      );
    }
    if (store.schemaVersion > LATEST_SCHEMA_VERSION) {
      return warn(
        'db',
        '会话数据库',
        `库 schema v${store.schemaVersion} 比当前 CLI（v${LATEST_SCHEMA_VERSION}）新，可能产生不兼容写入`,
        '升级 delta 到最新版本',
      );
    }
    return ok('db', '会话数据库', `integrity ok · schema v${store.schemaVersion}`);
  } finally {
    store.close();
  }
}

/** Provider 连通性（默认 Provider 发最小 chat 请求；--offline 跳过）。 */
async function checkProviderConnectivity(opts: DoctorOptions): Promise<DoctorCheckResult> {
  const mgr = new ProviderManager(opts.homeDir ? path.join(userConfigDir(opts.homeDir), FILES.models) : undefined);
  const target = mgr.activeIds()[0];
  if (!target) {
    return info('provider', 'Provider 连通', '没有已启用的 Provider，跳过连通测试');
  }
  const r = await mgr.test(target, opts.timeoutMs ?? 10_000);
  if (!r.ok) {
    return fail(
      'provider',
      'Provider 连通',
      `${target}：${r.detail}`,
      `查看详情：delta models test ${target}；确认网络可达与 Key 有效`,
    );
  }
  return ok('provider', 'Provider 连通', `${target}：${r.detail}（${r.latencyMs}ms）`);
}

/**
 * F-55 外部 Agent 检查节（design-f55 §10 探测与配置展示 + §5.2/AC-55-7 能力降级声明）。
 *
 * 探测复用 ensureExternalAdapters（副作用说明：探测结果落 ~/.delta/external.json 缓存，
 * §10 设计如此；只探测不安装、不代用户接受许可条款，§16）。
 * 登录态只 existsSync（§10 红线：不解析内容、不复制、不上报）。
 * 外部检查项永不 fail（探测不到是常态，info 即可），不影响退出码聚合。
 */
async function checkExternalAgents(opts: DoctorOptions): Promise<DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = [];
  const detected = await ensureExternalAdapters({
    ...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {}),
    ...(opts.probeTimeoutMs !== undefined ? { probeTimeoutMs: opts.probeTimeoutMs } : {}),
  });

  // 探测结果（路径 / 版本 / 来源 env|cache|path）
  if (detected.length === 0) {
    results.push(
      info('external-probe', '外部 Agent 探测', '未探测到外部 Agent（delta 只探测不安装；PATH 上没有可用 CLI 或 --version 探测失败）'),
    );
  } else {
    results.push(
      ok(
        'external-probe',
        '外部 Agent 探测',
        detected.map((d) => `${d.def.id} ${d.version} @ ${d.command}（来源 ${d.source}）`).join('；'),
      ),
    );
  }

  // 登录态存在性（§10：只 existsSync，不解析内容、不复制、不上报）。
  // 未登录是正常状态而非环境缺陷 → info（不 warn）：全新环境 doctor 结论须保持「全部通过」
  // （AC-51-4 / e2e ⑦ 契约），与「无 Provider 时为提示而非失败」同一口径
  if (detected.length === 0) {
    results.push(info('external-login', '外部 Agent 登录态', '（无探测结果，跳过登录态检查）'));
  } else {
    const marks = detected
      .map((d) => {
        const has = checkLoginState(d.def, opts.homeDir);
        return `${d.def.id} ${has ? '✓' : `✗（未检测到登录态文件；如需使用，先在终端运行 ${d.def.executable} 完成登录）`}`;
      })
      .join('；');
    results.push(info('external-login', '外部 Agent 登录态', `${marks}（存在性检查，未解析内容）`));
  }

  // 三档支持度（§5.1）：permissionArgs 非空 = 上游有显式 flags 支持
  if (detected.length > 0) {
    const marks = detected
      .map((d) => {
        const p = d.def.permissionArgs;
        const mark = (args: string[]): string => (args.length > 0 ? '✓' : '✗');
        return `${d.def.id}：plan ${mark(p.plan)} / default ${mark(p.default)} / yolo ${mark(p.yolo)}`;
      })
      .join('；');
    results.push(
      info(
        'external-permissions',
        '外部 Agent 权限档',
        `${marks}（plan 档依赖上游只读模式；default 档非交互宿主上游自行拒绝）`,
      ),
    );
  }

  // 能力降级声明（§5.2 / AC-55-7）：固定文案，必须显式告知，不能静默失效
  results.push(
    info(
      'external-capabilities',
      '外部会话能力降级',
      '外部会话不使用 delta 沙箱 / 内置 Function 不可注入 / 无上下文压缩与记忆蒸馏 / 订阅内调用不计费（usage.billing=subscription）',
    ),
  );

  // 显式路径环境变量提示（优先级最高：env > external.json > PATH）
  results.push(
    info(
      'external-env',
      '外部 Agent 路径环境变量',
      `${KNOWN_AGENTS.map((d) => `${d.id} → ${externalEnvPathName(d.id)}`).join('；')}（显式指定可执行路径，优先级高于 external.json 缓存与 PATH 探测）`,
    ),
  );
  return results;
}

/** 收集全部检查项（不做打印，便于单测）。 */
export async function collectDoctorChecks(opts: DoctorOptions = {}): Promise<DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = [];
  results.push(await checkVersion());
  results.push(checkNode());
  results.push(checkOsShell());
  results.push(checkConfigDir(opts.homeDir));
  results.push(checkModelsFile(opts.homeDir));
  results.push(checkDatabase({ dbPath: opts.dbPath, homeDir: opts.homeDir }));
  if (!opts.offline) {
    results.push(await checkProviderConnectivity(opts));
  }
  results.push(...(await checkExternalAgents(opts)));
  return results;
}

const MARK: Record<DoctorStatus, string> = { ok: '✔', warn: '⚠', fail: '✘', info: 'ℹ' };

function render(results: DoctorCheckResult[]): string[] {
  const lines = [`delta doctor（v${APP_VERSION}）`, ''];
  for (const r of results) {
    lines.push(`${MARK[r.status]} ${r.label}：${r.detail}`);
    if (r.next) lines.push(`    ↳ 下一步：${r.next}`);
  }
  const bad = results.filter((r) => r.status === 'fail').length;
  const warns = results.filter((r) => r.status === 'warn').length;
  lines.push('');
  lines.push(bad + warns === 0 ? '结论：全部通过 ✔' : `结论：${bad} 项失败，${warns} 项警告`);
  return lines;
}

/** `delta doctor` 入口：收集 → 打印 → 置退出码。 */
export async function doctorCommand(opts: DoctorOptions = {}): Promise<void> {
  const results = await collectDoctorChecks(opts);
  for (const line of render(results)) console.log(line);
  if (doctorExitCode(results) !== 0) process.exitCode = 1;
}
