/**
 * F-55 外部 Agent 展示层（docs/design-f55-external-cli-agents.md §10）：
 * `delta models list` 尾部「外部 Agent」区块与 `delta doctor` 外部检查节共用的纯渲染辅助。
 *
 * 红线（§16）：只展示与探测，不安装、不代用户接受任何许可条款；
 * 登录态只 existsSync（不解析内容、不复制、不上报）。
 */
import { checkLoginState } from '@delta/core';
import type { DetectedAgent, KnownAgentDef } from '@delta/core';

/** plan 档支持标记（§10）：permissionArgs.plan 非空 = 上游有只读档 flags → ✓ */
export function planMark(def: KnownAgentDef): '✓' | '✗' {
  return def.permissionArgs.plan.length > 0 ? '✓' : '✗';
}

/**
 * models list 外部区块行（含区块标题）。
 * 探测由命令入口先调 ensureExternalAdapters() 完成——注意探测会把结果落
 * ~/.delta/external.json（设计稿 §10：探测结果落盘，只读展示的可接受副作用），只探测不安装。
 */
export function externalAgentBlockLines(detected: DetectedAgent[], homeDir?: string): string[] {
  const lines = ['外部 Agent：'];
  if (detected.length === 0) {
    lines.push('（未探测到外部 Agent——delta 只探测不安装）');
    return lines;
  }
  for (const d of detected) {
    const login = checkLoginState(d.def, homeDir) ? '✓' : '✗';
    lines.push(
      `  ${d.def.id}  ${d.def.executable}  ${d.version}  Tier ${d.def.tier}` +
        `  [${d.source}]  登录态: ${login}  plan 档: ${planMark(d.def)}`,
    );
  }
  return lines;
}
