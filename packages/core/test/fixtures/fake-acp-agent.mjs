// F-55 假 ACP agent fixture（docs/design-f55-external-cli-agents.md §12，测试/e2e 专用，零网络）：
// 模拟一个最小 ACP agent——stdin 逐行读 JSON-RPC，stdout 逐行写 JSON-RPC（换行分隔）。
//
// 场景由 FAKE_ACP_SCRIPT 指向的 JSON 文件描述：
//   {
//     "protocolVersion": 1,        // initialize 回包（缺省 1）
//     "authMethods": [...],        // initialize 回包认证方式（缺省 []）；[{id,name}]
//     "requireAuth": true,         // 首个 session/new 回 -32000 认证错，authenticate 后才放行
//     "authUrl": "https://...",    // authenticate 期间经 _codebuddy.ai/authUrl 通知推送的登录链接
//     "authUrlParam": "url",       // 通知 params 的字段名（缺省 authUrl——codebuddy 实测真实字段名；
//                                  //   设为 "url" 覆盖兜底解析路径）
//     "authFail": "sign in error: EPERM"  // authenticate 回错误回包（先写一行 stderr，模拟凭据目录无权限）
//     "steps": [ ... ],            // 收到 session/prompt 后依次执行
//     "stopReason": "end_turn",    // prompt 回包（缺省 end_turn）
//     "exitCode": 0                // 步骤全部执行完后的退出码（缺省 0）
//   }
// 步骤类型：
//   { "type": "update", "params": {...} }              // 发 session/update 通知（params 原样，宽容透传）
//   { "type": "request_permission", "params": {...} }  // 发 session/request_permission 请求并等回包，
//                                                      // 收到回包后把 outcome 塞进下一条
//                                                      // agent_message_chunk 的 text 供断言
//   { "type": "raw", "text": "..." }                   // 写一行任意文本（非法 JSON 场景）
//   { "type": "stderr", "text": "..." }                // 写一行 stderr（stderrTail 断言）
//   { "type": "delay", "ms": N }                       // 等待 N 毫秒（abort 场景留窗口）
//   { "type": "exit", "code": N }                      // 立即以退出码 N 结束（后续步骤不执行）
// 固定行为：
//   - initialize → 回 protocolVersion + agentCapabilities
//   - session/new → 回 { sessionId: 'fake-acp-session-1' }
//   - session/cancel 通知 → stderr 记录一行后以退出码 0 退出（供 abort 测试断言）
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const scriptPath = process.env.FAKE_ACP_SCRIPT;
if (!scriptPath) {
  console.error('[fake-acp] 缺少 FAKE_ACP_SCRIPT 环境变量（应指向场景 JSON 文件）');
  process.exit(2);
}

let scenario;
try {
  scenario = JSON.parse(readFileSync(scriptPath, 'utf-8'));
} catch (e) {
  console.error(`[fake-acp] 场景文件读取/解析失败：${e?.message ?? e}`);
  process.exit(2);
}

const SESSION_ID = 'fake-acp-session-1';
let authDone = false; // requireAuth 场景：authenticate 收到后置 true，session/new 随之放行
const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

/** 收尾：置退出码、清未决定时器（否则 delay 的 timer 会拽住事件循环，进程迟迟不退）、
 * 关闭 stdin 读端，让 Node 冲刷 stdout 后自然退出（避免 process.exit 截断未刷出的行） */
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

// ---- agent→client 请求的回包等待表（本 fixture 只发 session/request_permission） ----
const pendingResolves = new Map();
let nextReqId = 1000;
function requestPermission(params) {
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
    send({ jsonrpc: '2.0', id, method: 'session/request_permission', params });
  });
}

// ---- session/prompt 场景执行 ----
async function runSteps(promptId) {
  const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
  for (const step of steps) {
    if (step.type === 'update') {
      send({ jsonrpc: '2.0', method: 'session/update', params: step.params });
    } else if (step.type === 'request_permission') {
      const response = await requestPermission(step.params);
      // 回显收到的 outcome：塞进下一条 message chunk 的 text，供测试断言 respondPermission 路径
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: SESSION_ID,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `permission-outcome:${JSON.stringify(response?.outcome ?? response)}` },
          },
        },
      });
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
      console.error(`[fake-acp] 未知步骤类型：${step.type}`);
      finish(2);
      return;
    }
  }
  send({ jsonrpc: '2.0', id: promptId, result: { stopReason: scenario.stopReason ?? 'end_turn' } });
  // keepAlive: true → 回包后不退出（模拟 cursor-agent 等常驻 ACP agent，回归「答完不停」）
  if (scenario.keepAlive === true) return;
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
  // agent→client 请求的回包（我们发出的 request_permission）
  if (msg.method === undefined && msg.id !== undefined && pendingResolves.has(String(msg.id))) {
    const resolve = pendingResolves.get(String(msg.id));
    pendingResolves.delete(String(msg.id));
    resolve(msg.error ? { error: msg.error } : msg.result);
    return;
  }
  if (msg.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: scenario.protocolVersion ?? 1,
        agentCapabilities: { loadSession: false, promptCapabilities: {} },
        authMethods: Array.isArray(scenario.authMethods) ? scenario.authMethods : [],
      },
    });
  } else if (msg.method === 'session/new') {
    // requireAuth 场景：认证完成前一律回 -32000 认证错（data.category=auth，codebuddy 实测形状）
    if (scenario.requireAuth === true && !authDone) {
      send({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32000, message: 'Authentication required', data: { category: 'auth' } },
      });
      return;
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: SESSION_ID } });
  } else if (msg.method === 'authenticate') {
    // 模拟真实时序：先推登录链接通知（浏览器登录），登录完成后（测试内立即）回包放行。
    // params 字段名缺省 authUrl（codebuddy 实测真实形状——此前发 url 导致测试全绿真机必挂）
    const authUrlParams = { [scenario.authUrlParam ?? 'authUrl']: scenario.authUrl ?? 'https://example.com/login?token=fake' };
    send({ jsonrpc: '2.0', method: '_codebuddy.ai/authUrl', params: authUrlParams });
    if (typeof scenario.authFail === 'string') {
      // 认证失败路径：先写 stderr（EPERM 类错误 CLI 侧只打到 stderr），再回错误回包
      process.stderr.write(`[fake-acp] ${scenario.authFail}\n`);
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'authenticate failed' } });
      return;
    }
    authDone = true;
    send({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'session/prompt') {
    void runSteps(msg.id);
  } else if (msg.method === 'session/cancel') {
    process.stderr.write('[fake-acp] recv: session/cancel\n');
    finish(0);
  } else if (msg.id !== undefined) {
    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'fake-acp: method not supported' } });
  }
  // 其他通知：忽略
});
