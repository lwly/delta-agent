/**
 * F-39 `delta expert` 子命令（list / show / import / export / new）
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { zipSync } from 'fflate';
import * as readline from 'node:readline';
import {
  ExpertStore,
  displayOf,
  installExpertFromBytes,
  exportExpertToBytes,
  scaffoldExpert,
  readExpertsConfig,
  isTrusted,
  recordTrust,
} from '@delta/core';

export interface ExpertCommandOptions {
  projectRoot?: string;
  homeDir?: string;
}

export async function expertListCommand(opts: ExpertCommandOptions & { verbose?: boolean }): Promise<void> {
  const store = new ExpertStore({ ...(opts.projectRoot ? { projectRoot: opts.projectRoot } : {}), homeDir: opts.homeDir });
  const { experts, errors } = await store.list();
  if (experts.length === 0) {
    console.log('（专家库为空：packages/core/experts、~/.delta/experts、.delta/experts 均无包）');
  }
  for (const e of experts) {
    const icon = e.expertType === 'team' ? '▣' : '◆';
    const type = e.expertType === 'team' ? `团队·${e.members.length}人` : '单人';
    console.log(`${icon} ${e.name.padEnd(24)} ${displayOf(e.displayName).padEnd(14)} ${displayOf(e.profession).padEnd(10)} ${type.padEnd(8)} ${e.layer}`);
  }
  if (opts.verbose) {
    const layers = await store.layers();
    for (const [layer, list] of Object.entries(layers.byLayer)) {
      for (const e of list) {
        if (experts.some((x) => x.name === e.name && x.layer === layer)) continue;
        console.log(`  (被覆盖) ${layer}/${e.name} → 已被更高层同名包覆盖`);
      }
    }
    for (const err of errors) console.error(`✘ ${err}`);
  }
}

export async function expertShowCommand(name: string, opts: ExpertCommandOptions): Promise<void> {
  const store = new ExpertStore({ ...(opts.projectRoot ? { projectRoot: opts.projectRoot } : {}), homeDir: opts.homeDir });
  const record = await store.get(name);
  if (!record) {
    console.error(`✘ 未找到专家 ${name}`);
    process.exitCode = 1;
    return;
  }
  const lines = [
    `${record.expertType === 'team' ? '▣' : '◆'} ${record.name}  v${record.version}  · ${record.layer}`,
    `${displayOf(record.displayName)}（${displayOf(record.profession)}）`,
    record.description,
    '',
    `作者：${record.author.name}`,
    `工具：${record.tools ? record.tools.join(', ') : '不收窄（全部可用）'}`,
    `技能：${record.skills.length ? record.skills.join(', ') : '（无）'}`,
  ];
  if (record.expertType === 'team') {
    lines.push('', `成员（${record.members.length}）：`);
    for (const m of record.members) {
      lines.push(`  ${m.role === 'lead' ? '★' : '-'} ${m.id}  ${displayOf(m.displayName)}（${displayOf(m.profession)}）`);
    }
  }
  lines.push('', `提示词（${record.promptStats.chars} 字 ≈ ${record.promptStats.tokens} tok${record.promptStats.truncated ? '，注入时截断到 6000' : ''}）：`);
  for (const l of record.agent.body.split('\n').slice(0, 8)) lines.push(`  | ${l}`);
  console.log(lines.join('\n'));
}


export interface ExpertIoOptions {
  projectRoot?: string;
  homeDir?: string;
}

/** zip 或目录 → 安装到 user/project 层（目录会先打成内存 zip 走同一校验链） */
export async function expertImportCommand(
  src: string,
  opts: ExpertIoOptions & { layer?: string; force?: boolean },
): Promise<void> {
  const layer = opts.layer === 'project' ? 'project' : 'user';
  const st = await fs.stat(src).catch(() => null);
  let bytes: Uint8Array;
  if (!st) {
    console.error(`✘ 路径不存在：${src}`);
    process.exitCode = 1;
    return;
  }
  if (st.isDirectory()) {
    const entries: Record<string, Uint8Array> = {};
    const walk = async (dir: string): Promise<void> => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) entries[path.relative(src, p).replace(/\\/g, '/')] = new Uint8Array(await fs.readFile(p));
      }
    };
    await walk(src);
    bytes = zipSync(entries);
  } else {
    bytes = new Uint8Array(await fs.readFile(src));
  }
  try {
    const r = await installExpertFromBytes(bytes, { layer, force: opts.force, homeDir: opts.homeDir, projectRoot: opts.projectRoot });
    console.log(`✔ 已导入 ${r.name} → ${layer} 层（${r.dir}）`);
    for (const w of r.warnings) console.warn(`⚠ ${w}`);
  } catch (e) {
    console.error(`✘ 导入失败：${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export async function expertExportCommand(name: string, out: string, opts: ExpertIoOptions): Promise<void> {
  try {
    const r = await exportExpertToBytes(name, { homeDir: opts.homeDir, projectRoot: opts.projectRoot });
    await fs.writeFile(out, r.bytes);
    console.log(`✔ 已导出 ${name} → ${out}（${(r.bytes.byteLength / 1024).toFixed(1)}KB）`);
  } catch (e) {
    console.error(`✘ 导出失败：${(e as Error).message}`);
    process.exitCode = 1;
  }
}

export async function expertNewCommand(
  name: string,
  opts: ExpertIoOptions & { team?: boolean; layer?: string; displayName?: string; profession?: string },
): Promise<void> {
  try {
    const r = await scaffoldExpert({
      name,
      displayName: opts.displayName ?? name,
      profession: opts.profession ?? (opts.team ? '交付团队' : '专家'),
      expertType: opts.team ? 'team' : 'agent',
      layer: opts.layer === 'project' ? 'project' : 'user',
      homeDir: opts.homeDir,
      projectRoot: opts.projectRoot,
    });
    console.log(`✔ 已创建骨架：${r.dir}`);
    console.log('下一步：编辑 expert.json 与 agents/*.md，写好后 `delta expert list` 即可见。');
  } catch (e) {
    console.error(`✘ 创建失败：${(e as Error).message}`);
    process.exitCode = 1;
  }
}


/** y/N 确认（readline；EOF/非交互返回空 = 拒绝） */
async function askConfirm(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
  rl.close();
  return answer;
}

/** 展示首次使用信息（来源层 + 工具白名单 + 写/执行警示） */
function printTrustInfo(name: string, opts: ExpertIoOptions): Promise<{ ok: boolean; record: import('@delta/core').ExpertRecord } | { ok: false }> {
  return (async () => {
    const store = new ExpertStore({ ...(opts.projectRoot ? { projectRoot: opts.projectRoot } : {}), homeDir: opts.homeDir });
    const record = await store.get(name);
    if (!record) {
      console.error(`✘ 未找到专家 ${name}`);
      return { ok: false as const };
    }
    const cfg = await readExpertsConfig(opts.homeDir ?? '');
    if (isTrusted(cfg, record)) return { ok: true as const, record };
    console.error(`首次使用专家「${displayOf(record.displayName)}」（${record.layer} 层，v${record.version}）`);
    console.error(`工具白名单：${record.tools ? record.tools.join(', ') : '不收窄（全部工具可用）'}`);
    const hasWrite = record.tools?.some((t) => ['write_file', 'edit_file'].includes(t));
    const hasExec = record.tools?.some((t) => ['run_command', 'run_tests'].includes(t));
    if (hasWrite || hasExec) {
      console.error(`⚠ 该专家${hasWrite ? '可修改你的文件' : ''}${hasWrite && hasExec ? '、' : ''}${hasExec ? '可执行命令' : ''}（写/执行操作仍走会话确认流）`);
    }
    return { ok: true as const, record };
  })();
}

/** `delta expert trust <name>`：非交互环境必须 --yes；拒绝 → 退出码 1 */
export async function expertTrustCommand(
  name: string,
  opts: ExpertIoOptions & { yes?: boolean },
): Promise<void> {
  const info = await printTrustInfo(name, opts);
  if (!info.ok) {
    process.exitCode = 1;
    return;
  }
  if (info.record.layer === 'builtin') {
    console.log('内置专家无需信任确认');
    return;
  }
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      console.error('✘ 非交互环境：请用 --yes 明确信任（知情同意不留静默通道）');
      process.exitCode = 1;
      return;
    }
    const answer = await askConfirm('信任并允许召唤该专家？[y/N] ');
    if (answer.trim().toLowerCase() !== 'y') {
      console.error('已取消（未记录信任）');
      process.exitCode = 1;
      return;
    }
  }
  await recordTrust(opts.homeDir ?? '', info.record);
  console.log(`✔ 已信任 ${name}（版本或工具集变化后需重新确认）`);
}

export { printTrustInfo, askConfirm };
