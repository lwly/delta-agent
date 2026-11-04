// F-55 假外部 CLI fixture（docs/design-f55-external-cli-agents.md §12.1）：
// 读 FAKE_CLI_SCRIPT 指向的 JSON 场景文件，按脚本逐步执行——
//   { type: 'stdout', text: '...' }  写一行到 stdout（自动补 \n；text 须为合法 ExternalEvent JSON）
//   { type: 'stderr', text: '...' }  写一行到 stderr
//   { type: 'delay',  ms: N }        等待 N 毫秒
//   { type: 'exit',   code: N }      以退出码 N 结束（后续步骤不再执行）
// 脚本缺失 / 非法 JSON / 非数组 / 未知步骤类型 → stderr 报错并 exit 2。
// 场景里的 stdout 行由消费方（ScriptedExternalAdapter）逐行 JSON.parse 成 ExternalEvent。
import { readFileSync } from 'node:fs';

const scriptPath = process.env.FAKE_CLI_SCRIPT;
if (!scriptPath) {
  console.error('[fake-cli] 缺少 FAKE_CLI_SCRIPT 环境变量（应指向场景 JSON 文件）');
  process.exit(2);
}

let steps;
try {
  steps = JSON.parse(readFileSync(scriptPath, 'utf-8'));
} catch (e) {
  console.error(`[fake-cli] 场景文件读取/解析失败：${e?.message ?? e}`);
  process.exit(2);
}
if (!Array.isArray(steps)) {
  console.error('[fake-cli] 场景文件必须是步骤数组');
  process.exit(2);
}

for (const step of steps) {
  if (step.type === 'stdout') {
    process.stdout.write(`${step.text}\n`);
  } else if (step.type === 'stderr') {
    process.stderr.write(`${step.text}\n`);
  } else if (step.type === 'delay') {
    await new Promise((r) => setTimeout(r, step.ms));
  } else if (step.type === 'exit') {
    // 用 exitCode 让 Node 自然冲刷 stdio 后退出，避免 process.exit 截断未刷出的行
    process.exitCode = step.code;
    break;
  } else {
    console.error(`[fake-cli] 未知步骤类型：${step.type}`);
    process.exit(2);
  }
}
