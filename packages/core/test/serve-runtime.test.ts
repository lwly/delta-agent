/**
 * serve 运行时组装工厂单测（桌面宿主复用的核心装配点）：
 *  - port 0 → 实际端口回读；
 *  - authToken 鉴权：/api/* 无 token / 错 token → 401，对 token → 200（恒定时间比较路径）；
 *  - 静态资源豁免鉴权（BrowserWindow 资产请求不带凭据）；
 *  - dispose 幂等且释放后连接被拒；
 *  - F-22 收口：cron 调度器随 serve 托管（auto/off/环境变量/单例守卫/dispose 复位）
 *    与 GET /api/status 状态端点。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServeRuntime, type ServeRuntime } from '../src/index.js';
import { addCronJob, loadCronJobs, saveCronJobs } from '../src/cron/store.js';

let tmpDir: string;
const runtimes: ServeRuntime[] = [];

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-serve-runtime-'));
  fs.writeFileSync(path.join(tmpDir, 'agent.db'), '');
  // 静态托管用假产物（仅断言豁免路径可达）
  fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>index ok</body></html>');
});

afterAll(async () => {
  for (const rt of runtimes) await rt.dispose().catch(() => undefined);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function start(opts: Parameters<typeof createServeRuntime>[0] = {}): Promise<ServeRuntime> {
  const rt = await createServeRuntime({
    cronHomeDir: tmpDir,
    skillsHomeDir: tmpDir,
    configHomeDir: tmpDir,
    dbPath: path.join(tmpDir, 'agent.db'),
    ...opts,
  });
  runtimes.push(rt);
  return rt;
}

const get = (port: number, p: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}${p}`, { headers }).then(async (res) => ({
    status: res.status,
    body: await res.json().catch(() => ({})),
  }));

describe('createServeRuntime', () => {
  it('port 0 → 实际端口回读；/api/projects 无鉴权可用（CLI 形态）', async () => {
    const rt = await start({ port: 0 });
    expect(rt.port).toBeGreaterThan(0);
    const res = await get(rt.port, '/api/projects');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('authToken：/api 无 token → 401；错 token → 401；对 token → 200', async () => {
    const rt = await start({ port: 0, authToken: 'secret-token' });
    expect((await get(rt.port, '/api/projects')).status).toBe(401);
    expect(
      (await get(rt.port, '/api/projects', { 'x-delta-auth': 'wrong' })).status,
    ).toBe(401);
    expect(
      (await get(rt.port, '/api/projects', { 'x-delta-auth': 'secret-token' })).status,
    ).toBe(200);
    // query 参数形态（EventSource / 下载链接用）
    const viaQuery = await fetch(
      `http://127.0.0.1:${rt.port}/api/projects?auth=secret-token`,
    );
    expect(viaQuery.status).toBe(200);
  });

  it('静态资源豁免鉴权（authToken 配置下 index.html 可直达）', async () => {
    const rt = await start({ port: 0, authToken: 'secret-token', webDistDir: tmpDir });
    const res = await fetch(`http://127.0.0.1:${rt.port}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('index');
  });

  it('dispose 幂等；释放后新连接被拒', async () => {
    const rt = await start({ port: 0 });
    const port = rt.port;
    await rt.dispose();
    await rt.dispose(); // 幂等
    await expect(get(port, '/api/projects')).rejects.toThrow();
  });
});

// ── F-22 收口（架构收口方案 T1）：cron 调度器随 serve 托管 ─────────────────────

/** 隔离的 cron home 目录（含 .delta） */
function cronHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delta-serve-cron-'));
  fs.mkdirSync(path.join(dir, '.delta'), { recursive: true });
  return dir;
}

/** 在隔离 home 下造一条已到期任务（nextRunAt 固定在过去，与真实时钟无关） */
function addDueJobAt(home: string, name = 'serve-due'): void {
  addCronJob({ name, cron: '30 8 * * *', prompt: 'x', cwd: home, from: new Date(2020, 0, 1) }, home);
  const { jobs } = loadCronJobs(home);
  jobs.find((j) => j.name === name)!.nextRunAt = '2020-01-01T00:00:00.000Z';
  saveCronJobs(jobs, home);
}

const fakeExecutor = (calls: string[]) => async (job: { name: string }) => {
  calls.push(job.name);
  return { status: 'completed' as const, exitCode: 0 };
};

