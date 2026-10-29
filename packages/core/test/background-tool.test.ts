import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCommandTool, taskOutputTool } from '../src/tools/builtin/exec.js';
import type { ToolContext } from '../src/tools/types.js';
import { BackgroundTaskManager } from '../src/session/background-tasks.js';

const isWin = process.platform === 'win32';

function makeCtx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    projectRoot: mkdtempSync(path.join(os.tmpdir(), 'delta-bgc-')),
    signal: new AbortController().signal,
    confirm: async () => ({ kind: 'allow' }),
    askUser: async () => 'ok',
    todos: [],
    sessionId: 's1',
    ...over,
  };
}

describe('run_command run_in_background (F-54)', () => {
  it.runIf(isWin)('win32 跳过（后台语义测试只在 POSIX 验证）', () => {
    expect(true).toBe(true);
  });

  it.skipIf(isWin)('未注入 manager → 明确报错引导同步执行', async () => {
    const r = await runCommandTool.execute({ command: 'echo hi', run_in_background: true }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('background_tasks_unavailable');
  });

  it.skipIf(isWin)('注入 manager → 立即返回任务 id，meta 带任务 id', async () => {
    const mgr = new BackgroundTaskManager();
    const r = await runCommandTool.execute(
      { command: 'echo hi', run_in_background: true, description: '冒烟测试' },
      makeCtx({ backgroundTasks: mgr }),
    );
    expect(r.ok).toBe(true);
    const id = (r.meta as { background_task_id?: string } | undefined)?.background_task_id;
    expect(id).toMatch(/^bg_/);
    expect(r.content).toContain(id);
    expect(mgr.list('s1')[0]?.description).toBe('冒烟测试');
    mgr.killAll();
  });

  it.skipIf(isWin)('沙箱后端存在 → 拒绝后台执行', async () => {
    const r = await runCommandTool.execute(
      { command: 'echo hi', run_in_background: true },
      makeCtx({ backgroundTasks: new BackgroundTaskManager(), sandbox: {} as ToolContext['sandbox'] }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('background_unsupported_in_sandbox');
  });
});

describe('task_output (F-54)', () => {
  it('未注入 manager → 明确报错', async () => {
    const r = await taskOutputTool.execute({ task_id: 'bg_x' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('background_tasks_unavailable');
  });

  it('未知 id → unknown_task', async () => {
    const r = await taskOutputTool.execute({ task_id: 'bg_nope' }, makeCtx({ backgroundTasks: new BackgroundTaskManager() }));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unknown_task');
  });

  it.skipIf(isWin)('完成任务 → 状态 done + 输出可见', async () => {
    const mgr = new BackgroundTaskManager();
    const id = mgr.start('s1', 'echo task-output-ok', os.tmpdir());
    let out = mgr.getOutput(id)!;
    for (let i = 0; i < 50 && out.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      out = mgr.getOutput(id)!;
    }
    const r = await taskOutputTool.execute({ task_id: id }, makeCtx({ backgroundTasks: mgr }));
    expect(r.ok).toBe(true);
    expect(r.content).toContain('done');
    expect(r.content).toContain('task-output-ok');
  });
});
