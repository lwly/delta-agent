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
  SessionService,
  ToolRegistry,
  runReAct,
  type RunContext,
  type SessionRow,
} from '@y-zero/core';
import { ConfirmCard } from './confirm.js';

interface Item {
  id: number;
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'confirm';
  text: string;
  pending?: boolean;
  request?: ConfirmRequest;
  resolve?: (d: ConfirmDecision) => void;
}

export interface AppOptions {
  service: SessionService;
  session: SessionRow;
  provider: Awaited<ReturnType<typeof import('@y-zero/core').resolveProviderFromEnv>>;
  systemPrompt: string;
  yolo: boolean;
  debugPrompt: boolean;
  maxTurns: number;
}

let nextId = 1;

export function App(props: AppOptions) {
  const { exit } = useApp();
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [usage, setUsage] = useState({ input: 0, output: 0, cost: 0 });
  const abortRef = useRef<AbortController | null>(null);
  const registryRef = useRef<ToolRegistry>(new ToolRegistry());
  const todosRef = useRef<Array<{ content: string; status: 'pending' | 'in_progress' | 'done' }>>([]);
  const budgetRef = useRef<BudgetManager>(new BudgetManager());

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
  const confirm = useCallback(
    async (req: ConfirmRequest): Promise<ConfirmDecision> => {
      if (props.yolo) return { kind: 'allow' };
      return new Promise<ConfirmDecision>((resolve) => {
        addItem({ kind: 'confirm', text: '', request: req, resolve });
      });
    },
    [props.yolo, addItem],
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

      // build run context
      const ctx: RunContext = {
        sessionId: props.session.id,
        projectId: props.session.project_id,
        mode: 'react',
        model: props.session.model || 'claude-sonnet-4-5-20250929',
        systemPrompt: props.systemPrompt,
        maxTurns: props.maxTurns,
        signal: ac.signal,
        provider: props.provider,
        registry: registryRef.current,
        toolContext: {
          projectRoot: process.cwd(),
          signal: ac.signal,
          confirm,
          askUser,
          todos: todosRef.current,
        },
        budget: budgetRef.current,
        windowTokens: 200_000,
      };

      const history: ChatMessage[] = props.service.getHistory(props.session.id);
      props.service.appendMessage(props.session.id, { role: 'user', content: userInput });

      // stream state
      let assistantText = '';
      let assistantItemId: number | null = null;
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
        for await (const ev of runReAct(ctx, history, userInput)) {
          const e = ev as AgentEvent;
          switch (e.type) {
            case 'turn_start':
              turnCount = e.turn;
              break;
            case 'text_delta':
              if (assistantItemId === null) {
                const it = addItem({ kind: 'assistant', text: '' });
                assistantItemId = it.id;
              }
              assistantText += e.text;
              appendToItem(assistantItemId, e.text);
              break;
            case 'tool_call_start': {
              collectedCalls.push(e.call);
              const argsStr = JSON.stringify(e.call.args ?? safeParseArgs(e.call.argsJson));
              const shown = argsStr.length > 160 ? argsStr.slice(0, 160) + '…' : argsStr;
              addItem({ kind: 'tool', text: `⚙ ${e.call.name}(${shown})`, pending: true });
              break;
            }
            case 'tool_result': {
              saveAssistantWithCalls();
              const header = `⚙ ${e.call.name}`;
              const resultText = (e.result.ok ? '✔' : '✘') + ' ' + e.result.content.slice(0, 2000);
              setItems((prev) =>
                prev.map((it) =>
                  it.kind === 'tool' && it.pending && it.text.startsWith(header)
                    ? { ...it, pending: false, text: `${header}\n${resultText}` }
                    : it,
                ),
              );
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
            case 'budget_warning':
              addItem({
                kind: 'system',
                text: `⚠ 预算告警：已使用 ${(e.usedPct * 100).toFixed(0)}%（可用 /budget 查看，追加预算属 M2 能力）`,
              });
              break;
            case 'budget_exhausted':
              addItem({ kind: 'system', text: e.summary });
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
              break;
            default:
              break;
          }
        }
      } catch (err) {
        addItem({ kind: 'system', text: `✘ 运行异常：${(err as Error).message}` });
      } finally {
        assistantItemId = null;
        assistantText = '';
        assistantSaved = false;
        collectedCalls.length = 0;
        setRunning(false);
        abortRef.current = null;
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

  useEffect(() => {
    return () => {
      props.service.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor="gray" paddingX={1} flexDirection="column">
        {items.length === 0 ? (
          <Text dimColor>
            y-zero-agent v0.1 · ReAct 模式 · 模型 {props.session.model || 'claude-sonnet-4-5-20250929'}
            {props.yolo ? ' · YOLO' : ''}
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
              {it.kind === 'user' && <Text color="cyan">› {it.text}</Text>}
              {it.kind === 'assistant' && <Text>{it.text}</Text>}
              {it.kind === 'tool' && (
                <Text color={it.pending ? 'yellow' : it.text.startsWith('⚙') && !it.pending ? 'green' : 'red'}>
                  {it.text}
                </Text>
              )}
              {it.kind === 'system' && <Text dimColor>{it.text}</Text>}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={0}>
        <Text color="green">{running ? ' … ' : '› '}</Text>
        {running ? (
          <Text dimColor>任务运行中…（Esc 中断）</Text>
        ) : (
          <TextInput value={input} onChange={setInput} onSubmit={onSubmit} placeholder="描述你的任务…" />
        )}
      </Box>
    </Box>
  );
}

function safeParseArgs(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}
