#!/usr/bin/env node
/**
 * 真机冒烟测试：用已存储的 Provider 配置跑一次完整 ReAct 循环。
 * 用法：node scripts/smoke.mjs [项目目录]（缺省 /tmp/yz-smoke）
 * 无任何硬编码密钥 —— 走 `delta models add` 的加密存储或环境变量。
 */
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DeepSeekProvider,
  ProviderManager,
  ToolRegistry,
  BudgetManager,
  runReAct,
  resolveProviderFromEnv,
} from '../packages/core/dist/index.js';

const root = process.argv[2] ?? (await mkdtemp(path.join(os.tmpdir(), 'yz-smoke-')));
fs.mkdirSync(root, { recursive: true });

console.log(`[smoke] project root: ${root}`);

const provider = await resolveProviderFromEnv();
console.log(`[smoke] provider: ${provider.id}`);

const registry = new ToolRegistry();
const budget = new BudgetManager();
const ac = new AbortController();
setTimeout(() => ac.abort(), 120_000); // hard cap

const task =
  '请在当前项目根目录创建文件 notes.txt，内容为一行文本 "hello from delta-agent"。' +
  '然后用 read_file 读取它确认写入成功，最后简要报告完成情况。';

let finalText = '';
let toolCalls = 0;
const t0 = Date.now();

for await (const ev of runReAct(
  {
    sessionId: 'smoke',
    projectId: 'smoke',
    mode: 'react',
    model: process.env.DELTA_MODEL || 'deepseek-chat',
    systemPrompt:
      '你是 delta-agent，一个在终端工作的 AI 编程助手。通过调用工具完成任务，遵循 ReAct 循环。',
    maxTurns: 8,
    signal: ac.signal,
    provider,
    registry,
    toolContext: {
      projectRoot: root,
      signal: ac.signal,
      confirm: async () => ({ kind: 'allow' }), // smoke: auto-allow
      askUser: async (q) => q,
      todos: [],
    },
    budget,
    windowTokens: 128_000,
  },
  [],
  task,
)) {
  switch (ev.type) {
    case 'turn_start':
      console.log(`[smoke] ── turn ${ev.turn}`);
      break;
    case 'tool_call_start':
      toolCalls++;
      console.log(`[smoke] ⚙ ${ev.call.name}(${JSON.stringify(ev.call.args ?? ev.call.argsJson)})`);
      break;
    case 'tool_result':
      console.log(`[smoke] ${ev.result.ok ? '✔' : '✘'} ${ev.call.name}: ${ev.result.content.slice(0, 120)}`);
      break;
    case 'usage':
      console.log(`[smoke] usage in=${ev.usage.inputTokens} out=${ev.usage.outputTokens}`);
      break;
    case 'error':
      console.log(`[smoke] ✘ ${ev.fatal ? 'FATAL' : 'warn'}: ${ev.message}`);
      break;
    case 'done':
      finalText = `done in=${ev.usage.inputTokens} out=${ev.usage.outputTokens}`;
      break;
    default:
      break;
  }
}

// verify side effect
const file = path.join(root, 'notes.txt');
const content = await readFile(file, 'utf8').catch(() => null);
const ok = content?.trim() === 'hello from delta-agent';
console.log(`[smoke] ${'─'.repeat(40)}`);
console.log(`[smoke] file check: ${ok ? 'PASS' : 'FAIL'} (${content?.trim() ?? 'missing'})`);
console.log(`[smoke] turns used tool calls: ${toolCalls}, wall: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${finalText}`);
process.exit(ok && toolCalls > 0 ? 0 : 1);
