import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { createServeRuntime } from '../src/server/runtime.js';
import {
  builtinTools,
  createPluginHost,
  createServiceHost,
  loadPlugins,
  registeredEngineIds,
  resetViewMetasForTests,
  resolveEngine,
  viewContributionMetas,
} from '../src/plugins/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { RouteDef } from '../src/server/routes.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetViewMetasForTests();
});

function fixtureHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'yz-plugin-chain-'));
  dirs.push(home);
  return home;
}

describe('P6 plugin host six slots', () => {
  it('trusted activate 可登记路由、工具、引擎、服务、视图元数据', async () => {
    const home = fixtureHome();
    const userDir = path.join(home, 'plugins');
    const pluginDir = path.join(userDir, 'full');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(pluginDir, 'delta.plugin.json'), JSON.stringify({ id: 'full', main: 'index.js' }));
    writeFileSync(
      path.join(pluginDir, 'index.js'),
      `export async function activate(host) {
  host.registerRoute({
    method: 'GET',
    pattern: 'api/_plugin_full',
    auth: 'token',
    handler: async ({ res }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    },
  });
  host.registerTool({
    name: 'plugin_ping',
    description: 'p',
    schema: { type: 'object', properties: {} },
    danger: 'safe',
    execute: async () => ({ callId: '', name: 'plugin_ping', ok: true, content: 'pong' }),
  });
  async function* demoEngine() { yield { type: 'done', reason: 'stop' }; }
  host.registerEngine('plugin-demo-engine', demoEngine);
  host.registerService({ id: 'plugin-svc', start() {}, stop() {} });
  host.registerView({ name: 'plugin-page', path: '/plugin-page', slot: 'top', module: 'file:///noop.vue' });
}`,
    );
    writeFileSync(path.join(home, 'trust.json'), JSON.stringify({ trusted: ['full'] }));

    const routes: RouteDef[] = [];
    const services = createServiceHost();
    const loaded = await loadPlugins({ userDir, trustFile: path.join(home, 'trust.json') }, {
      host: createPluginHost({
        routes,
        registerService: (s) => services.add(s),
      }),
    });
    expect(loaded[0]?.status).toBe('loaded');
    expect(routes).toHaveLength(1);
    expect(builtinTools().some((t) => t.name === 'plugin_ping')).toBe(true);
    expect(registeredEngineIds()).toContain('plugin-demo-engine');
    expect(resolveEngine('plugin-demo-engine')).toBeDefined();
    expect(() => services.add({ id: 'plugin-svc', start() {}, stop() {} })).toThrow(/already registered/);
    expect(viewContributionMetas().map((v) => v.name)).toContain('plugin-page');
    expect(new ToolRegistry().names()).toContain('plugin_ping');
  });

  it('serve 链路合并插件路由并可 GET /api/plugins', async () => {
    const home = fixtureHome();
    const userDir = path.join(home, 'plugins');
    const pluginDir = path.join(userDir, 'serve');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(pluginDir, 'delta.plugin.json'), JSON.stringify({ id: 'serve', main: 'index.js' }));
    writeFileSync(
      path.join(pluginDir, 'index.js'),
      `export function activate(host) {
  host.registerRoute({
    method: 'GET',
    pattern: 'api/_plugin_serve',
    auth: 'none',
    handler: async ({ res }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ via: 'plugin' }));
    },
  });
}`,
    );
    writeFileSync(path.join(home, 'trust.json'), JSON.stringify({ trusted: ['serve'] }));

    writeFileSync(path.join(home, 'agent.db'), '');
    const rt = await createServeRuntime({
      port: 0,
      dbPath: path.join(home, 'agent.db'),
      cronHomeDir: home,
      skillsHomeDir: home,
      configHomeDir: home,
      plugins: { userDir, trustFile: path.join(home, 'trust.json') },
    });
    try {
      const ping = await fetch(`http://127.0.0.1:${rt.port}/api/_plugin_serve`);
      expect(ping.status).toBe(200);
      expect(await ping.json()).toEqual({ via: 'plugin' });

      const meta = await fetch(`http://127.0.0.1:${rt.port}/api/plugins`);
      expect(meta.status).toBe(200);
      const body = (await meta.json()) as { plugins: Array<{ id: string; status: string }> };
      expect(body.plugins.some((p) => p.id === 'serve' && p.status === 'loaded')).toBe(true);
    } finally {
      await rt.dispose();
    }
  });
});
