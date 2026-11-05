// F-55 假 claude CLI fixture（docs/design-f55-external-cli-agents.md §12，测试/e2e 专用，零网络）：
// 模拟 `claude -p <prompt> --output-format stream-json` 的 stdout JSONL 事件流。
//
// 场景由 FAKE_CLAUDE_SCRIPT 指向的 JSON 文件描述：
//   {
//     "sessionId": "fake-claude-session-1",  // init 事件的 session_id（缺省 fake-claude-session-1）
//     "lines": [ ... ],                      // 依次输出的 stdout 行步骤
//     "exitCode": 0                          // 全部步骤执行完后的退出码（缺省 0）
//   }
// 步骤类型：
//   { "event": {...} }                // 把对象 JSON 序列化后写一行 stdout（stream-json 事件）
//   { "raw": "..." }                  // 写一行任意文本（非法 JSON 场景）
//   { "stderr": "..." }               // 写一行 stderr（stderrTail 断言）
//   { "delay": N }                    // 等待 N 毫秒（abort 场景留窗口）
// 固定行为：
//   - 启动时把完整 argv（process.argv.slice(2)）以 `[fake-claude] argv: <JSON>` 写一行 stderr，
//     供测试断言 adapter 组装的 spawn 参数（--mcp-config / --resume 等）
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

// argv 透传（供 spawn 参数断言）必须在任何场景校验之前完成：即使场景缺失也要能看到 args
process.stderr.write(`[fake-claude] argv: ${JSON.stringify(process.argv.slice(2))}\n`);

const scriptPath = process.env.FAKE_CLAUDE_SCRIPT;
if (!scriptPath) {
  console.error('[fake-claude] 缺少 FAKE_CLAUDE_SCRIPT 环境变量（应指向场景 JSON 文件）');
  process.exit(2);
}

let scenario;
try {
  scenario = JSON.parse(readFileSync(scriptPath, 'utf-8'));
} catch (e) {
  console.error(`[fake-claude] 场景文件读取/解析失败：${e?.message ?? e}`);
  process.exit(2);
}

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

/** 收尾：置退出码、关 stdin 读端让 Node 冲刷 stdout 后自然退出（避免 process.exit 截断未刷出的行） */
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

async function runSteps() {
  const lines = Array.isArray(scenario.lines) ? scenario.lines : [];
  for (const step of lines) {
    if (step.event !== undefined) {
      send(step.event);
    } else if (step.raw !== undefined) {
      process.stdout.write(`${step.raw}\n`);
    } else if (step.stderr !== undefined) {
      process.stderr.write(`${step.stderr}\n`);
    } else if (step.delay !== undefined) {
      await new Promise((r) => {
        delayTimer = setTimeout(r, step.delay);
      });
    } else {
      console.error(`[fake-claude] 未知步骤：${JSON.stringify(step)}`);
      finish(2);
      return;
    }
  }
  finish(scenario.exitCode ?? 0);
}

// claude -p 非交互模式不读 stdin；挂 readline 仅为了 finish() 里能 close/destroy 冲刷输出
const rl = createInterface({ input: process.stdin });
rl.on('line', () => {
  // 忽略一切 stdin 输入（宽容）
});
void runSteps();
