/**
 * T01 —— 沙箱配置体系单测（设计 §3 / §14「配置 24 例」）。
 *
 * 覆盖：两级 merge / 缺省与来源 / 非法值降级 / user↔image 联动 / 敏感键硬拒 /
 *      enforce 偏序（只能更严）/ 工作区根守卫。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertSafeWorkspaceRoot,
  checkEnforce,
  loadSandboxConfig,
  mergeSandboxLayers,
  normalizeSandboxLayer,
  updateUserSandboxMode,
  DEFAULT_SANDBOX_CONFIG,
  DEFAULT_SANDBOX_IMAGE,
  SandboxPathError,
  type SandboxConfigError,
  type SandboxConfigWarning,
} from '../src/sandbox/index.js';

let home = '';
let project = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-sandbox-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-sandbox-proj-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

function writeConfig(scope: 'user' | 'project', content: string): void {
  const dir = scope === 'user' ? path.join(home, '.delta') : path.join(project, '.delta');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sandbox.json'), content, 'utf8');
}

function load(session?: Parameters<typeof loadSandboxConfig>[0]['session']) {
  return loadSandboxConfig({ projectRoot: project, homeDir: home, session });
}

/** 只跑一层归一化（校验表用例的便捷入口）。 */
function normalize(raw: unknown) {
  const warnings: SandboxConfigWarning[] = [];
  const errors: SandboxConfigError[] = [];
  const layer = normalizeSandboxLayer(raw, 'project', warnings, errors);
  return { layer, warnings, errors };
}

// ── merge 与默认值 ──────────────────────────────────────────────────────────

