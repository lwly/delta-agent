import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createPluginHost, loadPlugins } from '../src/plugins/index.js';
import type { RouteDef } from '../src/server/routes.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('plugin activate', () => {
  it('activate 可登记 HTTP 路由', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'yz-plugin-act-'));
    dirs.push(home);
    const userDir = path.join(home, 'plugins');
    const pluginDir = path.join(userDir, 'demo');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(pluginDir, 'delta.plugin.json'), JSON.stringify({ id: 'demo', main: 'index.js' }));
    writeFileSync(
      path.join(pluginDir, 'index.js'),
      `export function activate(host) {
  host.registerRoute({
    method: 'GET',
    pattern: 'api/_plugin_demo',
    auth: 'token',
    handler: async ({ res }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ plugin: 'demo' }));
    },
  });
}`,
    );
    writeFileSync(path.join(home, 'trust.json'), JSON.stringify({ trusted: ['demo'] }));

    const routes: RouteDef[] = [];
    const loaded = await loadPlugins({ userDir, trustFile: path.join(home, 'trust.json') }, {
      host: createPluginHost({ routes }),
    });
    expect(loaded[0]?.status).toBe('loaded');
    expect(routes).toHaveLength(1);
    expect(routes[0]?.pattern).toBe('api/_plugin_demo');
  });
});
