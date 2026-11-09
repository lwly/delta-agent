import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { commandNames, mountCommands, registerCommand } from '../src/commands.js';

describe('command slot', () => {
  it('挂到 program，重复名抛错', () => {
    registerCommand({
      name: 'ping-slot',
      mount(program) {
        program.command('ping-slot').action(() => undefined);
      },
    });
    expect(commandNames()).toContain('ping-slot');
    expect(() => registerCommand({ name: 'ping-slot', mount() {} })).toThrow(/already registered: ping-slot/);

    const program = new Command();
    program.command('run');
    mountCommands(program);
    expect(program.commands.map((c) => c.name())).toContain('ping-slot');

    const clash = new Command();
    clash.command('ping-slot');
    expect(() => mountCommands(clash)).toThrow(/already registered: ping-slot/);
  });
});
