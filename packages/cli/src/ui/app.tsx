import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type {
  AgentEvent,
  ChatMessage,
  ConfirmDecision,
  ConfirmRequest,
  ToolCall,
} from '@y-zero/shared';
import {
  BudgetManager,
  GitIntegration,
  PermissionState,
  SessionService,
  ToolRegistry,
  compactDiff,
  diffLines,
  formatSearchHits,
  prepareImages,
  describeImage,
  ImageError,
  renderSummary,
  runReAct,
  runPlanExecute,
  runMultiAgent,
  modeSegment,
  type DiffLine,
  type EngineMode,
  type GitPolicyMode,
  type PermissionMode,
  type PreparedImage,
  type RunContext,
  type SessionRow,
  type SkillRuntime,
} from '@y-zero/core';
import { ConfirmCard } from './confirm.js';
import { theme, icons } from './theme.js';
import { DiffView } from './diff-view.js';

interface Item {
  id: number;
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'confirm' | 'thinking';
  text: string;
  pending?: boolean;
  /** F-36 工具结果成败（tool 着色用，替代脆弱的前缀判断） */
  ok?: boolean;
  /** F-36 edit/write 工具结果的行级 diff（彩色渲染） */
  diff?: DiffLine[];
  request?: ConfirmRequest;
  resolve?: (d: ConfirmDecision) => void;
}

/** F-36 运行状态行 spinner 的盲文字符帧（80ms/帧） */
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** F-36 运行状态行动画帧（active 时启动 interval，停止即静止）。 */
function useSpinnerFrame(active: boolean): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [active]);
  return SPINNER_FRAMES[frame]!;
}

export interface AppOptions {
  service: SessionService;
  session: SessionRow;
  provider: Awaited<ReturnType<typeof import('@y-zero/core').resolveProviderFromEnv>>;
  /** pre-built registry (with MCP tools attached by the CLI entry) */
  registry?: ToolRegistry;
  systemPrompt: string;
  /** M3：静态/动态分段系统提示词（优先于 systemPrompt） */
  systemPromptParts?: { staticText: string; dynamicText: string };
  /** M3：每轮动态段刷新（时间戳等随轮次更新，静态缓存前缀不动） */
  refreshDynamic?: () => string;
  /** M3：Skill 两阶段加载 runtime（load_skill/unload_skill 工具） */
  skillsRuntime?: SkillRuntime;
  /** F-27 Hook 系统（SessionStart/Stop/SessionEnd 生命周期 + 工具挂钩） */
  hooks?: import('@y-zero/core').HookManager;
  /** F-33 桌面通知器（缺省不通知；任务结束 / 确认卡出现时旁路触发） */
  notify?: import('@y-zero/core').Notifier;
  yolo: boolean;
  /** F-23 权限模式（plan/default/yolo；yolo 需与 yolo 标志双重开启，由 CLI 入口保证） */
  permissionMode?: PermissionMode;
  /** F-23 工具级 allowlist（default 模式下命中跳过确认） */
  allowTools?: string[];
  /** F-24 git 策略（off/suggest/auto，默认 suggest） */
  gitPolicy?: GitPolicyMode;
  debugPrompt: boolean;
  maxTurns: number;
  /** M5: 执行模式（react / plan-execute / multi-agent），默认 react */
  engineMode?: EngineMode;
}

let nextId = 1;

/** 头部权限模式标签。 */
function permissionLabel(mode: PermissionMode): string {
  if (mode === 'plan') return ' · PLAN（只读）';
  if (mode === 'yolo') return ' · YOLO';
  return '';
}

