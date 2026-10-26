/**
 * F-39 `delta expert` 子命令（P0：list / show；import/export/new 归 P1 T15）
 */
import { ExpertStore } from '@delta/core';
import { displayOf } from '@delta/core';

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
