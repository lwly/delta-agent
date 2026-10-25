/**
 * CLI 侧 Prompt 组装助手：把 M3 提示词体系接入 delta 主流程。
 * - 真实 7 层组装（替换 M1 占位 prompt）：静态段缓存复用 + 动态段每轮刷新
 * - Skill 三层发现 + 两阶段加载 runtime（load_skill/unload_skill 工具依赖）
 * - --debug-prompt 调试报告
 * - F-37（D6）：projectRoot 支持 string | (() => string) getter——TUI 传 getter
 *   使动态段 CWD 每轮跟随当前工作根；静态段（README/agent.md）经 rebuild() 在
 *   切换后重读一次。headless/evals 传 string 走旧路径，不受影响。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  FILES,
  projectConfigDir,
  SplitPromptAssembler,
  PromptBuilder,
  SkillBuffer,
  discoverSkills,
  suggestSkill,
  buildDebugReport,
  formatDebugReport,
  type SkillMeta,
  type SkillRuntime,
  type AssembleContext,
} from '@delta/core';

export interface AssemblePromptOptions {
  /** 项目根；传函数 = 每次组装时动态解析当前工作根（F-37 TUI 用法） */
  projectRoot: string | (() => string);
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
  /** 每轮动态段刷新（dynamicProvider；CWD 取 getRoot() 实时值） */
  refreshDynamic: () => string;
  /** F-37：切换工作根后重读项目指令并重组装静态/动态两段（D6，一次性成本） */
  rebuild: () => Promise<void>;
  /** --debug-prompt 报告 */
  debugReport: () => string;
}

export async function assemblePrompt(opts: AssemblePromptOptions): Promise<PromptAssembly> {
  const assembler = new SplitPromptAssembler();
  const buffer = new SkillBuffer();
  // F-37（D6）：工作根 getter——string 走旧路径（headless/evals 不受影响）
  const getRoot = (): string =>
    typeof opts.projectRoot === 'function' ? opts.projectRoot() : opts.projectRoot;

  // ── Skill 三层发现：内置 < ~/.delta/skills < .delta/skills ──
  // （Skill 层级与工作根解耦：用户层固定 home，项目层以启动根为准，切换不重扫）
  const { skills: skillsMeta } = await discoverSkills({
    projectRoot: getRoot(),
    homeDir: os.homedir(),
  });

  // ── 项目指令：README 摘要 + .delta/agent.md / MEMORY.md 静态记忆 ──
  const loadInstructions = async (): Promise<{ readme: string; memory: string }> => {
    const root = getRoot();
    const [projectInstructions, staticMemory] = await Promise.all([
      readHead(path.join(root, 'README.md'), 2_000),
      readAll([
        path.join(projectConfigDir(root), FILES.agentMd),
        path.join(root, 'MEMORY.md'),
      ]),
    ]);
    return { readme: projectInstructions, memory: staticMemory };
  };
  let instructions = await loadInstructions();

  const ctx = (): AssembleContext => ({
    projectName: path.basename(getRoot()),
    projectInstructions: instructions.readme,
    staticMemory: instructions.memory,
    tools: opts.tools.map((t) => ({ name: t.name, description: t.description, schema: t.parameters })),
    skillIndex: skillsMeta.map((s) => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers,
    })),
    loadedSkills: buffer.list().map((s) => ({ name: s.name, content: s.content })),
    session: {
      // L7 SessionLayer（运行环境）CWD：每轮取 getRoot() 实时值（D6 动态段自动跟随）
      cwd: getRoot(),
      now: new Date(),
      model: opts.model,
      contextWindow: opts.contextWindow,
    },
  });

  const assembled = assembler.assemble(ctx());
  const final = new PromptBuilder().build(assembled);
  // parts 对象引用被 App 持有：rebuild() 原地更新字段即可让下一轮生效
  const parts = { staticText: final.staticText, dynamicText: final.dynamicText };

  return {
    parts,
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
      async suggest(query: string) {
        const top = suggestSkill(skillsMeta, query);
        return top ? { name: top.skill.name, description: top.skill.description } : undefined;
      },
    },
    refreshDynamic: () => assembler.assemble(ctx()).dynamic.text,
    rebuild: async () => {
      instructions = await loadInstructions(); // 重读 README / agent.md / MEMORY.md
      const a = assembler.assemble(ctx());
      const f = new PromptBuilder().build(a);
      parts.staticText = f.staticText;
      parts.dynamicText = f.dynamicText;
    },
    debugReport: () => {
      const s = assembler.assemble(ctx());
      return formatDebugReport(buildDebugReport({ split: s, final: new PromptBuilder().build(s) }));
    },
  };
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