describe('配置 merge 与来源', () => {
  it('无任何配置文件：全默认、explicit=false、无 warning/error', () => {
    const r = load();
    expect(r.config).toEqual(DEFAULT_SANDBOX_CONFIG);
    expect(r.explicit).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('只有项目文件设 image：其余字段仍是全局默认', () => {
    writeConfig('project', JSON.stringify({ image: 'node:20-bookworm-slim' }));
    const r = load();
    expect(r.config.image).toBe('node:20-bookworm-slim');
    expect(r.config.memoryMb).toBe(DEFAULT_SANDBOX_CONFIG.memoryMb);
    expect(r.config.network).toBe('none');
    expect(r.provenance.image).toBe('project');
    expect(r.provenance.memoryMb).toBe('default');
    expect(r.explicit).toBe(true);
  });

  it('AC-30-8：全局设 memoryMb + 项目只设 image → 逐字段 merge（memoryMb 仍来自全局）', () => {
    writeConfig('user', JSON.stringify({ memoryMb: 1024 }));
    writeConfig('project', JSON.stringify({ image: 'node:20-bookworm-slim' }));
    const r = load();
    expect(r.config.memoryMb).toBe(1024);
    expect(r.provenance.memoryMb).toBe('user');
    expect(r.config.image).toBe('node:20-bookworm-slim');
    expect(r.provenance.image).toBe('project');
  });

  it('项目层覆盖全局同名字段', () => {
    writeConfig('user', JSON.stringify({ memoryMb: 1024, network: 'bridge' }));
    writeConfig('project', JSON.stringify({ memoryMb: 4096 }));
    const r = load();
    expect(r.config.memoryMb).toBe(4096);
    expect(r.provenance.memoryMb).toBe('project');
    expect(r.config.network).toBe('bridge');
    expect(r.provenance.network).toBe('user');
  });

  it('会话覆盖优先于项目层（mode / network）', () => {
    writeConfig('project', JSON.stringify({ mode: 'docker', network: 'none' }));
    const r = load({ mode: 'docker', network: 'bridge' });
    expect(r.config.mode).toBe('docker');
    expect(r.provenance.mode).toBe('session');
    expect(r.config.network).toBe('bridge');
    expect(r.provenance.network).toBe('session');
  });

  it('空文件：warning 但沿用默认配置', () => {
    writeConfig('project', '   \n');
    const r = load();
    expect(r.warnings.some((w) => w.message.includes('空文件'))).toBe(true);
    expect(r.config).toEqual(DEFAULT_SANDBOX_CONFIG);
  });

  it('坏 JSON：该层不生效 + 结构化 error，不 throw', () => {
    writeConfig('project', '{ "mode": "docker", oops }');
    const r = load();
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.source).toBe('project');
    expect(r.config.mode).toBe('local');
    expect(r.explicit).toBe(false);
  });

  it('顶层不是对象（数组）：warning 忽略', () => {
    writeConfig('project', '[1,2,3]');
    const r = load();
    expect(r.warnings.some((w) => w.message.includes('不是 JSON 对象'))).toBe(true);
    expect(r.explicit).toBe(false);
  });

  it('mergeSandboxLayers：未声明字段不改变来源', () => {
    const { config, provenance } = mergeSandboxLayers([
      { source: 'user', layer: { mode: 'docker' } },
      { source: 'project', layer: {} },
    ]);
    expect(config.mode).toBe('docker');
    expect(provenance.mode).toBe('user');
    expect(provenance.fallback).toBe('default');
  });
});

// ── 非法值降级 ──────────────────────────────────────────────────────────────

describe('非法值降级为未声明 + warning（永不 throw）', () => {
  it('mode 非法枚举', () => {
    const { layer, warnings } = normalize({ mode: 'auto' });
    expect(layer.mode).toBeUndefined();
    expect(warnings[0]!.field).toBe('mode');
  });

  it('fallback 非法枚举 → 默认 deny', () => {
    writeConfig('project', JSON.stringify({ fallback: 'sometimes' }));
    const r = load();
    expect(r.config.fallback).toBe('deny');
    expect(r.warnings.some((w) => w.field === 'fallback')).toBe(true);
  });

  it('memoryMb 负数 / 非整数都被丢弃', () => {
    expect(normalize({ memoryMb: -1 }).layer.memoryMb).toBeUndefined();
    expect(normalize({ memoryMb: 1024.5 }).layer.memoryMb).toBeUndefined();
    expect(normalize({ memoryMb: 999_999 }).layer.memoryMb).toBeUndefined();
  });

  it('cpus 越界被丢弃', () => {
    expect(normalize({ cpus: 0.05 }).layer.cpus).toBeUndefined();
    expect(normalize({ cpus: 65 }).layer.cpus).toBeUndefined();
    expect(normalize({ cpus: 1.5 }).layer.cpus).toBe(1.5);
  });

  it('pidsLimit 越界被丢弃', () => {
    expect(normalize({ pidsLimit: 4 }).layer.pidsLimit).toBeUndefined();
    expect(normalize({ pidsLimit: 256 }).layer.pidsLimit).toBe(256);
  });

  it('pullTimeoutMs 过小被丢弃', () => {
    expect(normalize({ pullTimeoutMs: 100 }).layer.pullTimeoutMs).toBeUndefined();
    expect(normalize({ pullTimeoutMs: 600_000 }).layer.pullTimeoutMs).toBe(600_000);
  });

  it('readOnlyRoot / keepContainer 非 boolean 被丢弃', () => {
    expect(normalize({ readOnlyRoot: 'yes' }).layer.readOnlyRoot).toBeUndefined();
    expect(normalize({ keepContainer: 1 }).layer.keepContainer).toBeUndefined();
    expect(normalize({ readOnlyRoot: false }).layer.readOnlyRoot).toBe(false);
  });

  it('user 非 "uid:gid" 被丢弃（沿用默认 1000:1000）', () => {
    const { layer, warnings } = normalize({ user: 'root' });
    expect(layer.user).toBeUndefined();
    expect(warnings.some((w) => w.field === 'user')).toBe(true);
  });

  it('tmpfs：非法项逐条丢弃，合法项保留', () => {
    const { layer, warnings } = normalize({ tmpfs: ['/tmp', 'relative/path', '/run/@x'] });
    expect(layer.tmpfs).toEqual(['/tmp', '/run/@x']);
    expect(warnings.some((w) => w.field === 'tmpfs')).toBe(true);
  });

  it('env：NAME=value 形式不是合法变量名 → 丢弃（只允许名字）', () => {
    const { layer, warnings } = normalize({ env: ['FOO=bar', 'PATH', 'A-B'] });
    expect(layer.env).toEqual(['PATH']);
    expect(warnings.filter((w) => w.field === 'env')).toHaveLength(2);
  });

  it('未知配置项：warning 忽略（不阻断）', () => {
    const { layer, warnings } = normalize({ foo: 1, mode: 'docker' });
    expect(layer.mode).toBe('docker');
    expect(warnings.some((w) => w.field === 'foo')).toBe(true);
  });

  it('cacheVolume：P2 未实现 → 恒 warning', () => {
    const { layer, warnings } = normalize({ cacheVolume: 'yz-pnpm-store' });
    expect(layer.cacheVolume).toBe('yz-pnpm-store');
    expect(warnings.some((w) => w.field === 'cacheVolume')).toBe(true);
  });
});

// ── user ↔ image 联动 ───────────────────────────────────────────────────────

describe('user 与 image 的联动', () => {
  it('自定义镜像且未显式写 user → user=null（用镜像默认用户）', () => {
    const r = loadSandboxConfig({
      projectRoot: project,
      homeDir: home,
      session: { image: 'my/custom:1' },
    });
    expect(r.config.user).toBeNull();
    expect(r.config.userExplicit).toBe(false);
  });

  it('默认镜像 → user=1000:1000', () => {
    writeConfig('project', JSON.stringify({ image: DEFAULT_SANDBOX_IMAGE }));
    expect(load().config.user).toBe('1000:1000');
  });

  it('显式 user 优先于镜像联动（自定义镜像也保留）', () => {
    writeConfig('project', JSON.stringify({ image: 'my/custom:1', user: '2000:2000' }));
    const r = load();
    expect(r.config.user).toBe('2000:2000');
    expect(r.config.userExplicit).toBe(true);
  });

  it('显式 user:null → 语义为「用镜像默认用户」', () => {
    writeConfig('project', JSON.stringify({ user: null }));
    const r = load();
    expect(r.config.user).toBeNull();
    expect(r.config.userExplicit).toBe(true);
    expect(r.provenance.user).toBe('project');
  });
});

// ── 安全硬拒 ────────────────────────────────────────────────────────────────

describe('安全硬拒（唯一「宁可失败」的地方）', () => {
  it('mounts 敏感键 → 整层硬拒，同层其它字段也不生效', () => {
    writeConfig('project', JSON.stringify({ mounts: ['/:/host'], memoryMb: 512 }));
    const r = load();
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.message).toContain('sandbox 配置不允许');
    expect(r.config.memoryMb).toBe(DEFAULT_SANDBOX_CONFIG.memoryMb);
  });

  it('privileged:true → 硬拒', () => {
    const { errors, layer } = normalize({ privileged: true, mode: 'docker' });
    expect(errors).toHaveLength(1);
    expect(layer).toEqual({});
  });

  it('volumes / cap_add / network_mode 都算敏感键', () => {
    for (const key of ['volumes', 'cap_add', 'network_mode']) {
      const { errors } = normalize({ [key]: true });
      expect(errors, key).toHaveLength(1);
    }
  });

  it('image 以 - 开头 → 硬拒（会被 docker 当成命令行参数）', () => {
    writeConfig('project', JSON.stringify({ image: '--privileged' }));
    const r = load();
    expect(r.errors.some((e) => e.message.includes('sandbox 配置不允许'))).toBe(true);
    expect(r.config.image).toBe(DEFAULT_SANDBOX_IMAGE);
  });

  it('项目层被硬拒时，全局层仍然生效', () => {
    writeConfig('user', JSON.stringify({ memoryMb: 1024 }));
    writeConfig('project', JSON.stringify({ mounts: ['/:/host'] }));
    const r = load();
    expect(r.config.memoryMb).toBe(1024);
    expect(r.provenance.memoryMb).toBe('user');
    expect(r.errors).toHaveLength(1);
  });
});

