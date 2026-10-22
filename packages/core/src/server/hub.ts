/**
 * SessionHub：会话运行桥（technical-design §10 关键时序）
 * - send(sessionId, input)：组装 RunContext → runReAct → 事件扇出（SSE 订阅者）+ 落库
 * - 确认/提问流：confirm_request / ask 事件 + waiter，由 HTTP 端点回填决策
 * - 运行中会话注册表复用 SessionService（删除前中止语义一致）
 */
import type {
  AgentEvent,
  ChatMessage,
  ConfirmDecision,
  ConfirmRequest,
  LLMProvider,
  ToolCall,
} from '@y-zero/shared';
import {
  BudgetManager,
  PromptBuilder,
  SessionService,
  SkillBuffer,
  SplitPromptAssembler,
  ToolRegistry,
  discoverSkills,
  type SkillRuntime,
} from '../index.js';
import { runReAct, type RunContext } from '../engine/react.js';
import * as path from 'node:path';
import * as os from 'node:os';

/** 推送给 Web 的事件：AgentEvent + 桥接控制事件 */
export type HubEvent =
  | AgentEvent
  | { type: 'confirm_request'; request: ConfirmRequest }
  | { type: 'ask_user'; requestId: string; question: string; options?: string[] }
  | { type: 'run_error'; message: string }
  | { type: 'state'; running: boolean };

export interface SessionHubDeps {
  service: SessionService;
  registry: ToolRegistry;
  /** 每次运行解析 Provider（配置可能被 Web 设置页修改） */
  resolveProvider: () => Promise<LLMProvider>;
  /** 默认模型（会话未指定时） */
  defaultModel?: string;
  /** 上下文窗口（默认 200k） */
  windowTokens?: number;
  maxTurns?: number;
  /** Skill 两阶段加载 runtime（注入每次运行的 ToolContext.skills） */
  skills?: SkillRuntime;
}

interface PendingConfirm {
  kind: 'confirm';
  resolve: (d: ConfirmDecision) => void;
}
interface PendingAsk {
  kind: 'ask';
  resolve: (answer: string) => void;
}

export class SessionHub {
  private readonly subs = new Map<string, Set<(ev: HubEvent) => void>>();
  private readonly waiters = new Map<string, PendingConfirm | PendingAsk>();
  private running = new Set<string>();

  constructor(private readonly deps: SessionHubDeps) {}

  // ── 订阅（SSE）──────────────────────────────────────────────────────────

  subscribe(sessionId: string, fn: (ev: HubEvent) => void): () => void {
    let set = this.subs.get(sessionId);
    if (!set) {
      set = new Set();
      this.subs.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.subs.delete(sessionId);
    };
  }

  isRunning(sessionId: string): boolean {
    return this.running.has(sessionId);
  }

  private publish(sessionId: string, ev: HubEvent): void {
    for (const fn of this.subs.get(sessionId) ?? []) {
      try {
        fn(ev);
      } catch {
        // 订阅者异常不影响其他订阅者
      }
    }
  }

  // ── 确认 / 提问回填 ─────────────────────────────────────────────────────

  /** HTTP 端点回填确认决策（allow / reject / edit）。 */
  confirm(requestId: string, decision: ConfirmDecision): boolean {
    const w = this.waiters.get(requestId);
    if (!w || w.kind !== 'confirm') return false;
    this.waiters.delete(requestId);
    w.resolve(decision);
    return true;
  }

  /** HTTP 端点回填 ask_user 的文本回答。 */
  answer(requestId: string, answer: string): boolean {
    const w = this.waiters.get(requestId);
    if (!w || w.kind !== 'ask') return false;
    this.waiters.delete(requestId);
    w.resolve(answer);
    return true;
  }

  // ── 运行 ────────────────────────────────────────────────────────────────

  abort(sessionId: string): boolean {
    return this.deps.service.abortRun(sessionId);
  }

