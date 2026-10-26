/**
 * spawn 执行器（core 通用实现）单测：
 *  - nodePath/cliEntry 注入语义（Electron 宿主以 ELECTRON_RUN_AS_NODE 等方式复用的基础）；
 *  - cliEntry 缺失收敛为 error 结果（执行器不抛出约定）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSpawnExecutor, type CronJob } from '../src/index.js';

let tmpDir: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-spawn-exec-'));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    name: '测试任务',
    cron: '* * * * *',
    prompt: '整理日报',
    cwd: os.tmpdir(),
    enabled: true,
    permission: 'default',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runs: [],
    ...overrides,
  } as CronJob;
}

describe('createSpawnExecutor（core 通用 spawn 执行器）', () => {
  it('nodePath + cliEntry 注入：以指定 Node 运行入口，解析 --json 报告', async () => {
    // 伪 CLI 入口：打印 headless --json 报告（含 sessionId/cost/turns/result）
    const cliEntry = path.join(tmpDir, 'fake-cli.mjs');
    fs.writeFileSync(
      cliEntry,
      `process.stdout.write(JSON.stringify({
        status: 'completed',
        session_id: 'sess-42',
        usage: { cost_usd: 0.25 },
        turns: 3,
        result: '报表已生成',
      }));\n`,
    );
    const exec = createSpawnExecutor({ cliEntry, nodePath: process.execPath, timeoutMs: 10_000 });
    const r = await exec(makeJob());
    expect(r.status).toBe('completed');
    expect(r.exitCode).toBe(0);
    expect(r.sessionId).toBe('sess-42');
    expect(r.costUsd).toBe(0.25);
    expect(r.turns).toBe(3);
    expect(r.resultPreview).toBe('报表已生成');
  });

  it('cliEntry 不存在：收敛为 error 结果且不抛出', async () => {
    const exec = createSpawnExecutor({ cliEntry: path.join(tmpDir, 'missing-entry.js') });
    const r = await exec(makeJob());
    expect(r.status).toBe('error');
    expect(r.exitCode).toBeNull();
    expect(r.error).toContain('CLI 入口不存在');
  });

  it('job.cwd 不存在：收敛为 error 结果且不抛出', async () => {
    const cliEntry = path.join(tmpDir, 'fake-cli.mjs');
    fs.writeFileSync(cliEntry, '');
    const exec = createSpawnExecutor({ cliEntry });
    const r = await exec(makeJob({ cwd: path.join(tmpDir, 'no-such-dir') }));
    expect(r.status).toBe('error');
    expect(r.error).toContain('运行目录不存在');
  });
});
