import { describe, expect, it } from 'vitest';
import {
  detectShell,
  cmdAdapter,
  pwshAdapter,
  resolveWin32Shell,
  runWithShell,
  decodeShellOutput,
} from '../src/engine/shell.js';
import type { ShellAdapter } from '../src/engine/shell.js';

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
    // 预置 UTF-8 输出编码，避免中文系统（cp936）双层乱码
    expect(ps.args('Get-ChildItem')).toEqual([
      '-NoProfile',
      '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-ChildItem',
    ]);
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

  it('pwsh adapter: 原生支持 && 管道链，UTF-8 预置同 PS 5.1', () => {
    const pwsh = pwshAdapter();
    expect(pwsh.bin).toBe('pwsh.exe');
    expect(pwsh.platform).toBe('win32');
    expect(pwsh.label).toBe('pwsh');
    expect(pwsh.args('Get-ChildItem')).toEqual([
      '-NoProfile',
      '-Command',
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-ChildItem',
    ]);
  });

  it('resolveWin32Shell：无 pwsh 的平台回退 powershell.exe 5.1，且进程级缓存', async () => {
    // CI（macOS/linux）没有 where.exe / pwsh → 回退 PS 5.1；Windows 上若装了
    // pwsh 则返回 pwshAdapter——两种结果都合法，只断言缓存与 win32 语义。
    const a = await resolveWin32Shell();
    const b = await resolveWin32Shell();
    expect(b).toBe(a); // 缓存：两次调用同一实例
    expect(a.platform).toBe('win32');
    expect(['pwsh', 'powershell']).toContain(a.label);
  });
});

describe('decodeShellOutput (Windows 控制台乱码修复)', () => {
  it('合法 UTF-8 原样解码（不受平台影响）', () => {
    const utf8 = Buffer.from('中文输出', 'utf8');
    expect(decodeShellOutput(utf8, 'win32')).toBe('中文输出');
    expect(decodeShellOutput(utf8, 'darwin')).toBe('中文输出');
  });

  it('GBK 字节在 win32 按 gb18030 解码，不产生 replacement char', () => {
    // "中文" 的 GBK 编码：中=D6D0，文=CEC4
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeShellOutput(gbk, 'win32')).toBe('中文');
  });

  it('GBK 字节在非 win32 维持 UTF-8 宽松解码（替换字符）', () => {
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
    expect(decodeShellOutput(gbk, 'darwin')).not.toBe('中文');
    expect(decodeShellOutput(gbk, 'darwin')).toContain('\uFFFD');
  });

  it('空 Buffer 返回空串', () => {
    expect(decodeShellOutput(Buffer.alloc(0), 'win32')).toBe('');
  });

  it('run_command 走 win32 适配器时 GBK 输出可读（端到端）', async () => {
    // 用 node 子进程模拟一个按 GBK 输出的程序；fake adapter 标记为 win32
    const adapter: ShellAdapter = {
      platform: 'win32',
      bin: process.execPath,
      args: (c) => ['-e', c],
      label: 'node-fake-win32',
    };
    const r = await runWithShell(
      'process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4]))',
      process.cwd(),
      10_000,
      new AbortController().signal,
      adapter,
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('中文');
  });
});

describe('spawnOnce kill 后强制收尾（问题4修复）', () => {
  it('kill 后孙进程持有 stdout 管道：宽限期后强制 resolve，槽位不泄漏', async () => {
    if (process.platform === 'win32') return; // 场景构造依赖 POSIX shell
    // 后台 sleep 继承 stdout：直接子进程被 SIGKILL 后，close 事件被孙进程卡住 ~4s；
    // 强制收尾宽限期 300ms → 应在 ~500ms 内拿到已收集的部分输出
    const start = Date.now();
    const r = await runWithShell(
      'echo grandchild-marker; sleep 4',
      process.cwd(),
      150,
      new AbortController().signal,
      undefined,
      300,
    );
    const elapsed = Date.now() - start;
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toContain('grandchild-marker');
    expect(elapsed).toBeLessThan(2_500);
  });

  it('正常命令不受强制收尾影响（close 先于宽限期触发）', async () => {
    const r = await runWithShell(
      'echo normal-ok',
      process.cwd(),
      10_000,
      new AbortController().signal,
      undefined,
      300,
    );
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout.trim()).toBe('normal-ok');
  });
});