  /** 发起一轮对话：阻塞到引擎结束（事件经 publish 实时推送）。 */
  async send(sessionId: string, input: string): Promise<void> {
    if (this.running.has(sessionId)) {
      throw new Error('session is already running');
    }
    const session = this.deps.service.getSession(sessionId);
    if (!session) throw new Error('session not found');
    const project = this.deps.service.getProject(session.project_id);
    if (!project) throw new Error('project not found');

    this.running.add(sessionId);
    this.publish(sessionId, { type: 'state', running: true });

    const service = this.deps.service;
    let assistantText = '';
    const collectedCalls: ToolCall[] = [];
    let assistantSaved = false;
    const saveAssistantWithCalls = () => {
      if (assistantSaved) return;
      service.appendMessage(sessionId, {
        role: 'assistant',
        content: assistantText,
        toolCalls: [...collectedCalls],
      });
      assistantSaved = true;
    };

    try {
      const provider = await this.deps.resolveProvider();
      const ac = new AbortController();
      service.registerRun(sessionId, ac);

      const budget = new BudgetManager();
      const { staticText, dynamicText } = await this.buildPrompt(project.root_path, session.model || this.deps.defaultModel || 'claude-sonnet-4-5-20250929', this.deps.registry.definitions());
      const askId = `ask_${sessionId}_${Date.now()}`;

      const ctx: RunContext = {
        sessionId,
        projectId: session.project_id,
        mode: 'react',
        model: session.model || this.deps.defaultModel || 'claude-sonnet-4-5-20250929',
        systemPrompt: staticText,
        systemPromptParts: { staticText, dynamicText },
        maxTurns: this.deps.maxTurns ?? 50,
        signal: ac.signal,
        provider,
        registry: this.deps.registry,
        toolContext: {
          projectRoot: project.root_path,
          signal: ac.signal,
          confirm: async (req: ConfirmRequest) => {
            this.publish(sessionId, { type: 'confirm_request', request: req });
            return new Promise<ConfirmDecision>((resolve) => {
              this.waiters.set(req.id, { kind: 'confirm', resolve });
            });
          },
          askUser: async (question: string, options?: string[]) => {
            this.publish(sessionId, { type: 'ask_user', requestId: askId, question, options });
            return new Promise<string>((resolve) => {
              this.waiters.set(askId, { kind: 'ask', resolve });
            });
          },
          todos: [],
          skills: this.deps.skills,
        },
        budget,
        windowTokens: this.deps.windowTokens ?? 200_000,
      };

      service.appendMessage(sessionId, { role: 'user', content: input });
      const history: ChatMessage[] = service.getHistory(sessionId);

      for await (const ev of runReAct(ctx, history.slice(0, -1), input)) {
        this.publish(sessionId, ev);
        switch (ev.type) {
          case 'text_delta':
            assistantText += ev.text;
            break;
          case 'thinking_delta':
            break;
          case 'tool_call_start':
            saveAssistantWithCalls();
            collectedCalls.push(ev.call);
            assistantSaved = false;
            break;
          case 'tool_result': {
            // 工具结果落库（与 CLI App 落库策略一致）
            service.appendMessage(sessionId, {
              role: 'tool',
              content: ev.result.content,
              toolCallId: ev.result.callId,
            });
            break;
          }
          case 'done': {
            if (!assistantSaved && assistantText) {
              service.appendMessage(sessionId, { role: 'assistant', content: assistantText });
            }
            assistantSaved = true;
            service.recordUsage(sessionId, 0, ev.usage.inputTokens, ev.usage.outputTokens, ev.usage.costUsd ?? 0);
            break;
          }
          case 'compact_done':
            service.recordCompaction(sessionId, ev.beforeTokens, ev.afterTokens, '');
            break;
          default:
            break;
        }
      }
    } catch (e) {
      this.publish(sessionId, { type: 'run_error', message: (e as Error).message });
      if (assistantText && !assistantSaved) {
        this.deps.service.appendMessage(sessionId, { role: 'assistant', content: assistantText });
      }
    } finally {
      this.running.delete(sessionId);
      this.deps.service.unregisterRun(sessionId);
      this.publish(sessionId, { type: 'state', running: false });
    }
  }

  /** 组装静态/动态分段提示词（与 CLI 同源：7 层 + Skill 索引）。 */
  private async buildPrompt(
    projectRoot: string,
    model: string,
    tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
  ): Promise<{ staticText: string; dynamicText: string }> {
    const { promises: fs } = await import('node:fs');
    const assembler = new SplitPromptAssembler();

    const read = async (file: string, max: number): Promise<string> => {
      try {
        const t = await fs.readFile(file, 'utf-8');
        return t.length > max ? `${t.slice(0, max)}\n（已截断）` : t;
      } catch {
        return '';
      }
    };
    const [readme, staticMemory] = await Promise.all([
      read(path.join(projectRoot, 'README.md'), 2_000),
      read(path.join(projectRoot, '.y-zero', 'agent.md'), 4_000),
    ]);

    const { skills } = await discoverSkills({ projectRoot, homeDir: os.homedir() });
    const ctx = {
      projectName: path.basename(projectRoot),
      projectInstructions: readme,
      staticMemory,
      tools: tools.map((t) => ({ name: t.name, description: t.description, schema: t.parameters })),
      skillIndex: skills.map((s) => ({ name: s.name, description: s.description, triggers: s.triggers })),
      session: {
        cwd: projectRoot,
        now: new Date(),
        model,
        contextWindow: this.deps.windowTokens ?? 200_000,
      },
    };
    const split = assembler.assemble(ctx);
    const final = new PromptBuilder().build(split);
    return { staticText: final.staticText, dynamicText: final.dynamicText };
  }
}

/** 便捷构造 SkillRuntime（load/unload 供 HTTP 层装配进 ToolContext.skills） */
export async function createSkillRuntime(projectRoot: string): Promise<SkillRuntime> {
  const buffer = new SkillBuffer();
  const { skills } = await discoverSkills({ projectRoot, homeDir: os.homedir() });
  return {
    async load(name: string) {
      const skill = skills.find((s) => s.name === name);
      if (!skill) return { ok: false, content: `未找到 Skill：${name}` };
      const entry = buffer.load(skill);
      return { ok: true, content: `Skill ${name} 已加载（下一轮生效）。\n\n${entry.content}` };
    },
    unload(name: string) {
      return buffer.unload(name)
        ? { ok: true, content: `Skill ${name} 已卸载。` }
        : { ok: false, content: `未加载 Skill：${name}` };
    },
  };
}
