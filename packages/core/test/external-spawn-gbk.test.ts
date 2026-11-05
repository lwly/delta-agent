/**
 * F-56 spawn 行解码单测（Windows 中文环境实测问题）：
 * 子进程输出 GBK 字节（中文 Windows cmd shim / 控制台错误按 cp936 写出）时，
 * UTF-8 严格解码出现 U+FFFD → 自动回退 GBK 解码；合法 UTF-8 输出不受影响。
 */
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnExternal } from '../src/external/spawn.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const NODE = process.execPath;

async function collectLines(command: string, args: string[]): Promise<{ lines: string[]; exitCode: number | null }> {
  const ac = new AbortController();
  const proc = spawnExternal({ command, args, cwd: process.cwd(), envWhitelist: [], signal: ac.signal });
  const lines: string[] = [];
  let exitCode: number | null = null;
  for await (const ev of proc.events) {
    // stdout 与 stderr 都经 attachLineSplitter 解码（stderr 走 stderr_line 事件）
    if (ev.type === 'line' || ev.type === 'stderr_line') lines.push(ev.text);
    else if (ev.type === 'exit') exitCode = ev.code;
  }
  await proc.cancel();
  return { lines, exitCode };
}

describe('spawn 行解码（F-56：GBK 回退）', () => {
  it('GBK 字节输出 → 正确解码中文（UTF-8 硬解必出 U+FFFD 的场景）', async () => {
    const { lines, exitCode } = await collectLines(NODE, [path.join(FIXTURES, 'gbk-out.mjs')]);
    expect(exitCode).toBe(1);
    expect(lines.join('\n')).toContain('不是内部或外部命令，也不是可运行的程序');
    expect(lines.join('\n')).not.toContain('\uFFFD');
  });

  it('合法 UTF-8 输出 → 原样解码（正常路径零影响）', async () => {
    const { lines, exitCode } = await collectLines(NODE, [path.join(FIXTURES, 'version-cli.mjs'), '1.2.3-utf8-✓']);
    expect(exitCode).toBe(0);
    expect(lines[0]).toBe('1.2.3-utf8-✓');
  });
});
