import { describe, expect, it } from 'vitest';
import { detectShell, cmdAdapter, runWithShell } from '../src/engine/shell.js';

describe('ShellAdapter (M5 跨平台加固)', () => {
  it('darwin: $SHELL → /bin/zsh', () => {
    expect(detectShell('darwin', { SHELL: '/bin/bash' }).bin).toBe('/bin/bash');
    expect(detectShell('darwin', {}).bin).toBe('/bin/zsh');
    expect(detectShell('darwin', {}).args('ls -l')).toEqual(['-c', 'ls -l']);
  });

  it('linux/other: $SHELL → /bin/sh', () => {
    expect(detectShell('linux', { SHELL: '/bin/zsh' }).bin).toBe('/bin/zsh');
    expect(detectShell('linux', {}).bin).toBe('/bin/sh');
    expect(detectShell('other', {}).bin).toBe('/bin/sh');
  });

  it('win32: powershell adapter with cmd fallback available', () => {
    const ps = detectShell('win32', {});
    expect(ps.bin).toBe('powershell.exe');
    expect(ps.args('Get-ChildItem')).toEqual(['-NoProfile', '-Command', 'Get-ChildItem']);
    const cmd = cmdAdapter();
    expect(cmd.args('dir')).toEqual(['/d', '/s', '/c', 'dir']);
  });

  it('runs a real command through the platform adapter', async () => {
    const r = await runWithShell('echo yz-shell-ok', process.cwd(), 10_000, new AbortController().signal);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('yz-shell-ok');
  });

  it('propagates timeout flag on hanging command', async () => {
    const cmd = process.platform === 'win32' ? 'timeout /t 5' : 'sleep 5';
    const r = await runWithShell(cmd, process.cwd(), 300, new AbortController().signal);
    expect(r.timedOut).toBe(true);
  });
});
