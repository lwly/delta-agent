/**
 * CLI 侧 Prompt 组装助手：把 M3 提示词体系接入 yzero 主流程。
 * - 真实 7 层组装（替换 M1 占位 prompt）：静态段缓存复用 + 动态段每轮刷新
 * - Skill 三层发现 + 两阶段加载 runtime（load_skill/unload_skill 工具依赖）
 * - --debug-prompt 调试报告
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SplitPromptAssembler,
  PromptBuilder,
  SkillBuffer,
  discoverSkills,
  buildDebugReport,
  formatDebugReport,
  type SkillMeta,
  type SkillRuntime,
  type AssembleContext,
} from '@y-zero/core';

export interface AssemblePromptOptions {
  projectRoot: string;
  model: string;
  contextWindow: number;
  /** L4 工具清单（registry.definitions()） */
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
}

export interface PromptAssembly {
  /** 静态/动态分段（RunContext.systemPromptParts） */
  parts: { staticText: string; dynamicText: string };
  /** Skill runtime（ToolContext.skills） */
  skills: SkillRuntime;
  /** 已发现的 Skills（含内置 + 项目 + 用户层） */
  skillsMeta: SkillMeta[];
  /** 每轮动态段刷新（dynamicProvider） */
  refreshDynamic: () => string;
  /** --debug-prompt 报告 */
  debugReport: () => string;
}

export async function assemblePrompt(opts: AssemblePromptOptions): Promise<PromptAssembly> {
  const assembler = new SplitPromptAssembler();
  const buffer = new SkillBuffer();

  // ── Skill 三层发现：内置 < ~/.y-zero/skills < .y-zero/skills ──
  const { skills: skillsMeta } = await discoverSkills({
    projectRoot: opts.projectRoot,
    homeDir: os.homedir(),
  });

  // ── 项目指令：README 摘要 + .y-zero/agent.md / MEMORY.md 静态记忆 ──
  const [projectInstructions, staticMemory] = await Promise.all([
    readHead(path.join(opts.projectRoot, 'README.md'), 2_000),
    readAll([
      path.join(opts.projectRoot, '.y-zero', 'agent.md'),
      path.join(opts.projectRoot, 'MEMORY.md'),
    ]),
  ]);

  const ctx = (): AssembleContext => ({
    projectName: path.basename(opts.projectRoot),
    projectInstructions,
    staticMemory,
    tools: opts.tools.map((t) => ({ name: t.name, description: t.description, schema: t.parameters })),
    skillIndex: skillsMeta.map((s) => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers,
    })),
    loadedSkills: buffer.list().map((s) => ({ name: s.name, content: s.content })),
    session: {
      cwd: opts.projectRoot,
      now: new Date(),
      model: opts.model,
      contextWindow: opts.contextWindow,
    },
  });

  const assembled = assembler.assemble(ctx());
  const final = new PromptBuilder().build(assembled);

  return {
    parts: { staticText: final.staticText, dynamicText: final.dynamicText },
    skillsMeta,
    skills: {
      async load(name: string) {
        const skill = skillsMeta.find((s) => s.name === name);
        if (!skill) return { ok: false, content: `未找到 Skill：${name}。可用：${skillsMeta.map((s) => s.name).join(', ') || '（无）'}` };
        const entry = buffer.load(skill);
        return { ok: true, content: `Skill ${name} 已加载（下一轮生效）。\n\n${entry.content}` };
      },
      unload(name: string) {
        return buffer.unload(name)
          ? { ok: true, content: `Skill ${name} 已卸载（下一轮生效）。` }
          : { ok: false, content: `未加载 Skill：${name}` };
      },
    },
    refreshDynamic: () => assembler.assemble(ctx()).dynamic.text,
    debugReport: () => {
      const s = assembler.assemble(ctx());
      return formatDebugReport(buildDebugReport({ split: s, final: new PromptBuilder().build(s) }));
    },  };
}

/** 读文件头部（不存在返回空串） */
async function readHead(file: string, maxChars: number): Promise<string> {
  try {
    const text = await fs.readFile(file, 'utf-8');
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n（README 已截断）` : text;
  } catch {
    return '';
  }
}

/** 依次拼接存在的文件内容（段标题 = 文件名） */
async function readAll(files: string[]): Promise<string> {
  const parts: string[] = [];
  for (const file of files) {
    try {
      const text = await fs.readFile(file, 'utf-8');
      if (text.trim()) parts.push(`### ${path.basename(file)}\n\n${text.trim()}`);
    } catch {
      // 不存在 → 跳过
    }
  }
  return parts.join('\n\n');
}
