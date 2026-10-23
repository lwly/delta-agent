/**
 * `yzero onboarding` 子命令组（F-34 设计 §6，样例沿用 notify.ts / sandbox.ts）：
 *  - status   查看状态、草案与目标文件情况
 *  - run      扫描项目并用一次 LLM 调用生成草案（--force 忽略已有状态重新生成）
 *  - confirm  采纳草案（改名到位；目标已存在绝不覆盖，提示手工合并）
 *  - skip     跳过（不再自动扫描）
 */
import * as fs from 'node:fs';
import {
  loadOnboardingState,
  runOnboardingScan,
  confirmOnboarding,
  skipOnboarding,
  agentMdDraftPath,
  memoryMdDraftPath,
  agentMdTargetPath,
  memoryMdTargetPath,
  resolveProviderFromEnv,
} from '@y-zero/core';

/** status：打印状态与草案/目标文件情况（不做任何写操作）。 */
export function onboardingStatusCommand(): void {
  const projectRoot = process.cwd();
  const state = loadOnboardingState(projectRoot);
  const lines: string[] = [];
  const statusLabel: Record<string, string> = {
    pending: '待扫描（尚未生成草案）',
    draft: '草案已生成，待确认',
    confirmed: '已采纳',
    skipped: '已跳过',
  };
  lines.push(`onboarding 状态：${statusLabel[state.status] ?? state.status}`);
  lines.push(`自动扫描：${state.auto === false ? '已关闭' : '已开启（新项目首次注册时自动执行）'}`);
  if (state.generatedAt) lines.push(`生成时间：${state.generatedAt}（模型：${state.model ?? '未知'}）`);
  if (state.summary) lines.push(`项目摘要：${state.summary}`);
  const files: Array<[string, string, string]> = [
    ['agent.md 草案', agentMdDraftPath(projectRoot), agentMdTargetPath(projectRoot)],
    ['MEMORY.md 草案', memoryMdDraftPath(projectRoot), memoryMdTargetPath(projectRoot)],
  ];
  for (const [label, draft, target] of files) {
    const hasDraft = fs.existsSync(draft);
    const hasTarget = fs.existsSync(target);
    lines.push(`${label}：${hasDraft ? (hasTarget ? `草案与正式文件并存（${draft}，需手工合并）` : `待采纳（${draft}）`) : hasTarget ? `已有正式文件（${target}）` : '无'}`);
  }
  console.log(lines.join('\n'));
  if (state.status === 'draft') console.log('\n采纳：`yzero onboarding confirm`　跳过：`yzero onboarding skip`');
  if (state.status === 'pending') console.log('\n生成草案：`yzero onboarding run`');
}

/** run：扫描 + 生成草案（需要已配置模型 provider）。 */
export async function onboardingRunCommand(opts: { force?: boolean }): Promise<void> {
  const projectRoot = process.cwd();
  const state = loadOnboardingState(projectRoot);
  if (state.status !== 'pending' && !opts.force) {
    console.log(`ℹ onboarding 状态为 ${state.status}，跳过（--force 可重新生成）`);
    return;
  }
  let provider;
  try {
    provider = await resolveProviderFromEnv(undefined);
  } catch (e) {
    console.error(`✘ 无法解析模型 provider：${(e as Error).message}`);
    process.exitCode = 1;
    return;
  }
  const model = process.env.YZERO_MODEL || 'claude-sonnet-4-5-20250929';
  console.log(`⏳ 正在扫描项目并生成静态记忆草案（模型：${model}）…`);
  try {
    const r = await runOnboardingScan({ projectRoot, provider, model, force: opts.force });
    if (r.skipped) {
      console.log(`ℹ ${r.reason}`);
      return;
    }
    console.log(`✔ 项目摘要：${r.summary}`);
    console.log(`✔ 草案已生成：\n  ${r.agentMdDraftPath}\n  ${r.memoryMdDraftPath}`);
    console.log('\n确认采纳：`yzero onboarding confirm`（目标文件已存在时不覆盖，需手工合并）');
  } catch (e) {
    console.error(`✘ onboarding 生成失败：${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** confirm：采纳草案到位。 */
export function onboardingConfirmCommand(): void {
  const r = confirmOnboarding(process.cwd());
  if (r.applied.length === 0 && r.skipped.length === 0) {
    console.log('ℹ 没有待采纳的草案（先运行 `yzero onboarding run`）');
    return;
  }
  for (const f of r.applied) console.log(`✔ 已采纳：${f}`);
  for (const s of r.skipped) {
    console.log(`⚠ 目标已存在，未覆盖：${s.target}（草案在 ${s.draft}，请手工合并后删除草案）`);
  }
  console.log('ℹ 静态记忆在下一次会话启动时注入 Prompt（L3 静态层）');
}

/** skip：跳过 onboarding（不再自动扫描）。 */
export function onboardingSkipCommand(): void {
  skipOnboarding(process.cwd());
  console.log('✔ 已跳过 onboarding（新项目首次注册不再自动扫描；可用 `yzero onboarding run --force` 手动触发）');
}
