/**
 * CLI 进程内插件：与 serve 共用 loadPlugins；可额外 registerCommand。
 */
import * as path from 'node:path';
import { createPluginHost, loadPlugins } from '@delta/core/plugins';
import { FILES, projectConfigDir, userConfigDir } from '@delta/core/paths';
import { registerCommand } from './commands.js';

export async function loadCliPlugins(cwd = process.cwd()): Promise<void> {
  await loadPlugins(
    {
      userDir: path.join(userConfigDir(), FILES.pluginsDir),
      projectDir: path.join(projectConfigDir(cwd), FILES.pluginsDir),
      trustFile: path.join(userConfigDir(), FILES.pluginTrust),
    },
    {
      host: createPluginHost({
        registerCommand: (command) => registerCommand(command),
      }),
    },
  );
}
