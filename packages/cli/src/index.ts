#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { Command } from 'commander';
import * as path from 'node:path';
import {
  SessionService,
  resolveProviderFromEnv,
  estimateMessagesTokens,
} from '@y-zero/core';
import { App } from './ui/app.js';

interface CliOpts {
  resume?: string;
  model?: string;
  yolo?: boolean;
  debugPrompt?: boolean;
  maxTurns: string;
  db?: string;
}

const program = new Command();

program
  .name('yzero')
  .description('y-zero-agent —— AI 编程命令行工具（M1：ReAct 引擎 + 11 工具 + ink 确认卡）')
  .version('0.1.0')
  .option('-r, --resume [sessionId]', '恢复指定会话（缺省恢复项目最近会话）')
  .option('-m, --model <model>', '指定模型名（默认读 YZERO_MODEL，再退回 claude-sonnet-4-5）')
  .option('--yolo', '跳过高危工具确认（危险）')
  .option('--debug-prompt', '启动时打印系统提示词与上下文统计')
  .option('--max-turns <n>', '单任务最大轮次', '50')
  .option('--db <path>', 'SQLite 数据库路径（默认 ~/.y-zero/agent.db）')
  .action(async (opts: CliOpts) => {
    await start(opts);
  });

async function start(opts: CliOpts): Promise<void> {
  // provider (M1: anthropic via env)
  let provider;
  try {
    provider = await resolveProviderFromEnv();
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exit(1);
  }

  // session
  const service = new SessionService(opts.db);
  const cwd = process.cwd();
  const project = service.ensureProject(cwd);
  let session = opts.resume
    ? typeof opts.resume === 'string'
      ? service.getSession(opts.resume)
      : service.latestSession(project.id)
    : undefined;
  if (opts.resume && !session) {
    console.error('✘ 未找到指定会话');
    process.exit(1);
  }
  if (!session) {
    session = service.createSession(project.id, {
      title: `${project.name} · ${new Date().toLocaleString('zh-CN')}`,
      model: opts.model ?? process.env.YZERO_MODEL ?? 'claude-sonnet-4-5-20250929',
    });
  } else if (opts.model) {
    session = { ...session, model: opts.model };
  }

  // minimal M1 system prompt (7-layer assembly lands in M3)
  const env = [
    `OS: ${process.platform} (${process.arch})`,
    `Node: ${process.version}`,
    `CWD: ${cwd}`,
    `Time: ${new Date().toISOString()}`,
  ].join('\n');

  const systemPrompt = [
    '你是 y-zero-agent，一个在终端中工作的 AI 编程助手。通过调用工具完成任务，遵循 ReAct 循环：先思考再行动，根据观察结果继续。',
    '安全基线：所有文件路径必须位于项目根目录内；高危操作（写文件/编辑/执行命令）会先请求用户确认；不得尝试绕过沙箱；不得硬编码密钥。',
    '工具使用规范：优先 read_file/glob_search/grep_search 收集上下文再动手；写代码前先看现有代码风格；测试用 run_tests；无法推进时用 ask_user 询问。',
    `## 运行环境\n${env}`,
  ].join('\n\n');

  if (opts.debugPrompt) {
    const history = service.getHistory(session.id);
    console.error('[debug] system prompt tokens ≈', estimateMessagesTokens([{ role: 'system', content: systemPrompt }]));
    console.error('[debug] history messages:', history.length, 'tokens ≈', estimateMessagesTokens(history));
    console.error('[debug] system prompt:\n' + systemPrompt);
  }

  const app = React.createElement(App, {
    service,
    session,
    provider,
    systemPrompt,
    yolo: Boolean(opts.yolo),
    debugPrompt: Boolean(opts.debugPrompt),
    maxTurns: Number(opts.maxTurns) || 50,
  });

  const { waitUntilExit } = render(app, { exitOnCtrlC: true });
  await waitUntilExit();
}

program.parseAsync(process.argv).catch((e) => {
  console.error(`✘ ${(e as Error).message}`);
  process.exit(1);
});

// keep path import used (win compat helpers may grow here)
void path;
