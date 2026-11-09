/**
 * P4 命令槽。内置子命令在 builtin-commands/mount.ts 登记；插件经 registerCommand 追加。
 * 这里只接收额外命令，并在 parse 前挂到同一个 program。
 */
import type { Command } from 'commander';

export interface CommandContribution {
  name: string;
  mount(program: Command): void;
}

const commands: CommandContribution[] = [];

export function registerCommand(command: CommandContribution): void {
  if (commands.some((c) => c.name === command.name)) {
    throw new Error(`command already registered: ${command.name}`);
  }
  commands.push(command);
}

export function commandNames(): string[] {
  return commands.map((c) => c.name);
}

export function registeredCommandIds(): readonly string[] {
  return commands.map((c) => c.name);
}

export function mountCommands(program: Command): void {
  const taken = new Set(program.commands.map((c) => c.name()));
  for (const command of commands) {
    if (taken.has(command.name)) throw new Error(`command already registered: ${command.name}`);
    command.mount(program);
    taken.add(command.name);
  }
}
