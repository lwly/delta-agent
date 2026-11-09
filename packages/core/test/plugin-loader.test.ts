import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { loadPlugins } from '../src/plugins/loader.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete (globalThis as { __deltaPlugin?: string }).__deltaPlugin;
});

function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'yz-plugins-'));
  dirs.push(dir);
  return dir;
}

function plugin(dir: string, name: string, manifest: unknown, main?: string): void {
  const pluginDir = path.join(dir, name);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(path.join(pluginDir, 'delta.plugin.json'), JSON.stringify(manifest));
  if (main != null) writeFileSync(path.join(pluginDir, 'index.js'), main);
}

describe('loadPlugins', () => {
  it('未信任不加载，信任后加载，失败的插件不影响其余', async () => {
    const home = root();
    const userDir = path.join(home, 'plugins');
    const trustFile = path.join(home, 'plugin-trust.json');
    plugin(userDir, 'skip', { id: 'skip', main: 'index.js' }, 'globalThis.__deltaPlugin = "skip";\n');
    plugin(userDir, 'ok', { id: 'ok', main: 'index.js' }, 'globalThis.__deltaPlugin = "ok";\n');
    plugin(userDir, 'bad', { id: 'bad', main: 'index.js' }, 'throw new Error("boom");\n');
    plugin(userDir, 'pack', { id: 'pack' });
    writeFileSync(trustFile, JSON.stringify({ trusted: ['ok', 'bad'] }));

    const loaded = await loadPlugins({ userDir, trustFile });
    const byId = Object.fromEntries(loaded.map((p) => [p.id, p.status]));
    expect(byId).toMatchObject({ skip: 'untrusted', ok: 'loaded', bad: 'error', pack: 'content' });
    expect(loaded.find((p) => p.id === 'bad')?.error).toMatch(/boom/);
    expect((globalThis as { __deltaPlugin?: string }).__deltaPlugin).toBe('ok');
  });

  it('同 id 时项目级覆盖用户级，用户级 main 不执行', async () => {
    const home = root();
    const userDir = path.join(home, 'user');
    const projectDir = path.join(home, 'project');
    const trustFile = path.join(home, 'trust.json');
    plugin(userDir, 'a', { id: 'same', main: 'index.js' }, 'globalThis.__deltaPlugin = "user";\n');
    plugin(projectDir, 'a', { id: 'same', main: 'index.js' }, 'globalThis.__deltaPlugin = "project";\n');
    writeFileSync(trustFile, JSON.stringify({ trusted: ['same'] }));

    const loaded = await loadPlugins({ userDir, projectDir, trustFile });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: 'same', layer: 'project', status: 'loaded' });
    expect((globalThis as { __deltaPlugin?: string }).__deltaPlugin).toBe('project');
  });

  it('main 逃出插件目录则不加载', async () => {
    const home = root();
    const userDir = path.join(home, 'plugins');
    plugin(userDir, 'escape', { id: 'escape', main: '../outside.js' });
    const loaded = await loadPlugins({ userDir, trustFile: path.join(home, 'missing.json') });
    expect(loaded[0]).toMatchObject({ id: 'escape', status: 'error' });
    expect(loaded[0]?.error).toMatch(/超出插件目录/);
  });
});
