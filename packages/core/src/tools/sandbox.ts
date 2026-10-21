import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AgentError } from '@y-zero/shared';

/**
 * Path sandbox: every path parameter must resolve inside projectRoot.
 * Defends against `../` escapes, absolute-path injection and, for existing
 * files, symlink resolution leaving the sandbox.
 */
export async function resolveInSandbox(projectRoot: string, userPath: string): Promise<string> {
  if (typeof userPath !== 'string' || userPath.length === 0) {
    throw new AgentError('path is required', false);
  }
  const root = await fs.realpath(projectRoot).catch(() => path.resolve(projectRoot));
  const resolved = path.resolve(root, userPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new AgentError(`path escapes project sandbox: ${userPath}`, false);
  }
  // symlink check for existing segments
  const real = await fs.realpath(resolved).catch(() => undefined);
  if (real && real !== root && !real.startsWith(root + path.sep)) {
    throw new AgentError(`symlink target escapes project sandbox: ${userPath}`, false);
  }
  return resolved;
}

/** Default command whitelist — others require confirmation even in yolo. */
export const COMMAND_WHITELIST = [
  'node', 'npm', 'npx', 'pnpm', 'yarn', 'tsc', 'vitest', 'jest',
  'git', 'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'find', 'echo',
  'python3', 'python', 'pip', 'cargo', 'go', 'make', 'diff', 'sort', 'uniq',
];

export function isWhitelistedCommand(command: string): boolean {
  const bin = command.trim().split(/\s+/)[0] ?? '';
  return COMMAND_WHITELIST.includes(bin);
}
