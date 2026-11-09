/**
 * P6 E2E 用进程内插件目录：CLI registerCommand + serve 路由 + 视图元数据。
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';

/**
 * @param {string} home 用户配置根（~/.delta 等价目录）
 * @returns {Promise<{ userDir: string; trustFile: string }>}
 */
export async function installE2ePluginFixture(home) {
  const userDir = path.join(home, 'plugins');
  const cmdDir = path.join(userDir, 'e2e-cmd');
  const serveDir = path.join(userDir, 'e2e-serve');
  await fsp.mkdir(cmdDir, { recursive: true });
  await fsp.mkdir(serveDir, { recursive: true });

  await fsp.writeFile(
    path.join(cmdDir, 'delta.plugin.json'),
    JSON.stringify({ id: 'e2e-cmd', main: 'index.js' }),
  );
  await fsp.writeFile(
    path.join(cmdDir, 'index.js'),
  `export function activate(host) {
  host.registerCommand({
    name: 'plugin-e2e-hello',
    mount(program) {
      program
        .command('plugin-e2e-hello')
        .description('E2E 插件子命令')
        .action(() => console.log('PLUGIN_E2E_HELLO'));
    },
  });
}`,
  );

  await fsp.writeFile(
    path.join(serveDir, 'delta.plugin.json'),
    JSON.stringify({ id: 'e2e-serve', main: 'index.js' }),
  );
  await fsp.writeFile(
    path.join(serveDir, 'index.js'),
  `export function activate(host) {
  host.registerRoute({
    method: 'GET',
    pattern: 'api/_e2e_plugin',
    auth: 'none',
    handler: async ({ res }) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, via: 'plugin' }));
    },
  });
  host.registerView({
    name: 'plugin-e2e-view',
    path: '/plugin-e2e-view',
    slot: 'top',
    module: '/e2e-plugin-view.mjs',
  });
}`,
  );

  const trustFile = path.join(home, 'plugin-trust.json');
  await fsp.writeFile(trustFile, JSON.stringify({ trusted: ['e2e-cmd', 'e2e-serve'] }));
  return { userDir, trustFile };
}
