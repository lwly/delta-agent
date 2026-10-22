/**
 * 模式提示词（prompt-design §5）
 * 模式段始终位于 Prompt 末尾：切换模式只替换最后一小段，静态缓存前缀完全不动。
 */
import type { PlanOptions } from './react.js';

export type EngineMode = 'react' | 'plan-execute' | 'multi-agent';

export function modeSegment(mode: EngineMode, opts?: PlanOptions): string {
  switch (mode) {
    case 'plan-execute':
      return [
        '## 执行模式：Plan-and-Execute',
        '- 简单任务直接执行；复杂任务先产出 DAG 计划（节点可独立执行、依赖构成无环图），再按拓扑层并行执行',
        '- 每个节点独立上下文，完成后汇报做了什么、改了哪些文件、遗留风险',
        '- 汇报节点状态与汇总结论',
        opts?.force === 'plan' ? '- 用户已强制要求先规划（/plan）' : '',
      ]
        .filter(Boolean)
        .join('\n');
    case 'multi-agent':
      return [
        '## 执行模式：Multi-Agent 协作',
        '- 角色：规划者（Planner）产出 DAG 任务图；执行者工作池（默认 4 worker，可配 1-8）竞争领取子任务；评审者（Reviewer）负责主观质量，验证者（Verifier）负责客观测试构建',
        '- 子任务在隔离上下文中执行：只注入总目标、本节点目标与上游结果摘要，避免互相污染',
        '- 审查不通过时携带失败原因打回：失败节点重新入队或按反馈调整目标；重试有上限，超限如实汇报遗留问题',
        '- 结果按节点回传：做了什么、改了哪些文件、遗留风险',
      ].join('\n');
    case 'react':
    default:
      return ['## 执行模式：ReAct', '- 单步循环决策：思考 → 行动（工具优先）→ 观察结果 → 再决策，直至任务完成'].join('\n');
  }
}
