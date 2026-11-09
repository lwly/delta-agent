import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionService } from '../src/session/service.js';
import { SessionHub, createWebServer } from '../src/server/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { appendRoutes, type RouteDef } from '../src/server/routes.js';

function serverWith(routes: RouteDef[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-plugin-routes-'));
  const service = new SessionService(path.join(dir, 'db.sqlite'));
  const hub = new SessionHub({
    service,
    registry: new ToolRegistry(),
    resolveProvider: async () => {
      throw new Error('unused');
    },
  });
  const server = createWebServer({ service, hub, port: 0, routes });
  return { dir, service, server };
}

describe('plugin routes', () => {
  const servers: Array<ReturnType<typeof serverWith>> = [];
  afterEach(() => {
    for (const s of servers.splice(0)) {
      s.server.close();
      s.service.close();
      fs.rmSync(s.dir, { recursive: true, force: true });
    }
  });

  it('贡献路由可访问，重复 pattern 与缺 auth 在构造期抛错', async () => {
    const routes: RouteDef[] = [{
      method: 'GET',
      pattern: 'api/plugin-ping',
      auth: 'token',
      handler: async ({ res }) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
    }];
    const started = serverWith(routes);
    servers.push(started);
    await new Promise<void>((resolve) => started.server.listen(0, '127.0.0.1', resolve));
    const addr = started.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/api/plugin-ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const table: RouteDef[] = [{ ...routes[0]! }];
    expect(() => appendRoutes(table, routes)).toThrow(/already registered: GET api\/plugin-ping/);
    expect(() => serverWith([{ method: 'GET', pattern: 'api/plugin-noauth', auth: undefined as unknown as 'token', handler: async () => undefined }])).toThrow(/未声明 auth/);
  });
});
