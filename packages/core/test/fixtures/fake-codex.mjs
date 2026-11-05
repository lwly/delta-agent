// F-55 假 Codex app-server fixture（docs/design-f55-external-cli-agents.md §12，测试/e2e 专用，零网络）：
// 模拟 codex app-server v2 协议——stdin 逐行读 JSON-RPC，stdout 逐行写 JSON-RPC（换行分隔）。
// 线上形状以 codex-cli 0.162.0-alpha.17.2 实测 + generate-json-schema 为准（见 external/codex.ts 注释）。
//
// 场景由 FAKE_CODEX_SCRIPT 指向的 JSON 文件描述：
//   {
//     "threadId": "fake-codex-thread-1",   // thread/start 回包 thread.id（缺省 fake-codex-thread-1）
//     "turnId": "fake-codex-turn-1",       // turn/start 回包 turn.id（缺省 fake-codex-turn-1）
//     "steps": [ ... ],                    // 收到 turn/start 后依次执行
//     "exitCode": 0                        // 步骤全部执行完后的退出码（缺省 0）
//   }
// 步骤类型（形状对齐 v2 schema）：
//   { "type": "agentMessageDelta", "delta": "..." }                       // item/agentMessage/delta 通知
//   { "type": "reasoningDelta", "delta": "..." }                          // item/reasoning/textDelta 通知
//   { "type": "itemStarted", "item": {...} }                              // item/started 通知
//   { "type": "itemCompleted", "item": {...} }                            // item/completed 通知
//   { "type": "tokenUsage", "inputTokens": N, "outputTokens": N }         // thread/tokenUsage/updated 通知
//   { "type": "errorNotification", "message": "...", "codexErrorInfo": "...", "willRetry": false }
//                                                                         // error 通知（TurnError 形状）
//   { "type": "turnCompleted", "turn": {...} }                            // turn/completed 通知（turn 缺省最小形状）
//   { "type": "requestApproval", "method": "...", "params": {...} }       // 发 server→client 审批请求并等回包，
//                                                                         // 收到回包后把 decision 塞进下一条
//                                                                         // agentMessageDelta 的 delta 供断言
//   { "type": "notification", "method": "...", "params": {...} }          // 发任意通知（宽容透传）
//   { "type": "raw", "text": "..." }                                      // 写一行任意文本（非法 JSON 场景）
//   { "type": "stderr", "text": "..." }                                   // 写一行 stderr（stderrTail 断言）
//   { "type": "delay", "ms": N }                                          // 等待 N 毫秒（abort 场景留窗口）
//   { "type": "exit", "code": N }                                         // 立即以退出码 N 结束（后续步骤不执行）
// 固定行为：
//   - initialize → 回 { codexHome, platformFamily, platformOs, userAgent }
//   - thread/start → 回 { thread: { id: scenario.threadId } }
//   - thread/resume → 回 { thread: { id: params.threadId ?? scenario.threadId } }
//   - turn/start → 回 { turn: { id: scenario.turnId, status: 'inProgress', items: [] } }，随后执行 steps
//   - turn/interrupt → stderr 记一行后以退出码 0 退出（供 abort 测试断言）
//   - 每个收到的请求都写 stderr：`[fake-codex] recv: <method> <params JSON>`（握手序断言）
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scriptPath = process.env.FAKE_CODEX_SCRIPT;
if (!scriptPath) {
  console.error('[fake-codex] 缺少 FAKE_CODEX_SCRIPT 环境变量（应指向场景 JSON 文件）');
  process.exit(2);
}

let scenario;
try {
  scenario = JSON.parse(readFileSync(scriptPath, 'utf-8'));
} catch (e) {
  console.error(`[fake-codex] 场景文件读取/解析失败：${e?.message ?? e}`);
  process.exit(2);
}

const THREAD_ID = scenario.threadId ?? 'fake-codex-thread-1';
const TURN_ID = scenario.turnId ?? 'fake-codex-turn-1';
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/** 收尾：置退出码、清未决定时器、关 stdin 读端，让 Node 冲刷 stdout 后自然退出 */
let delayTimer = null;
function finish(code) {
  process.exitCode = code;
  if (delayTimer !== null) {
    clearTimeout(delayTimer);
    delayTimer = null;
  }
  rl.close();
  process.stdin.destroy();
}

