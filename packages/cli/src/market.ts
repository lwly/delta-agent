/**
 * `delta market` 子命令组（F-52 Skills/MCP 市场最小闭环）：
 *  - list/search  浏览合并清单（内置 + ~/.delta/registry.json 订阅源；离线回退仅内置）
 *  - install      安装 Skill（含 scripts 强制确认；--permission plan 拒绝）或 MCP（连通测试通过才写入）
 *  - remove       卸载已装 Skill / MCP Server
 *  - source       管理 registry.json 订阅源
 *
 * 与 `delta skill`（skillhub.cn zip 协议）并存：market 走清单式 registry 协议。
 */
import * as os from 'node:os';
import * as path from 'node:path';
import {
  findMarketEntry,
  installMarketMcp,
  installMarketSkill,
  listMarketSnapshot,
  readMarketSources,
  removeMarketItem,
  writeMarketSources,
  type MarketEntry,
  type MarketSourceKind,
} from '@delta/core';

type Kind = 'skill' | 'mcp';

/** plan 权限模式拒绝安装（plan = 只读会话语义，与写配置动作互斥）。返回拒绝理由；null = 允许 */
export function planModeRefusal(permission: string | undefined): string | null {
  if (permission === 'plan') {
    return '当前为 plan 权限模式（只读），拒绝安装。请改用 --permission default 或 yolo 后重试';
  }
  return null;
}

/** 是否需要 scripts 确认闸门（未确认返回待展示脚本清单） */
export function scriptsRequiringConfirmation(entry: MarketEntry): { name: string; content: string }[] {
  if (entry.kind !== 'skill' || !entry.scripts?.length) return [];
  return entry.scripts;
}

