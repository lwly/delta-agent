import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveInSandbox, isWhitelistedCommand } from '../src/tools/sandbox.js';

let tmpRoot = '';
beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-sandbox-'));
  await fs.mkdir(path.join(tmpRoot, 'src'));
  await fs.writeFile(path.join(tmpRoot, 'src', 'a.ts'), 'export {}');
});
afterAll(async () => {
  await fs.rm(path.dirname(tmpRoot), { recursive: true, force: true }).catch(() => undefined);
});

describe('resolveInSandbox', () => {
  it('allows paths inside the project root', async () => {
    const p = await resolveInSandbox(tmpRoot, 'src/a.ts');
    expect(p.endsWith(path.join('src', 'a.ts'))).toBe(true);
  });

  it('allows the root itself', async () => {
    await expect(resolveInSandbox(tmpRoot, '.')).resolves.toBeTruthy();
  });

  it('rejects ../ escapes', async () => {
    await expect(resolveInSandbox(tmpRoot, '../outside.txt')).rejects.toThrow(/escapes project sandbox/);
  });

  it('rejects deep ../ escapes', async () => {
    await expect(resolveInSandbox(tmpRoot, 'src/../../evil.txt')).rejects.toThrow(/escapes project sandbox/);
  });

  it('rejects absolute paths outside the root', async () => {
    await expect(resolveInSandbox(tmpRoot, '/etc/passwd')).rejects.toThrow(/escapes project sandbox/);
  });

  it('rejects absolute path that resolves inside only via trickery', async () => {
    // absolute path equal to root is fine; /etc is not
    await expect(resolveInSandbox(tmpRoot, '/tmp')).rejects.toThrow();
  });

  it('rejects symlinks pointing outside the sandbox', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-outside-'));
    await fs.writeFile(path.join(outside, 'secret.txt'), 'x');
    const link = path.join(tmpRoot, 'leak');
    await fs.symlink(outside, link);
    await expect(resolveInSandbox(tmpRoot, 'leak/secret.txt')).rejects.toThrow(/symlink target escapes/);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it('rejects empty paths', async () => {
    await expect(resolveInSandbox(tmpRoot, '')).rejects.toThrow();
  });
});

describe('isWhitelistedCommand', () => {
  it('accepts whitelisted binaries', () => {
    expect(isWhitelistedCommand('git status')).toBe(true);
    expect(isWhitelistedCommand('npm test')).toBe(true);
  });
  it('rejects non-whitelisted binaries', () => {
    expect(isWhitelistedCommand('curl http://evil')).toBe(false);
    expect(isWhitelistedCommand('rm -rf /')).toBe(false);
  });
});