// ── enforce 偏序 ────────────────────────────────────────────────────────────

describe('enforce：会话覆盖只能更严', () => {
  it('docker → local 违例', () => {
    const v = checkEnforce({ enforce: true, mode: 'docker' }, { mode: 'local' });
    expect(v).toHaveLength(1);
    expect(v[0]!.field).toBe('mode');
    // §19：文案随项目模式区分（docker=容器 / seatbelt=沙箱），公共前缀「项目策略已强制」
    expect(v[0]!.message).toContain('项目策略已强制');
  });

  it('local → docker 允许', () => {
    expect(checkEnforce({ enforce: true, mode: 'local' }, { mode: 'docker' })).toEqual([]);
  });

  it('bridge → none 允许（收紧）', () => {
    expect(checkEnforce({ enforce: true, network: 'bridge' }, { network: 'none' })).toEqual([]);
  });

  it('none → bridge 违例（放宽）', () => {
    const v = checkEnforce({ enforce: true, network: 'none' }, { network: 'bridge' });
    expect(v).toHaveLength(1);
    expect(v[0]!.field).toBe('network');
  });

  it('fallback 非 deny 一律违例；deny 允许', () => {
    expect(checkEnforce({ enforce: true }, { fallback: 'ask' })[0]!.field).toBe('fallback');
    expect(checkEnforce({ enforce: true }, { fallback: 'local' })[0]!.field).toBe('fallback');
    expect(checkEnforce({ enforce: true }, { fallback: 'deny' })).toEqual([]);
  });

  it('memoryMb 放大违例、缩小允许', () => {
    expect(checkEnforce({ enforce: true, memoryMb: 2048 }, { memoryMb: 4096 })[0]!.field).toBe('memoryMb');
    expect(checkEnforce({ enforce: true, memoryMb: 2048 }, { memoryMb: 1024 })).toEqual([]);
  });

  it('readOnlyRoot true → false 违例', () => {
    expect(checkEnforce({ enforce: true, readOnlyRoot: true }, { readOnlyRoot: false })[0]!.field).toBe(
      'readOnlyRoot',
    );
  });

  it('image 可覆盖（不削弱四条第线），但以 - 开头仍违例', () => {
    expect(checkEnforce({ enforce: true, image: 'a:1' }, { image: 'b:1' })).toEqual([]);
    expect(checkEnforce({ enforce: true }, { image: '--privileged' })[0]!.field).toBe('image');
  });

  it('enforce=false 时不产生任何违例', () => {
    expect(checkEnforce({ enforce: false, mode: 'docker' }, { mode: 'local' })).toEqual([]);
  });

  it('enforce:true + fallback:ask → 强制 deny 并给出 warning', () => {
    writeConfig('project', JSON.stringify({ enforce: true, fallback: 'ask' }));
    const r = load();
    expect(r.config.enforce).toBe(true);
    expect(r.config.fallback).toBe('deny');
    expect(r.warnings.some((w) => w.field === 'fallback')).toBe(true);
  });

  it('user 层写 enforce 被丢弃 + warning（仅项目级生效）', () => {
    writeConfig('user', JSON.stringify({ enforce: true }));
    const r = load();
    expect(r.config.enforce).toBe(false);
    expect(r.warnings.some((w) => w.field === 'enforce')).toBe(true);
  });
});