export function App(props: AppOptions) {
  const { exit } = useApp();
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [usage, setUsage] = useState({ input: 0, output: 0, cost: 0 });
  // F-36 状态行：当前轮次（turn_start 更新）
  const [turn, setTurn] = useState(0);
  const spinnerFrame = useSpinnerFrame(running);
  const abortRef = useRef<AbortController | null>(null);
  const registryRef = useRef<ToolRegistry>(props.registry ?? new ToolRegistry());
  const todosRef = useRef<Array<{ content: string; status: 'pending' | 'in_progress' | 'done' }>>([]);
  const budgetRef = useRef<BudgetManager>(new BudgetManager());
  // F-23 权限模式（会话内固定；yolo 需 CLI 双重开启，再次防御）。
  // PermissionState 持有 allow_session 记忆，整个会话复用同一实例。
  const permsRef = useRef<PermissionState | null>(null);
  if (!permsRef.current) {
    const mode: PermissionMode =
      props.permissionMode === 'yolo' && props.yolo
        ? 'yolo'
        : props.permissionMode === 'plan'
          ? 'plan'
          : 'default';
    permsRef.current = new PermissionState({ mode, allowlist: props.allowTools });
  }
  // F-24 git 集成（会话级复用同一实例）
  const gitRef = useRef<GitIntegration | null>(null);
  if (!gitRef.current) {
    gitRef.current = new GitIntegration(process.cwd(), { mode: props.gitPolicy ?? 'suggest' });
  }
  // F-25 多模态：/image 附件暂存区（随下一条消息发送后清空）
  const pendingImagesRef = useRef<PreparedImage[]>([]);

  const addItem = useCallback((item: Omit<Item, 'id'>) => {
    const withId: Item = { ...item, id: nextId++ };
    setItems((prev) => [...prev, withId]);
    return withId;
  }, []);

  const updateItem = useCallback((id: number, patch: Partial<Item>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const appendToItem = useCallback((id: number, extra: string) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, text: it.text + extra } : it)));
  }, []);

  // ── confirm flow ────────────────────────────────────────────────────────
  // F-23：放行策略收敛到 PermissionState（registry 闸口），yolo 模式下
  // check() 直接 allow，不会走到这里；此处只负责交互式确认卡。
  const confirm = useCallback(
    async (req: ConfirmRequest): Promise<ConfirmDecision> => {
      // F-33 桌面通知：确认卡出现（等人事件；旁路 fire-and-forget，失败不影响确认流）
      try {
        props.notify?.notifyConfirm({ tool: req.tool, reason: req.reason });
      } catch {
        // 通知失败不影响确认流
      }
      return new Promise<ConfirmDecision>((resolve) => {
        addItem({ kind: 'confirm', text: '', request: req, resolve });
      });
    },
    [addItem],
  );

  const askUser = useCallback(
    async (question: string, options?: string[]): Promise<string> => {
      // M1: surfaced as a system prompt in the input line; user types the answer.
      addItem({
        kind: 'system',
        text: `❓ Agent 提问：${question}${options ? `（选项：${options.join(' / ')}）` : ''} —— 请直接在输入框回答`,
      });
      return new Promise<string>((resolve) => {
        pendingAskRef.current = resolve;
      });
    },
    [addItem],
  );
  const pendingAskRef = useRef<((answer: string) => void) | null>(null);

  // ── engine run ──────────────────────────────────────────────────────────
  const run = useCallback(
    async (userInput: string) => {
      const ac = new AbortController();
      abortRef.current = ac;
      setRunning(true);
      const startedAt = Date.now(); // F-33：任务时长门槛判定基准
      let runError: string | null = null;

      // M3：Skill 自动触发——Top-1 评分 ≥ 阈值时询问用户是否加载
      if (props.skillsRuntime?.suggest) {
        try {
          const suggestion = await props.skillsRuntime.suggest(userInput);
          if (suggestion) {
            const answer = await askUser(
              `检测到可用技能「${suggestion.name}」（${suggestion.description}），是否加载？`,
              ['是', '否'],
            );
            const affirm = /^(是|y|yes|好|加载|ok)$/i.test(answer.trim());
            addItem({
              kind: 'system',
              text: affirm
                ? `✔ 已加载技能 ${suggestion.name}（下一轮生效）`
                : `已跳过技能 ${suggestion.name}`,
            });
            if (affirm) await props.skillsRuntime.load(suggestion.name);
          }
        } catch {
          // 自动触发失败不打扰主流程
        }
      }

      // 记忆里程碑：本轮输入的 L2 记忆召回块
      const memoryScopes = ['global', `project:${props.session.project_id}`, `session:${props.session.id}`];
      const memoryBlock = renderMemoryRecallBlock(props.service.memory, userInput, memoryScopes);

      // build run context
      const engineMode: EngineMode = props.engineMode ?? 'react';
      const ctx: RunContext = {
        sessionId: props.session.id,
        projectId: props.session.project_id,
        mode: engineMode,
        model: props.session.model || 'claude-sonnet-4-5-20250929',
        systemPrompt: props.systemPrompt,
        systemPromptParts: {
          staticText: props.systemPromptParts?.staticText ?? props.systemPrompt,
          // M5 模式段 + 记忆召回块最后追加（prompt-design §5），切换模式不动缓存前缀
          dynamicText: [
            props.systemPromptParts?.dynamicText ?? '',
            memoryBlock,
            modeSegment(engineMode),
          ]
            .filter((t) => t.length > 0)
            .join('\n\n'),
        },
        dynamicProvider: props.refreshDynamic,
        maxTurns: props.maxTurns,
        signal: ac.signal,
        provider: props.provider,
        registry: registryRef.current,
        toolContext: {
          projectRoot: process.cwd(),
          signal: ac.signal,
          sessionId: props.session.id,
          projectId: props.session.project_id,
          memory: props.service.memory,
          changes: props.service.changes,
          confirm,
          askUser,
          todos: todosRef.current,
          skills: props.skillsRuntime,
          permissions: permsRef.current ?? undefined,
          // F-26 子代理即工具：注入父注册表与子代理运行时（只读隔离，用量回写会话预算）
          registry: registryRef.current,
          subagent: {
            provider: props.provider,
            model: props.session.model || 'claude-sonnet-4-5-20250929',
            budget: budgetRef.current,
            budgetConfig: budgetRef.current.config,
            windowTokens: 200_000,
            depth: 0,
          },
          // F-27 Hook 系统：PreToolUse（可阻断）/ PostToolUse（记录）
          hooks: props.hooks,
        },
        budget: budgetRef.current,
        windowTokens: 200_000,
        tasks: props.service.tasks,
        // F-14 计划确认流：CLI 简化为批准/跳过（节点编辑引导去 Web 控制台）
        planApproval:
          engineMode === 'plan-execute'
            ? async (req) => {
                const lines = req.plan.nodes
                  .map((n) => `  ${n.id}${n.deps.length ? ` ←(${n.deps.join(',')})` : ''} ${n.goal}`)
                  .join('\n');
                const answer = await askUser(
                  `📋 规划完成（${req.plan.nodes.length} 节点）：\n${lines}\n\n执行该计划？(y=执行 / n=跳过计划直接执行；编辑节点请到 Web 控制台)`,
                  ['y', 'n'],
                );
                return /^(y|yes|是|好|ok|执行)/i.test(answer.trim()) ? { kind: 'approve' } : { kind: 'reject' };
              }
            : undefined,
      };

      const history: ChatMessage[] = props.service.getHistory(props.session.id);
      // F-25：附件随下一条消息发送（发送后清空暂存区）
      const images = pendingImagesRef.current;
      pendingImagesRef.current = [];
      const userMessage: ChatMessage = { role: 'user', content: userInput };
      if (images.length > 0) userMessage.images = images;
      props.service.appendMessage(props.session.id, userMessage);
      for (const img of images) {
        addItem({ kind: 'user', text: `🖼 ${describeImage(img)}` });
      }

      // stream state
      let assistantText = '';
      let assistantItemId: number | null = null;
      let thinkingItemId: number | null = null; // F-36 思考过程流（thinking_delta 渲染，不入库）
      let assistantSaved = false;
      const collectedCalls: ToolCall[] = [];
      let turnCount = 0;

      const saveAssistantWithCalls = () => {
        if (assistantSaved) return;
        props.service.appendMessage(props.session.id, {
          role: 'assistant',
          content: assistantText,
          toolCalls: [...collectedCalls],
        });
        assistantSaved = true;
      };

      try {
        // M5: 按模式分发引擎（ReAct / Plan-and-Execute / Multi-Agent）
        const engine =
          engineMode === 'plan-execute'
            ? runPlanExecute
            : engineMode === 'multi-agent'
              ? runMultiAgent
              : runReAct;
        for await (const ev of engine(ctx, history, userInput, images)) {
          const e = ev as AgentEvent;
          switch (e.type) {
            case 'turn_start':
              turnCount = e.turn;
              setTurn(e.turn); // F-36 状态行轮次
              break;
            case 'text_delta':
              // F-36：思考流被打断（开始正式输出）
              if (thinkingItemId !== null) {
                updateItem(thinkingItemId, { pending: false });
                thinkingItemId = null;
              }
              if (assistantItemId === null) {
                const it = addItem({ kind: 'assistant', text: '', pending: true }); // pending = 流式光标
                assistantItemId = it.id;
              }
              assistantText += e.text;
              appendToItem(assistantItemId, e.text);
              break;
            case 'thinking_delta':
              // F-36：思考过程可见（暗色流式块；不写入会话历史）
              if (thinkingItemId === null) {
                const it = addItem({ kind: 'thinking', text: '', pending: true });
                thinkingItemId = it.id;
              }
              appendToItem(thinkingItemId, e.text);
              break;
            case 'tool_call_start': {
              // F-36：思考流被打断（进入工具执行）
              if (thinkingItemId !== null) {
                updateItem(thinkingItemId, { pending: false });
                thinkingItemId = null;
              }
              collectedCalls.push(e.call);
              const argsStr = JSON.stringify(e.call.args ?? safeParseArgs(e.call.argsJson));
              const shown = argsStr.length > 160 ? argsStr.slice(0, 160) + '…' : argsStr;
              addItem({ kind: 'tool', text: `${icons.tool} ${e.call.name}(${shown})`, pending: true });
              break;
            }
            case 'tool_result': {
              saveAssistantWithCalls();
              // F-36：edit/write 工具结果附行级 diff（取 FileChangeStore 最新快照生成）
              const diff = f36DiffForTool(e.call, props.session.id, props.service);
              // F-30 沙箱徽标（R4）：显式启用沙箱时 100% 带执行环境标识（缺省用户无感知）
              const sb = (e.result.meta as { sandbox?: { mode: string; network?: string; ms?: number; degraded?: boolean } } | undefined)?.sandbox;
              const badge = sb
                ? ` ${icons.sandbox}[${sb.mode}${sb.network ? ` net=${sb.network}` : ''}${sb.ms != null ? ` ${sb.ms}ms` : ''}${sb.degraded ? ' 已降级' : ''}]`
                : '';
              const header = `${icons.tool} ${e.call.name}${badge}`;
              const headerPrefix = `${icons.tool} ${e.call.name}`; // pending 项文本带参数、无徽标，按名前缀匹配
              const resultText = (e.result.ok ? icons.ok : icons.fail) + ' ' + e.result.content.slice(0, 2000);
              setItems((prev) =>
                prev.map((it) =>
                  it.kind === 'tool' && it.pending && it.text.startsWith(headerPrefix)
                    ? { ...it, pending: false, ok: e.result.ok, text: `${header}\n${resultText}`, diff }
                    : it,
                ),
              );
              // F-36：todo 进度可视（todo_write 后立即显示完成度，不必手动 /todos）
              if (e.call.name === 'todo_write' && e.result.ok && todosRef.current.length > 0) {
                const done = todosRef.current.filter((t) => t.status === 'done').length;
                addItem({
                  kind: 'system',
                  text: `${icons.plan} 任务清单 ${done}/${todosRef.current.length} 完成（/todos 查看明细）`,
                });
              }
              props.service.appendMessage(props.session.id, {
                role: 'tool',
                content: e.result.content,
                toolCallId: e.call.id,
              });
              break;
            }
            case 'compact_start':
              addItem({ kind: 'system', text: '🗜 上下文接近窗口上限，开始压缩…' });
              break;
            case 'compact_done':
              addItem({
                kind: 'system',
                text: `🗜 压缩完成：${e.beforeTokens} → ${e.afterTokens} tokens`,
              });
              props.service.recordCompaction(props.session.id, e.beforeTokens, e.afterTokens, '');
              break;
            case 'budget_alert':
              addItem({
                kind: 'system',
                text: `⚠ 预算告警（${(e.level * 100).toFixed(0)}%）：token ${(e.usedTokenPct * 100).toFixed(0)}% / 费用 ${(e.usedCostPct * 100).toFixed(0)}%`,
              });
              break;
            case 'budget_exhausted':
              addItem({ kind: 'system', text: e.summary });
              break;
            // ── M5: Plan DAG / Worker Pool / Reviewer 事件 ──
            case 'plan_created': {
              const lines = e.plan.nodes.map((n) => `  ${n.id} ${n.deps.length ? `←(${n.deps.join(',')})` : ''} ${n.goal}`).join('\n');
              addItem({ kind: 'system', text: `📋 计划（rev ${e.plan.revision}，${e.plan.nodes.length} 节点）：\n${lines}` });
              break;
            }
            case 'plan_updated':
              addItem({ kind: 'system', text: `📋 计划更新（rev ${e.plan.revision}）：${e.reason}` });
              break;
            case 'subtask_start':
              addItem({ kind: 'tool', text: `▶ [${e.workerId}] ${e.nodeId}: ${e.goal}`, pending: true });
              break;
            case 'subtask_done':
              addItem({ kind: 'system', text: `✔ ${e.nodeId} 完成` });
              break;
            case 'subtask_failed':
              addItem({ kind: 'system', text: `✘ ${e.nodeId} 失败（重试 ${e.retries}）：${e.error}` });
              break;
            case 'review_verdict':
              addItem({
                kind: 'system',
                text: e.verdict.pass
                  ? `🔍 质量审查通过（rev ${e.revision}）`
                  : `🔍 质量审查不通过（rev ${e.revision}）：${e.verdict.failures.map((f) => `${f.nodeId} ${f.reason}`).join('; ')}`,
              });
              break;
            case 'usage': {
              setUsage((u) => ({
                input: u.input + e.usage.inputTokens,
                output: u.output + e.usage.outputTokens,
                cost: u.cost + (e.usage.costUsd ?? 0),
              }));
              if (turnCount > 0) {
                props.service.recordUsage(
                  props.session.id,
                  turnCount,
                  e.usage.inputTokens,
                  e.usage.outputTokens,
                  e.usage.costUsd ?? 0,
                  e.model ?? props.session.model,
                );
              }
              break;
            }
            case 'error':
              addItem({ kind: 'system', text: `✘ ${e.fatal ? '致命错误' : '提示'}：${e.message}` });
              break;
            case 'done':
              if (!assistantSaved && assistantText) {
                props.service.appendMessage(props.session.id, { role: 'assistant', content: assistantText });
              }
              // F-24 git auto：任务结束提交本会话记录在案的文件变更
              if (props.gitPolicy === 'auto' && abortRef.current && !abortRef.current.signal.aborted) {
                void gitRef
                  .current!.autoCommitChanges(props.session.id, props.service.changes, userInput)
                  .then((out) => {
                    if (out.ok && out.hash) {
                      addItem({ kind: 'system', text: `⎇ 已自动提交 ${out.hash}（仅本会话变更的文件）` });
                    } else if (out.reason && out.reason !== 'nothing to commit for recorded paths') {
                      addItem({ kind: 'system', text: `⎇ 自动提交跳过：${out.reason}` });
                    }
                  })
                  .catch(() => undefined);
              }
              break;
            default:
              break;
          }
        }
      } catch (err) {
        runError = (err as Error).message;
        addItem({ kind: 'system', text: `✘ 运行异常：${(err as Error).message}` });
      } finally {
        // F-33 桌面通知：任务结束（旁路 fire-and-forget；enabled/onDone/minDurationMs 在 notifier 内判定）
        // 注意要在 assistantText 清空之前取摘要
        try {
          props.notify?.notifyDone({
            status: abortRef.current?.signal.aborted ? 'aborted' : runError ? 'failed' : 'completed',
            durationMs: Date.now() - startedAt,
            summary: runError ?? assistantText,
          });
        } catch {
          // 通知失败不影响运行收尾
        }
        assistantItemId = null;
        thinkingItemId = null;
        assistantText = '';
        assistantSaved = false;
        collectedCalls.length = 0;
        // F-36：收起流式光标与思考流
        setItems((prev) =>
          prev.map((it) => (it.kind === 'assistant' || it.kind === 'thinking') ? { ...it, pending: false } : it),
        );
        setRunning(false);
        abortRef.current = null;
        // F-27 Stop 钩子：单次任务结束（旁路触发）
        void props.hooks?.emit('Stop', {
          sessionId: props.session.id,
          projectId: props.session.project_id,
        });
      }
    },
    [addItem, appendToItem, confirm, askUser, props],
  );

  // ── slash commands ──────────────────────────────────────────────────────
  const handleCommand = useCallback(
    (cmd: string): boolean => {
      const [name, ...rest] = cmd.slice(1).split(/\s+/);
      switch (name) {
        case 'help':
          addItem({
            kind: 'system',
            text: [
              '命令：',
              '  /new     新建会话（当前进程内重置上下文）',
              '  /todos   查看任务清单',
              '  /budget  查看 Token / 费用用量',
              '  /changes 查看会话文件变更汇总（F-24）',
              '  /rollback [id] 回滚变更（缺省全部；id = 回滚该变更之后）',
              '  /search <词> 全文/语义搜索历史对话（F-17）',
              '  /image <路径...> 附图片到下一条消息（F-25，最多 5 张；png/jpeg/gif/webp，单张 ≤4MB）',
              '  /exit    退出',
              'Esc 中断当前任务运行。',
            ].join('\n'),
          });
          return true;
        case 'new':
          addItem({ kind: 'system', text: '（/new 完整实现随 M4 多会话管理交付；当前请退出后重新运行 yzero）' });
          return true;
        case 'todos':
          addItem({
            kind: 'system',
            text: todosRef.current.length
              ? todosRef.current.map((t) => `- [${t.status === 'done' ? 'x' : ' '}] (${t.status}) ${t.content}`).join('\n')
              : '（任务清单为空）',
          });
          return true;
        case 'changes': {
          // F-24 会话级 diff 汇总
          const summary = props.service.changes.summary(props.session.id);
          const total = props.service.changes.countAfter(props.session.id);
          addItem({
            kind: 'system',
            text: [
              `文件变更（共 ${total} 次）：`,
              renderSummary(summary),
            ].join('\n'),
          });
          return true;
        }
        case 'rollback': {
          // F-24 一键回滚：/rollback [changeId]（缺省回滚会话内全部变更）
          const arg = rest[0];
          const beforeId = arg ? Number(arg) : undefined;
          if (arg && (!Number.isInteger(beforeId) || beforeId! <= 0)) {
            addItem({ kind: 'system', text: `用法：/rollback [changeId]（/changes 查看变更 id）` });
            return true;
          }
          void props.service.changes
            .rollbackTo(props.session.id, process.cwd(), beforeId)
            .then((res) => {
              const lines = [
                `↩ 已回滚 ${res.reverted.length} 项，跳过 ${res.skipped.length} 项：`,
                ...res.reverted.map((r) => `  #${r.id} ${r.action === 'deleted' ? '删除' : '恢复'} ${r.path}`),
                ...res.skipped.map((s) => `  #${s.id} 跳过 ${s.path}（${s.reason}）`),
              ];
              addItem({ kind: 'system', text: lines.join('\n') });
            })
            .catch((e) => addItem({ kind: 'system', text: `回滚失败：${(e as Error).message}` }));
          addItem({ kind: 'system', text: beforeId ? `回滚 #${beforeId} 之后的变更…` : '回滚会话内全部变更…' });
          return true;
        }
        case 'search': {
          // F-17 对话检索：全文 + 语义混合（embedding 不可用时自动降级全文）
          const q = rest.join(' ').trim();
          if (!q) {
            addItem({ kind: 'system', text: '用法：/search <检索词>（如 /search 数据库连接池）' });
            return true;
          }
          addItem({ kind: 'system', text: `检索「${q}」…` });
          void props.service
            .searchMessages(q, { limit: 10 })
            .then((hits) => addItem({ kind: 'system', text: formatSearchHits(hits, q) }))
            .catch((e) => addItem({ kind: 'system', text: `检索失败：${(e as Error).message}` }));
          return true;
        }
        case 'image': {
          // F-25 多模态：附件加入暂存区，随下一条消息发送
          const paths = rest.map((p) => p.replace(/^"|"$/g, '')).filter(Boolean);
          if (paths.length === 0) {
            addItem({
              kind: 'system',
              text: `用法：/image <图片路径...>（最多 ${5} 张；png/jpeg/gif/webp，单张 ≤4MB）`,
            });
            return true;
          }
          try {
            const prepared = prepareImages(paths);
            pendingImagesRef.current = [...pendingImagesRef.current, ...prepared];
            addItem({
              kind: 'system',
              text:
                `已附加 ${prepared.length} 张图片（输入消息后一并发送）：\n` +
                prepared.map((p) => `  🖼 ${describeImage(p)}`).join('\n'),
            });
          } catch (e) {
            addItem({ kind: 'system', text: `✘ ${(e instanceof ImageError ? e.message : (e as Error).message)}` });
          }
          return true;
        }
        case 'budget': {
          const b = budgetRef.current;
          addItem({
            kind: 'system',
            text: `Token: ${b.usedTokens().toLocaleString()} / ${b.config.maxTokens.toLocaleString()} (${(b.usedTokenPct() * 100).toFixed(1)}%)\n费用: $${b.state.usedCostUsd.toFixed(4)} / $${b.config.maxCostUsd.toFixed(2)}\n本次进程累计: in=${usage.input} out=${usage.output}`,
          });
          return true;
        }
        case 'exit':
          exit();
          return true;
        default:
          return false;
      }
    },
    [addItem, exit, usage],
  );

  const onSubmit = useCallback(
    (value: string) => {
      const v = value.trim();
      if (!v || running) return;
      setInput('');
      // pending ask_user answer takes priority
      if (pendingAskRef.current) {
        const resolve = pendingAskRef.current;
        pendingAskRef.current = null;
        addItem({ kind: 'user', text: v });
        resolve(v);
        return;
      }
      if (v.startsWith('/')) {
        if (!handleCommand(v)) addItem({ kind: 'system', text: `未知命令 ${v}（/help 查看帮助）` });
        return;
      }
      void run(v);
    },
    [running, handleCommand, run, addItem],
  );

  // Esc interrupts the running task
  useInput((_input, key) => {
    if (key.escape && running) {
      abortRef.current?.abort();
    }
  });

  // F-24 suggest：启动时一次性 git 建议（仓库脏 → 建议建工作分支）
  useEffect(() => {
    const git = gitRef.current!;
    void git.advisory(props.session.id).then((note) => {
      if (note) addItem({ kind: 'system', text: `⎇ ${note}` });
    });
    // F-27 SessionStart 钩子（旁路触发）
    void props.hooks?.emit('SessionStart', {
      sessionId: props.session.id,
      projectId: props.session.project_id,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      // F-27 SessionEnd 钩子（进程退出前旁路触发）
      void props.hooks?.emit('SessionEnd', {
        sessionId: props.session.id,
        projectId: props.session.project_id,
      });
      props.service.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor={theme.border} paddingX={1} flexDirection="column">
        {items.length === 0 ? (
          <Text dimColor>
            y-zero-agent v0.1 · {props.engineMode === 'plan-execute' ? 'Plan 模式' : props.engineMode === 'multi-agent' ? 'Multi-Agent 模式' : 'ReAct 模式'} · 模型 {props.session.model || 'claude-sonnet-4-5-20250929'}
            {permissionLabel(permsRef.current.policy.mode)}
            {'\n'}输入需求开始；/help 查看命令。
          </Text>
        ) : null}
        {items.map((it) => {
          if (it.kind === 'confirm' && it.request && it.resolve) {
            return (
              <ConfirmCard
                key={it.id}
                request={it.request}
                onDecide={(d) => {
                  it.resolve!(d);
                  updateItem(it.id, { kind: 'system', text: `→ ${d.kind}${d.kind === 'reject' ? '（已拒绝）' : ''}` });
                }}
              />
            );
          }
          return (
            <Box key={it.id} flexDirection="column" marginY={0}>
              {it.kind === 'user' && <Text color={theme.user}>{icons.user} {it.text}</Text>}
              {it.kind === 'assistant' && (
                <Text>
                  {it.text}
                  {it.pending ? <Text color={theme.cursor}>▋</Text> : null}
                </Text>
              )}
              {it.kind === 'thinking' && (
                <Text dimColor color={theme.thinking}>
                  {it.text}
                  {it.pending ? <Text color={theme.cursor}>▋</Text> : null}
                </Text>
              )}
              {it.kind === 'tool' && (
                <Text color={it.pending ? theme.toolPending : it.ok === false ? theme.toolFail : theme.toolOk}>
                  {it.text}
                </Text>
              )}
              {it.kind === 'system' && <Text dimColor>{it.text}</Text>}
              {it.kind === 'tool' && it.diff ? <DiffView lines={it.diff} /> : null}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={0}>
        {running ? (
          <>
            <Text color={theme.prompt}>{spinnerFrame} </Text>
            <Text dimColor>
              第 {turn} 轮{f36TurnBar(turn, props.maxTurns)} · tokens {(usage.input + usage.output).toLocaleString()} · ${usage.cost.toFixed(4)}（Esc 中断）
            </Text>
          </>
        ) : (
          <>
            <Text color={theme.prompt}>{icons.user} </Text>
            <TextInput value={input} onChange={setInput} onSubmit={onSubmit} placeholder="描述你的任务…" />
          </>
        )}
      </Box>
    </Box>
  );
}

/** F-36：轮次进度条（仅显式设置有限 maxTurns 时展示，如 3/20）。 */
function f36TurnBar(turn: number, maxTurns: number): string {
  if (!Number.isFinite(maxTurns) || maxTurns <= 0 || maxTurns > 1000) return '';
  const filled = Math.min(10, Math.max(0, Math.ceil((turn / maxTurns) * 10)));
  return ` [${'█'.repeat(filled)}${'░'.repeat(10 - filled)}]`;
}

/** F-36：edit/write 工具结果 → 行级 diff（取该工具最近一次快照；无快照/超大/不匹配返回 undefined）。 */
function f36DiffForTool(call: ToolCall, sessionId: string, service: SessionService): DiffLine[] | undefined {
  if (call.name !== 'edit_file' && call.name !== 'write_file') return undefined;
  const args = (call.args ?? safeParseArgs(call.argsJson)) as { path?: unknown };
  const path = typeof args.path === 'string' ? args.path : '';
  if (!path) return undefined;
  try {
    const rows = service.changes.list(sessionId, 10); // 最新在前
    const row = rows.find((r) => r.tool === call.name && r.path === path && !r.rolled_back);
    if (!row || row.before_oversized || row.after_oversized) return undefined;
    return compactDiff(diffLines(row.before_content ?? '', row.after_content ?? ''));
  } catch {
    return undefined; // diff 是锦上添花，任何失败都不影响主流程
  }
}

function safeParseArgs(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** L2 记忆召回块（memory-design §7 动态段；空则隐藏）。 */
function renderMemoryRecallBlock(
  memory: import('@y-zero/core').MemoryStore | undefined,
  input: string,
  scopes: string[],
): string {
  if (!memory) return '';
  try {
    const hits = memory.recall(input, scopes, 5);
    if (hits.length === 0) return '';
    return `## 相关长期记忆（自动召回）\n${hits.map((h) => `- (${h.item.kind}) ${h.item.content}`).join('\n')}`;
  } catch {
    return '';
  }
}