function oneLine(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function marketOpts() {
  return { homeDir: os.homedir() };
}

/** 列出合并清单（内置 + 订阅源），标注 kind / 来源 / 已装层 */
export async function marketListCommand(opts: { source?: string } = {}): Promise<void> {
  try {
    const snap = await listMarketSnapshot(marketOpts());
    const items = opts.source ? snap.items.filter((i) => i.source === opts.source) : snap.items;
    for (const s of snap.sources) {
      const mark = s.status === 'ok' ? '✔' : '✘';
      console.error(`${mark} 订阅源 ${s.name}（${s.kind}）：${s.status === 'ok' ? `${s.count} 条` : `拉取失败——${s.error ?? ''}`}`);
    }
    if (snap.legacySources) {
      console.error('ℹ 当前订阅源来自旧 skill-hub.json（registry.json 尚未创建），delta market source add 后即迁移');
    }
    if (snap.sources.some((s) => s.status === 'error')) {
      console.error('ℹ 离线降级：拉取失败的源已跳过，清单仅含内置条目与其他可用源');
    }
    for (const e of snap.errors) console.error(`⚠ ${e}`);
    console.log(`\n市场清单：${items.length} 条\n`);
    for (const item of items) {
      const { entry, source, installedIn } = item;
      const installed = Object.entries(installedIn).filter(([, v]) => v).map(([k]) => k).join('/') || '-';
      const ver = 'version' in entry && entry.version ? `@${entry.version}` : '';
      const extra = entry.kind === 'skill'
        ? (entry.scripts?.length ? `　⚠ 含 ${entry.scripts.length} 个脚本` : '')
        : '　MCP Server';
      console.log(`  [${entry.kind}] ${entry.name}${ver}　来源:${source}　已装:${installed}${extra}`);
      console.log(`    ${oneLine(entry.description, 90)}`);
    }
    console.log('\n安装：delta market install <name>　搜索：delta market search <关键词>');
  } catch (e) {
    console.error(`✘ 市场清单获取失败：${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** 关键词过滤合并清单（清单式协议，客户端过滤） */
export async function marketSearchCommand(query: string[]): Promise<void> {
  const q = query.join(' ').trim().toLowerCase();
  if (q === '') {
    console.error('✘ 请提供搜索词，例如：delta market review');
    process.exitCode = 1;
    return;
  }
  try {
    const snap = await listMarketSnapshot(marketOpts());
    const hits = snap.items.filter((i) =>
      i.entry.name.toLowerCase().includes(q) || i.entry.description.toLowerCase().includes(q));
    console.log(`搜索「${q}」命中 ${hits.length} 条：\n`);
    for (const item of hits) {
      const { entry, source } = item;
      console.log(`  [${entry.kind}] ${entry.name}　来源:${source}`);
      console.log(`    ${oneLine(entry.description, 90)}`);
    }
    if (hits.length === 0) console.log('（无结果）delta market list 查看全部');
  } catch (e) {
    console.error(`✘ 搜索失败：${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** 打印 scripts 确认卡（逐脚本展示内容），返回后由调用方决定退出 */
function printScriptsCard(name: string, source: string, scripts: { name: string; content: string }[]): void {
  console.error(`⚠ Skill「${name}」（来源：${source}）包含 ${scripts.length} 个脚本，安装前需逐脚本确认：`);
  for (const s of scripts) {
    console.error(`\n─── scripts/${s.name} ───`);
    console.error(s.content);
  }
  console.error('\n如确认允许安装，请带 --yes 重试：delta market install <name> --yes');
}

/** 安装条目：skill 或 mcp 自动判别（同名歧义要求 --kind） */
export async function marketInstallCommand(
  name: string,
  opts: { kind?: string; source?: string; project?: boolean; force?: boolean; yes?: boolean; permission?: string },
): Promise<void> {
  const refusal = planModeRefusal(opts.permission);
  if (refusal) {
    console.error(`✘ ${refusal}`);
    process.exitCode = 1;
    return;
  }

  // 定位条目：--source 指定源；未指定时按 builtin → 订阅源顺序，kind 按 skill → mcp（同名歧义用 --kind）
  const kinds: Kind[] = opts.kind === 'skill' || opts.kind === 'mcp' ? [opts.kind] : ['skill', 'mcp'];
  let found: { entry: MarketEntry; source: string } | null = null;
  try {
    outer: for (const kind of kinds) {
      if (opts.source) {
        const entry = await findMarketEntry(marketOpts(), kind, opts.source, name);
        if (entry) { found = { entry, source: opts.source }; break; }
        continue;
      }
      const builtin = await findMarketEntry(marketOpts(), kind, 'builtin', name);
      if (builtin) { found = { entry: builtin, source: 'builtin' }; break; }
      const { sources } = await readMarketSources(marketOpts().homeDir);
      for (const s of sources) {
        if (s.kind === 'skills' && kind !== 'skill') continue;
        if (s.kind === 'mcp' && kind !== 'mcp') continue;
        const entry = await findMarketEntry(marketOpts(), kind, s.name, name);
        if (entry) { found = { entry, source: s.name }; break outer; }
      }
    }
  } catch (e) {
    console.error(`✘ 条目定位失败：${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (!found) {
    console.error(`✘ 市场中不存在条目：${name}（delta market list 查看清单；订阅源条目需网络可达）`);
    process.exitCode = 1;
    return;
  }
  const { entry, source } = found;

  // Skill：scripts 闸门（逐脚本展示后拒绝，--yes 显式放行）
  const scripts = scriptsRequiringConfirmation(entry);
  if (scripts.length > 0 && !opts.yes) {
    printScriptsCard(entry.name, source, scripts);
    process.exitCode = 1;
    return;
  }

  if (entry.kind === 'skill') {
    try {
      const r = await installMarketSkill(entry, {
        layers: { homeDir: os.homedir(), projectRoot: opts.project ? process.cwd() : undefined },
        scope: opts.project ? 'project' : 'user',
        force: opts.force,
        confirmScripts: opts.yes,
      });
      if (r.status === 'scripts_required') {
        printScriptsCard(entry.name, source, r.scripts ?? []);
        process.exitCode = 1;
        return;
      }
      console.log(`✔ 已安装 Skill ${entry.name} → ${r.path}`);
      if (r.scriptsWritten?.length) console.log(`  脚本：${r.scriptsWritten.join(', ')}（已随包写入 scripts/）`);
      console.log('  即刻生效：三层加载器自动发现，无需重启');
    } catch (e) {
      console.error(`✘ 安装失败：${(e as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }

  // MCP：连通性测试通过才写入
  console.log(`测试 MCP Server「${entry.name}」连通性（${entry.draft.command ?? entry.draft.url}）…`);
  const r = await installMarketMcp(entry, {
    homeDir: os.homedir(),
    projectRoot: opts.project ? process.cwd() : undefined,
    scope: opts.project ? 'project' : 'global',
  });
  if (r.status === 'connect_failed') {
    console.error(`✘ 连通性测试未通过，未写入配置：${r.error ?? ''}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✔ 连通正常（${r.toolCount} 个工具），已写入：${r.path}`);
}

/** 卸载已装条目 */
export async function marketRemoveCommand(
  name: string,
  opts: { kind?: string; project?: boolean },
): Promise<void> {
  const kinds: Kind[] = opts.kind === 'skill' || opts.kind === 'mcp' ? [opts.kind] : ['skill', 'mcp'];
  let lastErr: Error | null = null;
  for (const kind of kinds) {
    try {
      const scope = opts.project ? 'project' : kind === 'mcp' ? 'global' : 'user';
      const r = await removeMarketItem(kind, name, scope, {
        homeDir: os.homedir(),
        projectRoot: process.cwd(),
      });
      console.log(`✔ 已卸载 ${kind} ${name}（${r.path}）`);
      return;
    } catch (e) {
      lastErr = e as Error;
    }
  }
  console.error(`✘ 卸载失败：${lastErr?.message ?? '未找到'}`);
  process.exitCode = 1;
}

// ── source 管理（registry.json）─────────────────────────────────────────────

/** source list：查看订阅源（标注旧配置回退状态） */
export async function marketSourceListCommand(): Promise<void> {
  const { sources, legacy, error } = await readMarketSources(os.homedir());
  if (error) console.error(`⚠ ${error}`);
  console.log(`配置文件：${path.join(os.homedir(), '.delta', 'registry.json')}`);
  if (legacy) console.log('（当前数据来自旧 skill-hub.json 兼容回退）');
  console.log(`订阅源：${sources.length} 个`);
  for (const s of sources) console.log(`  ${s.name.padEnd(20)} [${s.kind}] ${s.url}`);
}

/** source add：新增订阅源（同名拒绝） */
export async function marketSourceAddCommand(name: string, url: string, kind: string): Promise<void> {
  if (kind !== 'skills' && kind !== 'mcp') {
    console.error('✘ --kind 必须是 skills 或 mcp');
    process.exitCode = 1;
    return;
  }
  const { sources } = await readMarketSources(os.homedir());
  if (sources.some((s) => s.name === name)) {
    console.error(`✘ 订阅源同名已存在：${name}（先 remove 再 add）`);
    process.exitCode = 1;
    return;
  }
  try {
    const file = await writeMarketSources(os.homedir(), [...sources, { name, url, kind: kind as MarketSourceKind }]);
    console.log(`✔ 已添加订阅源 ${name}（${kind}）→ ${file}`);
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** source remove：删除订阅源 */
export async function marketSourceRemoveCommand(name: string): Promise<void> {
  const { sources } = await readMarketSources(os.homedir());
  const next = sources.filter((s) => s.name !== name);
  if (next.length === sources.length) {
    console.error(`✘ 订阅源不存在：${name}`);
    process.exitCode = 1;
    return;
  }
  try {
    await writeMarketSources(os.homedir(), next);
    console.log(`✔ 已移除订阅源 ${name}`);
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
