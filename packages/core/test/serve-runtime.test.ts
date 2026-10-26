/**
 * serve 运行时组装工厂单测（桌面宿主复用的核心装配点）：
 *  - port 0 → 实际端口回读；
 *  - authToken 鉴权：/api/* 无 token / 错 token → 401，对 token → 200（恒定时间比较路径）；
 *  - 静态资源豁免鉴权（BrowserWindow 资产请求不带凭据）；
 *  - dispose 幂等且释放后连接被拒。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServeRuntime, type ServeRuntime } from '../src/index.js';

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