describe('createServeRuntime cron 调度托管（F-22 收口）', () => {
  it('auto + cronExecutor：到期任务自动触发（不启动 delta cron daemon）；/api/status running=true', async () => {
    const home = cronHome();
    addDueJobAt(home);
    const calls: string[] = [];
    const rt = await start({ port: 0, cronHomeDir: home, cronExecutor: fakeExecutor(calls) });
    await vi.waitFor(() => expect(calls).toEqual(['serve-due']), { timeout: 1000 });
    const job = loadCronJobs(home).jobs[0]!;
    expect(job.lastRun!.trigger).toBe('schedule');
    expect(job.runningSince).toBeUndefined();
    const res = await get(rt.port, '/api/status');
    expect(res.status).toBe(200);
    expect(res.body.cron).toEqual({ running: true, mode: 'auto' });
    await rt.dispose();
  });

  it("cronScheduler: 'off'：不触发且 /api/status 返回 running=false（D3 硬断言）", async () => {
    const home = cronHome();
    addDueJobAt(home);
    const calls: string[] = [];
    const rt = await start({
      port: 0,
      cronHomeDir: home,
      cronScheduler: 'off',
      cronExecutor: fakeExecutor(calls),
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toEqual([]);
    expect(loadCronJobs(home).jobs[0]!.lastRun).toBeUndefined();
    const res = await get(rt.port, '/api/status');
    expect(res.body.cron).toEqual({ running: false, mode: 'off' });
    await rt.dispose();
  });

  it('DELTA_CRON_DISABLE_AUTOTICK=1：等同 off（用户显式跑 delta cron daemon 的场景）', async () => {
    process.env.DELTA_CRON_DISABLE_AUTOTICK = '1';
    try {
      const home = cronHome();
      addDueJobAt(home);
      const calls: string[] = [];
      const rt = await start({ port: 0, cronHomeDir: home, cronExecutor: fakeExecutor(calls) });
      await new Promise((r) => setTimeout(r, 300));
      expect(calls).toEqual([]);
      expect((await get(rt.port, '/api/status')).body.cron.running).toBe(false);
      await rt.dispose();
    } finally {
      delete process.env.DELTA_CRON_DISABLE_AUTOTICK;
    }
  });

  it('auto 但未注入 cronExecutor：不启动调度器（desktop 语义），/api/status running=false', async () => {
    const home = cronHome();
    addDueJobAt(home);
    const rt = await start({ port: 0, cronHomeDir: home });
    await new Promise((r) => setTimeout(r, 300));
    expect(loadCronJobs(home).jobs[0]!.lastRun).toBeUndefined();
    expect((await get(rt.port, '/api/status')).body.cron).toEqual({ running: false, mode: 'auto' });
    await rt.dispose();
  });

  it('进程内单例守卫：第二个 runtime 不重复起调度器（各自隔离 homeDir，仅第一个触发）', async () => {
    const homeA = cronHome();
    addDueJobAt(homeA, 'due-a');
    const homeB = cronHome();
    addDueJobAt(homeB, 'due-b');
    const calls: string[] = [];
    const rt1 = await start({ port: 0, cronHomeDir: homeA, cronExecutor: fakeExecutor(calls) });
    const rt2 = await start({ port: 0, cronHomeDir: homeB, cronExecutor: fakeExecutor(calls) });
    await vi.waitFor(() => expect(calls).toContain('due-a'), { timeout: 1000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(calls).not.toContain('due-b'); // 守卫生效：B 的调度器未启动
    await rt1.dispose();
    await rt2.dispose();
  });

  it('dispose 复位单例守卫：重建 runtime 后调度器可再次启动', async () => {
    const calls: string[] = [];
    const home1 = cronHome();
    addDueJobAt(home1, 'due-1');
    const rt1 = await start({ port: 0, cronHomeDir: home1, cronExecutor: fakeExecutor(calls) });
    await vi.waitFor(() => expect(calls).toContain('due-1'), { timeout: 1000 });
    await rt1.dispose();
    const home2 = cronHome();
    addDueJobAt(home2, 'due-2');
    const rt2 = await start({ port: 0, cronHomeDir: home2, cronExecutor: fakeExecutor(calls) });
    await vi.waitFor(() => expect(calls).toContain('due-2'), { timeout: 1000 });
    await rt2.dispose();
  });
});