// ── 工作区根守卫 ────────────────────────────────────────────────────────────

describe('assertSafeWorkspaceRoot（任何 docker 调用之前）', () => {
  it('文件系统根被拒，文案含「sandbox 配置不允许」', () => {
    expect(() => assertSafeWorkspaceRoot('/')).toThrow(SandboxPathError);
    expect(() => assertSafeWorkspaceRoot('/')).toThrow(/sandbox 配置不允许/);
  });

  it('home 目录被拒', () => {
    expect(() => assertSafeWorkspaceRoot(fs.realpathSync(os.homedir()))).toThrow(/home 目录/);
  });

  it('os.tmpdir() 本身被拒', () => {
    expect(() => assertSafeWorkspaceRoot(fs.realpathSync(os.tmpdir()))).toThrow(/临时目录/);
  });

  it('工作区内含 docker.sock 被拒', () => {
    fs.writeFileSync(path.join(project, 'docker.sock'), '');
    expect(() => assertSafeWorkspaceRoot(project)).toThrow(/docker\.sock/);
  });

  it('普通项目目录通过（tmp 的子目录不受影响）', () => {
    expect(() => assertSafeWorkspaceRoot(project)).not.toThrow();
  });
});

// ── updateUserSandboxMode（enable/disable 写路径）──────────────────────────