// ---- server→client 审批请求的回包等待表 ----
const pendingResolves = new Map();
let nextReqId = 1000;
function requestApproval(method, params) {
  return new Promise((resolve) => {
    const id = nextReqId++;
    // 兜底超时：3s 无回包 resolve null，防测试挂死；正常回包时清掉定时器（否则拽住事件循环）
    const timer = setTimeout(() => {
      if (pendingResolves.has(String(id))) {
        pendingResolves.delete(String(id));
        resolve(null);
      }
    }, 3000);
    pendingResolves.set(String(id), (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

// ---- turn/start 场景执行 ----
async function runSteps() {
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  for (const step of steps) {
    if (step.type === 'agentMessageDelta') {
      send({
        jsonrpc: '2.0',
        method: 'item/agentMessage/delta',
        params: { delta: step.delta, itemId: step.itemId ?? 'item-msg-1', threadId: THREAD_ID, turnId: TURN_ID },
      });
    } else if (step.type === 'reasoningDelta') {
      send({
        jsonrpc: '2.0',
        method: 'item/reasoning/textDelta',
        params: { contentIndex: 0, delta: step.delta, itemId: step.itemId ?? 'item-think-1', threadId: THREAD_ID, turnId: TURN_ID },
      });
    } else if (step.type === 'itemStarted') {
      send({ jsonrpc: '2.0', method: 'item/started', params: { item: step.item, startedAtMs: 1, threadId: THREAD_ID, turnId: TURN_ID } });
    } else if (step.type === 'itemCompleted') {
      send({ jsonrpc: '2.0', method: 'item/completed', params: { item: step.item, completedAtMs: 2, threadId: THREAD_ID, turnId: TURN_ID } });
    } else if (step.type === 'tokenUsage') {
      const breakdown = {
        inputTokens: step.inputTokens ?? 0,
        outputTokens: step.outputTokens ?? 0,
        cachedInputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: (step.inputTokens ?? 0) + (step.outputTokens ?? 0),
      };
      send({
        jsonrpc: '2.0',
        method: 'thread/tokenUsage/updated',
        params: { threadId: THREAD_ID, turnId: TURN_ID, tokenUsage: { last: breakdown, total: breakdown } },
      });
    } else if (step.type === 'errorNotification') {
      send({
        jsonrpc: '2.0',
        method: 'error',
        params: {
          error: { message: step.message, ...(step.codexErrorInfo ? { codexErrorInfo: step.codexErrorInfo } : {}) },
          threadId: THREAD_ID,
          turnId: TURN_ID,
          willRetry: step.willRetry ?? false,
        },
      });
    } else if (step.type === 'turnCompleted') {
      send({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {
          threadId: THREAD_ID,
          turn: step.turn ?? { id: TURN_ID, status: 'completed', items: [] },
        },
      });
    } else if (step.type === 'requestApproval') {
      const response = await requestApproval(step.method, step.params);
      // 回显收到的 decision：塞进下一条 agentMessageDelta 的 delta，供测试断言 respondPermission 路径
      send({
        jsonrpc: '2.0',
        method: 'item/agentMessage/delta',
        params: { delta: `approval-decision:${JSON.stringify(response ?? response)}`, itemId: 'item-echo', threadId: THREAD_ID, turnId: TURN_ID },
      });
    } else if (step.type === 'notification') {
      send({ jsonrpc: '2.0', method: step.method, params: step.params ?? {} });
    } else if (step.type === 'raw') {
      process.stdout.write(`${step.text}\n`);
    } else if (step.type === 'stderr') {
      process.stderr.write(`${step.text}\n`);
    } else if (step.type === 'delay') {
      await new Promise((r) => {
        delayTimer = setTimeout(r, step.ms);
      });
    } else if (step.type === 'exit') {
      finish(step.code);
      return;
    } else {
      console.error(`[fake-codex] 未知步骤类型：${step.type}`);
      finish(2);
      return;
    }
  }
  finish(scenario.exitCode ?? 0);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // 非法输入行：忽略（宽容原则）
  }
  // server→client 请求的回包（我们发出的审批请求）
  if (msg.method === undefined && msg.id !== undefined && pendingResolves.has(String(msg.id))) {
    const resolve = pendingResolves.get(String(msg.id));
    pendingResolves.delete(String(msg.id));
    resolve(msg.error ? { error: msg.error } : msg.result);
    return;
  }
  if (msg.method === 'initialize') {
    process.stderr.write(`[fake-codex] recv: initialize ${JSON.stringify(msg.params ?? {})}\n`);
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        codexHome: '/tmp/fake-codex-home',
        platformFamily: 'unix',
        platformOs: 'macos',
        userAgent: 'fake-codex/0.0.0',
      },
    });
  } else if (msg.method === 'thread/start') {
    process.stderr.write(`[fake-codex] recv: thread/start ${JSON.stringify(msg.params ?? {})}\n`);
    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: THREAD_ID } } });
  } else if (msg.method === 'thread/resume') {
    process.stderr.write(`[fake-codex] recv: thread/resume ${JSON.stringify(msg.params ?? {})}\n`);
    send({ jsonrpc: '2.0', id: msg.id, result: { thread: { id: msg.params?.threadId ?? THREAD_ID } } });
  } else if (msg.method === 'turn/start') {
    process.stderr.write(`[fake-codex] recv: turn/start ${JSON.stringify(msg.params ?? {})}\n`);
    send({ jsonrpc: '2.0', id: msg.id, result: { turn: { id: TURN_ID, status: 'inProgress', items: [] } } });
    void runSteps();
  } else if (msg.method === 'turn/interrupt') {
    process.stderr.write(`[fake-codex] recv: turn/interrupt ${JSON.stringify(msg.params ?? {})}\n`);
    // 回包（interrupt 是请求）后立即退出，模拟上游中断收敛
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
    finish(0);
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'fake-codex: method not supported' } });
  }
  // 其他通知（initialized 等）：忽略
});
