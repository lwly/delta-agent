import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { createPluginHost, loadPlugins } from '@delta/core/plugins';
import { commandNames, mountCommands, registerCommand } from '../src/commands.js';

const dirs: string[] = [];
let userConfig = '';
let trustFile = '';

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  userConfig = '';
  trustFile = '';
});

describe('P6 CLI plugin commands', () => {
  it('trusted activate 可 registerCommand 并经 mountCommands 挂到 program', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'yz-cli-plugin-'));
    dirs.push(home);
    userConfig = path.join(home, 'delta');
    mkdirSync(userConfig, { recursive: true });
    const userDir = path.join(userConfig, 'plugins');
    const pluginDir = path.join(userDir, 'cmd');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(pluginDir, 'delta.plugin.json'), JSON.stringify({ id: 'cmd', main: 'index.js' }));
    writeFileSync(
      path.join(pluginDir, 'index.js'),
      `export function activate(host) {
  host.registerCommand({
    name: 'plugin-hello-p6',
    mount(program) {
      program.command('plugin-hello-p6').action(() => undefined);
    },
  });
}`,
    );
    trustFile = path.join(userConfig, 'plugin-trust.json');
    writeFileSync(trustFile, JSON.stringify({ trusted: ['cmd'] }));

    const seen: string[] = [];
    await loadPlugins({ userDir, trustFile }, {
      host: createPluginHost({
        registerCommand: (c) => {
          registerCommand(c);
          seen.push(c.name);
        },
      }),
    });
    expect(seen).toEqual(['plugin-hello-p6']);
    expect(commandNames()).toContain('plugin-hello-p6');

    const program = new Command();
    program.command('run');
    mountCommands(program);
    expect(program.commands.map((c) => c.name())).toContain('plugin-hello-p6');
  });
});
