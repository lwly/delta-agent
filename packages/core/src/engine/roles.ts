/**
 * 角色模板（agent-modes-design §4.1）
 * 角色不是独立进程，而是「系统提示词模板 + 工具白名单」组合：
 * 同一 Worker Pool 按节点 role 字段实例化不同上下文。
 */
import type { ToolCall, ToolDefinition, ToolResult } from '@delta/shared';
import type { TaskRole } from '@delta/shared';
import type { ToolContext } from '../tools/types.js';

export interface RoleTemplate {
  /** 角色系统提示词段（与任务上下文拼接后作为子任务 system prompt） */
  system: string;
  /** 工具白名单（空 = 不限） */
  tools: string[];
}

const READ_TOOLS = ['read_file', 'list_dir', 'glob_search', 'grep_search'];

/** 质量层角色（不进执行队列，但模板复用同一体系） */
export type AnyRole = TaskRole | 'reviewer' | 'verifier';

export const ROLE_TEMPLATES: Record<AnyRole, RoleTemplate> = {
  worker: {
    system: `你是执行者（Worker）。专注完成分配给你的子任务：读代码、写代码、修改文件。
完成后用一段简洁文字汇报：做了什么、改了哪些文件、遗留风险。不要扩大任务范围。`,
    tools: [...READ_TOOLS, 'write_file', 'edit_file', 'run_command'],
  },
  researcher: {
    system: `你是研究员（Researcher）。负责信息检索、数据采集与事实核验，尽量多读少写。
输出结构化调研结论（要点 + 出处文件/URL），不做代码修改。`,
    tools: [...READ_TOOLS, 'web_fetch'],
  },
  writer: {
    system: `你是创作者（Writer）。负责文档、文案与设计类产出，语言精炼、结构清晰。
修改前先读取相关文件，保持与项目现有风格一致。`,
    tools: [...READ_TOOLS, 'write_file', 'edit_file'],
  },
  'tool-caller': {
    system: `你是工具调用者（Tool Caller）。负责运行命令、执行测试等高危操作，逐步执行并核对输出。
命令失败时分析原因再重试，不做无关变更。`,
    tools: [...READ_TOOLS, 'run_command', 'run_tests'],
  },
  reviewer: {
    system: `你是评审者（Reviewer）。审查各节点产出的质量：正确性、完整性、与目标的偏差。
只输出裁决 JSON，不执行修改。`,
    tools: [...READ_TOOLS],
  },
  verifier: {
    system: `你是验证者（Verifier）。运行测试/构建等客观校验，用事实说话。
输出：执行的校验、结果、失败项清单。`,
    tools: [...READ_TOOLS, 'run_command', 'run_tests'],
  },
};

/** 运行时角色上下文（总目标 + 节点目标 + 上游结果摘要）。 */
export function roleSystemPrompt(role: TaskRole, ctx: { planGoal: string; nodeGoal: string; upstream: string }): string {
  const t = ROLE_TEMPLATES[role] ?? ROLE_TEMPLATES.worker;
  return [
    t.system,
    '',
    `## 总目标\n${ctx.planGoal}`,
    `## 本节点目标\n${ctx.nodeGoal}`,
    ctx.upstream ? `## 上游结果摘要\n${ctx.upstream}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Structural subset of ToolRegistry the engines rely on. */
export interface RegistryLike {
  definitions(): ToolDefinition[];
  executeAll(calls: ToolCall[], ctx: ToolContext): Promise<ToolResult[]>;
}

/** 白名单受限视图：definitions 过滤，越权调用直接拒绝（不进确认流）。 */
export class RestrictedRegistry implements RegistryLike {
  constructor(
    private readonly base: RegistryLike,
    private readonly allow: Set<string>,
  ) {}

  definitions(): ToolDefinition[] {
    return this.base.definitions().filter((d) => this.allow.has(d.name));
  }

  async executeAll(calls: ToolCall[], ctx: ToolContext): Promise<ToolResult[]> {
    return Promise.all(
      calls.map(async (call) => {
        if (!this.allow.has(call.name)) {
          return {
            callId: call.id,
            name: call.name,
            ok: false,
            content: `tool ${call.name} is not allowed for this role (allowed: ${[...this.allow].join(', ')})`,
            error: 'tool_not_allowed',
          } satisfies ToolResult;
        }
        return (await this.base.executeAll([call], ctx))[0]!;
      }),
    );
  }
}
