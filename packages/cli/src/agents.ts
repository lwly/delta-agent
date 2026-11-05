/**
 * `delta agents` 子命令组（F-56，PASI-87）：
 *  - add <templateId>  手动注册外部 agent 条目（upsert，写 ~/.delta/external.json）
 *  - list              列出 external.json 全部条目（手动/探测缓存）
 *  - remove <id>       移除手动注册条目
 *
 * 与 Web 向导（设置 → 外部 Agent）共用 core 的 upsertManualEntry / removeManualEntry；
 * 模板清单 `delta agents templates` 一并给出（对应向导第 1 步网格）。
 */
import {
  KNOWN_AGENTS,
  ManualRegisterError,
  findKnownAgent,
  readExternalAgentsCache,
  removeManualEntry,
  resolveAgentModels,
  upsertManualEntry,
} from '@delta/core';

function fail(msg: string): never {
  console.error(`[delta] ${msg}`);
  process.exitCode = 1;
  throw new Error(msg);
}

export async function agentsAddCommand(opts: {
  templateId: string;
  command?: string;
  name?: string;
  description?: string;
  model?: string;
  homeDir?: string;
}): Promise<void> {
  try {
    const entry = upsertManualEntry(
      {
        templateId: opts.templateId,
        command: opts.command,
        displayName: opts.name,
        description: opts.description,
        model: opts.model,
      },
      opts.homeDir,
    );
    console.log(`已注册外部 Agent：${entry.displayName ?? entry.id}`);
    console.log(`  id：${entry.id}`);
    console.log(`  命令：${entry.command}`);
    if (entry.model) console.log(`  模型：${entry.model}`);
    if (entry.description) console.log(`  描述：${entry.description}`);
    console.log('下次探测将以该条目为准（manual 条目探测失败不移除）。');
  } catch (e) {
    if (e instanceof ManualRegisterError) {
      const tpl = KNOWN_AGENTS.map((d) => `${d.id} (${d.label})`).join('、');
      fail(`${e.message}\n可用模板：${tpl}`);
    }
    throw e;
  }
}

export async function agentsListCommand(opts: { homeDir?: string } = {}): Promise<void> {
  const agents = readExternalAgentsCache(opts.homeDir);
  if (agents.length === 0) {
    console.log('external.json 为空——运行 `delta agents add <templateId>` 手动注册，或直接启动会话触发 PATH 探测。');
    return;
  }
  for (const e of agents) {
    const name = e.manual ? (e.displayName ?? e.id) : e.id;
    const mark = e.manual ? ' [手动]' : ' [缓存]';
    console.log(`${name}${mark}`);
    console.log(`  id：${e.id}  tier：${e.tier}  kind：${e.kind}  version：${e.version || '(未探测)'}`);
    console.log(`  命令：${e.command}`);
    if (e.model) console.log(`  模型：${e.model}`);
    if (e.description) console.log(`  描述：${e.description}`);
  }
}

export async function agentsTemplatesCommand(): Promise<void> {
  console.log('内置外部 Agent 模板：');
  for (const d of KNOWN_AGENTS) {
    console.log(`  ${d.id.padEnd(18)} ${d.label.padEnd(14)} Tier ${d.tier}  ${d.description}`);
    if (d.models?.length) console.log(`    候选模型：${d.models.join('、')}`);
  }
}

/** F-56 自动获取模型：跑 CLI 列举命令解析，失败回落静态清单（与 Web 向导同一 resolveAgentModels） */
export async function agentsModelsCommand(opts: {
  templateId: string;
  command?: string;
  probeTimeoutMs?: number;
}): Promise<void> {
  const def = findKnownAgent(opts.templateId);
  if (!def) {
    const tpl = KNOWN_AGENTS.map((d) => d.id).join('、');
    fail(`未知模板 id：${opts.templateId}\n可用模板：${tpl}`);
  }
  const { models, source } = await resolveAgentModels(def!, opts.command ?? def!.executable, {
    probeTimeoutMs: opts.probeTimeoutMs,
  });
  console.log(`${def!.label}（${def!.id}）候选模型（${source === 'probed' ? 'CLI 实时列举' : '静态建议'}，共 ${models.length} 个）：`);
  for (const m of models) console.log(`  ${m}`);
  if (source === 'static') console.log('（该 CLI 未提供列举命令或探测失败，以上为静态建议清单）');
}

export async function agentsRemoveCommand(id: string, opts: { homeDir?: string } = {}): Promise<void> {
  const removed = removeManualEntry(id, opts.homeDir);
  if (!removed) fail(`未找到手动注册条目：${id}（探测缓存条目由探测自动维护，无需移除）`);
  console.log(`已移除：${id}`);
}
