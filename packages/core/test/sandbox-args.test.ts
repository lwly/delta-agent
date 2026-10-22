/**
 * T02 —— `docker run` 参数组装单测（设计 §5.2 的 24 段 argv 契约 / §14「args 16 例」）。
 *
 * 逐元素断言，不比对字符串（避免引号/空格歧义）。顺序即契约。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildDockerRunArgs,
  containerName,
  containerWorkdir,
  normalizeMountSource,
  redactArgv,
  relativeCwdOf,
  type DockerRunSpec,
} from '../src/sandbox/index.js';
import { makeResolvedConfig } from './helpers/fake-docker.js';

const PROJECT = '/Users/lwl/work/project/y-zero-agent';

function spec(overrides: Partial<DockerRunSpec> = {}): DockerRunSpec {
  const resolved = makeResolvedConfig({ mode: 'docker' }, { explicit: true });
  return {
    config: resolved.config,
    projectRoot: PROJECT,
    relativeCwd: '',
    command: 'pnpm test --coverage',
    containerName: 'yzero-1a2b3c4d-9f8e7d',
    labels: {
      session: '1a2b3c4d-1111-2222-3333-444455556666',
      project: 'proj-1',
      created: '2026-10-23T02:10:11.000Z',
    },
    hostEnv: { TZ: 'Asia/Shanghai' },
    ...overrides,
  };
}

describe('buildDockerRunArgs：完整 argv（§5.2 表 24 段）', () => {
  it('默认配置逐元素等于设计快照', () => {
    expect(buildDockerRunArgs(spec())).toEqual([
      'run',
      '--rm',
      '--name',
      'yzero-1a2b3c4d-9f8e7d',
      '--label',
      'yzero.session=1a2b3c4d-1111-2222-3333-444455556666',
      '--label',
      'yzero.project=proj-1',
      '--label',
      'yzero.created=2026-10-23T02:10:11.000Z',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--network',
      'none',
      '--memory',
      '2048m',
      '--memory-swap',
      '2048m',
      '--cpus',
      '2',
      '--pids-limit',
      '512',
      '--mount',
      `type=bind,source=${PROJECT},target=/workspace`,
      '--tmpfs',
      '/tmp',
      '--tmpfs',
      '/home/node',
      '--user',
      '1000:1000',
      '-e',
      'LANG=C.UTF-8',
      '-e',
      'TZ=Asia/Shanghai',
      '--workdir',
      '/workspace',
      '--entrypoint',
      '/bin/sh',
      'node:22-bookworm-slim',
      '-c',
      'pnpm test --coverage',
    ]);
  });

  it('返回数组而非字符串：命令只作为 -c 的第二个元素（无字符串拼接）', () => {
    const argv = buildDockerRunArgs(spec({ command: 'echo "$(id)" && ls' }));
    expect(Array.isArray(argv)).toBe(true);
    expect(argv.slice(-4)).toEqual(['/bin/sh', 'node:22-bookworm-slim', '-c', 'echo "$(id)" && ls']);
    // 命令原文只出现在一个元素里（没有被拼进 --mount / --label 等其它元素）
    expect(argv.filter((a) => a === 'echo "$(id)" && ls')).toHaveLength(1);
  });

  it('keepContainer=true：去掉 --rm', () => {
    const resolved = makeResolvedConfig({ mode: 'docker', keepContainer: true });
    const argv = buildDockerRunArgs(spec({ config: resolved.config }));
    expect(argv).not.toContain('--rm');
  });

  it('readOnlyRoot=false：去掉 --read-only（但仍保留 cap-drop / no-new-privileges）', () => {
    const resolved = makeResolvedConfig({ mode: 'docker', readOnlyRoot: false });
    const argv = buildDockerRunArgs(spec({ config: resolved.config }));
    expect(argv).not.toContain('--read-only');
    expect(argv).toContain('--cap-drop');
    expect(argv).toContain('no-new-privileges');
  });

  it('user=null：整段 --user 省略（自定义镜像用镜像默认用户）', () => {
    const resolved = makeResolvedConfig({ mode: 'docker', image: 'my/custom:1' });
    expect(resolved.config.user).toBeNull();
    const argv = buildDockerRunArgs(spec({ config: resolved.config }));
    expect(argv).not.toContain('--user');
    expect(argv).toContain('my/custom:1');
  });

  it('network=bridge 生效', () => {
    const resolved = makeResolvedConfig({ mode: 'docker', network: 'bridge' });
    const argv = buildDockerRunArgs(spec({ config: resolved.config }));
    const i = argv.indexOf('--network');
    expect(argv[i + 1]).toBe('bridge');
  });

  it('资源上限按 MB / cpus / pids 格式化', () => {
    const resolved = makeResolvedConfig({ mode: 'docker', memoryMb: 512, cpus: 1.5, pidsLimit: 64 });
    const argv = buildDockerRunArgs(spec({ config: resolved.config }));
    expect(argv[argv.indexOf('--memory') + 1]).toBe('512m');
    expect(argv[argv.indexOf('--memory-swap') + 1]).toBe('512m');
    expect(argv[argv.indexOf('--cpus') + 1]).toBe('1.5');
    expect(argv[argv.indexOf('--pids-limit') + 1]).toBe('64');
  });

  it('tmpfs 逐项产出', () => {
    const resolved = makeResolvedConfig({ mode: 'docker', tmpfs: ['/tmp', '/run'] });
    const argv = buildDockerRunArgs(spec({ config: resolved.config }));
    expect(argv.join('\u0000')).toContain('--tmpfs\u0000/tmp\u0000--tmpfs\u0000/run');
  });

  it('env 白名单：只对宿主确实存在的变量产出 `-e NAME`（值绝不进 argv）', () => {
    const resolved = makeResolvedConfig({ mode: 'docker', env: ['CI', 'MISSING_VAR', 'NPM_TOKEN'] });
    const argv = buildDockerRunArgs(
      spec({ config: resolved.config, hostEnv: { TZ: 'UTC', CI: 'true', NPM_TOKEN: 'secret-value' } }),
    );
    const envPairs = argv.reduce<string[]>((acc, a, i) => (a === '-e' ? [...acc, argv[i + 1]!] : acc), []);
    expect(envPairs).toContain('CI');
    expect(envPairs).toContain('NPM_TOKEN');
    expect(envPairs).not.toContain('MISSING_VAR');
    // 关键：argv 里没有密钥值
    expect(argv.join(' ')).not.toContain('secret-value');
  });

  it('TZ 缺省时回退 Intl 时区（形如 Area/City 或 UTC）', () => {
    const argv = buildDockerRunArgs(spec({ hostEnv: {} }));
    const tz = argv[argv.indexOf('-e', argv.indexOf('LANG=C.UTF-8')) + 1];
    expect(tz).toMatch(/^TZ=\S+$/);
  });

  it('容器内工作目录随相对 cwd 变化', () => {
    const argv = buildDockerRunArgs(spec({ relativeCwd: 'packages/core' }));
    expect(argv[argv.indexOf('--workdir') + 1]).toBe('/workspace/packages/core');
  });
});

describe('containerWorkdir / relativeCwdOf / normalizeMountSource', () => {
  it("containerWorkdir: '' → /workspace，'a/b' → /workspace/a/b", () => {
    expect(containerWorkdir('')).toBe('/workspace');
    expect(containerWorkdir('.')).toBe('/workspace');
    expect(containerWorkdir('a/b')).toBe('/workspace/a/b');
  });

  it("containerWorkdir: 含 '..' / 绝对路径 → throw", () => {
    expect(() => containerWorkdir('../etc')).toThrow(/\.\./);
    expect(() => containerWorkdir('/etc')).toThrow(/绝对路径/);
  });

  it("relativeCwdOf: 根 → ''，子目录 → POSIX 相对路径，逃逸 → throw", () => {
    expect(relativeCwdOf(PROJECT, PROJECT)).toBe('');
    expect(relativeCwdOf(PROJECT, path.join(PROJECT, 'packages', 'core'))).toBe('packages/core');
    expect(() => relativeCwdOf(PROJECT, path.join(PROJECT, '..', 'other'))).toThrow(/项目根之外/);
  });

  it('normalizeMountSource: win32 反斜杠归一 + 盘符大写', () => {
    expect(normalizeMountSource('c:\\Users\\lwl\\proj', 'win32')).toBe('C:/Users/lwl/proj');
    expect(normalizeMountSource('/Users/lwl/proj', 'darwin')).toBe('/Users/lwl/proj');
  });

  it('normalizeMountSource: 含逗号/引号/换行 → throw（文案可读）', () => {
    expect(() => normalizeMountSource('/a,b/c')).toThrow(/不支持的字符/);
    expect(() => normalizeMountSource('/a"b')).toThrow(/不支持的字符/);
    expect(() => normalizeMountSource('/a\nb')).toThrow(/不支持的字符/);
  });
});

describe('containerName / redactArgv', () => {
  it('containerName: yzero-<sid8>-<rand6>', () => {
    expect(containerName('1a2b3c4d-1111-2222', '9f8e7d')).toBe('yzero-1a2b3c4d-9f8e7d');
    expect(containerName('1a2b3c4d-1111-2222')).toMatch(/^yzero-1a2b3c4d-[0-9a-f]{6}$/);
    expect(containerName('')).toMatch(/^yzero-session0-[0-9a-f]{6}$/);
  });

  it('redactArgv: -e NAME=VALUE → -e NAME=***，-e NAME 原样保留', () => {
    expect(redactArgv(['-e', 'FOO=secret', '-e', 'BAR', 'run'])).toEqual([
      '-e',
      'FOO=***',
      '-e',
      'BAR',
      'run',
    ]);
  });

  it('源码护栏：args.ts / executor.ts 中不得出现 shell: true', () => {
    const files = ['args.ts', 'executor.ts'].map((f) =>
      fs.readFileSync(new URL(`../src/sandbox/${f}`, import.meta.url), 'utf8'),
    );
    for (const src of files) {
      expect(src).not.toMatch(/shell:\s*true/);
    }
  });
});