describe('updateUserSandboxMode：只改 mode、写前读、原子写', () => {
  const { mkdtempSync, writeFileSync, readFileSync, existsSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');
  const { join } = require('node:path') as typeof import('node:path');

  function tempHome(): string {
    return mkdtempSync(join(tmpdir(), 'delta-cfg-home-'));
  }

  it('文件不存在 → 创建 {"mode":"seatbelt"}，previous=local', () => {
    const home = tempHome();
    const r = updateUserSandboxMode('seatbelt', { homeDir: home });
    expect(r.previous).toBe('local');
    expect(JSON.parse(readFileSync(r.path, 'utf8'))).toEqual({ mode: 'seatbelt' });
  });

  it('既有文件的其它字段原样保留，只改 mode', () => {
    const home = tempHome();
    fs.mkdirSync(join(home, '.delta'), { recursive: true });
    writeFileSync(join(home, '.delta', 'sandbox.json'), '{"mode":"docker","network":"bridge","memoryMb":1024}');
    updateUserSandboxMode('seatbelt', { homeDir: home });
    expect(JSON.parse(readFileSync(join(home, '.delta', 'sandbox.json'), 'utf8'))).toEqual({
      mode: 'seatbelt',
      network: 'bridge',
      memoryMb: 1024,
    });
  });

  it('坏 JSON → 拒绝写入并抛错（不覆盖用户文件）', () => {
    const home = tempHome();
    fs.mkdirSync(join(home, '.delta'), { recursive: true });
    writeFileSync(join(home, '.delta', 'sandbox.json'), '{broken');
    expect(() => updateUserSandboxMode('local', { homeDir: home })).toThrow(/无法解析/);
    expect(readFileSync(join(home, '.delta', 'sandbox.json'), 'utf8')).toBe('{broken');
  });

  it('非对象 JSON（数组）→ 拒绝写入', () => {
    const home = tempHome();
    fs.mkdirSync(join(home, '.delta'), { recursive: true });
    writeFileSync(join(home, '.delta', 'sandbox.json'), '[]');
    expect(() => updateUserSandboxMode('local', { homeDir: home })).toThrow(/无法解析/);
  });

  it('写入后不留 .tmp 中间文件（原子 rename）', () => {
    const home = tempHome();
    updateUserSandboxMode('docker', { homeDir: home });
    const { readdirSync } = require('node:fs') as typeof import('node:fs');
    expect(readdirSync(join(home, '.delta')).filter((f: string) => f.includes('.tmp-'))).toHaveLength(0);
    expect(existsSync(join(home, '.delta', 'sandbox.json'))).toBe(true);
  });
});
