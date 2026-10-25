/**
 * 配置目录更名迁移单测：`~/.y-zero/` → `~/.delta/`
 *
 * 覆盖：无旧目录 / 正常迁移 / 目标已存在 / 幂等 / 旧目录标记 / 暂存目录残留。
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LEGACY_CONFIG_DIR, MIGRATION_MARKER, migrateLegacyConfig } from '../src/migrate-config.js';
import { CONFIG_DIR, FILES } from '../src/paths.js';

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'delta-migrate-'));
}

/** 造一个带若干配置的旧目录 */
function seedLegacy(home: string): string {
  const legacy = path.join(home, LEGACY_CONFIG_DIR);
  fs.mkdirSync(path.join(legacy, FILES.skillsDir, 'demo'), { recursive: true });
  fs.writeFileSync(path.join(legacy, FILES.models), '{"providers":{}}', 'utf8');
  fs.writeFileSync(path.join(legacy, FILES.skillsDir, 'demo', 'SKILL.md'), '# demo', 'utf8');
  return legacy;
}

describe('migrateLegacyConfig', () => {
  it('没有旧目录时什么都不做', () => {
    const home = tmpHome();
    const r = migrateLegacyConfig({ homeDir: home });

    expect(r.migrated).toBe(false);
    expect(r.reason).toBe('no-legacy-dir');
    expect(fs.existsSync(path.join(home, CONFIG_DIR))).toBe(false);
  });

  it('旧目录存在时整目录复制到新目录，旧目录保留并打标记', () => {
    const home = tmpHome();
    const legacy = seedLegacy(home);
    const messages: string[] = [];

    const r = migrateLegacyConfig({ homeDir: home, warn: (m) => messages.push(m) });

    expect(r.migrated).toBe(true);
    expect(r.from).toBe(legacy);
    expect(r.to).toBe(path.join(home, CONFIG_DIR));

    // 内容完整搬过去
    expect(fs.readFileSync(path.join(home, CONFIG_DIR, FILES.models), 'utf8')).toBe('{"providers":{}}');
    expect(fs.readFileSync(path.join(home, CONFIG_DIR, FILES.skillsDir, 'demo', 'SKILL.md'), 'utf8')).toBe('# demo');

    // 旧目录保留，且写了迁移标记
    expect(fs.existsSync(path.join(legacy, FILES.models))).toBe(true);
    expect(fs.readFileSync(path.join(legacy, MIGRATION_MARKER), 'utf8')).toContain(path.join(home, CONFIG_DIR));

    // 标记不应被复制进新目录
    expect(fs.existsSync(path.join(home, CONFIG_DIR, MIGRATION_MARKER))).toBe(false);

    expect(messages.join('\n')).toContain('迁移到');
  });

  it('新目录已存在时不覆盖，也不合并', () => {
    const home = tmpHome();
    seedLegacy(home);
    const target = path.join(home, CONFIG_DIR);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, FILES.models), '{"providers":{"keep":1}}', 'utf8');

    const r = migrateLegacyConfig({ homeDir: home });

    expect(r.migrated).toBe(false);
    expect(r.reason).toBe('target-exists');
    expect(fs.readFileSync(path.join(target, FILES.models), 'utf8')).toBe('{"providers":{"keep":1}}');
  });

  it('幂等：连续调用第二次为 no-op', () => {
    const home = tmpHome();
    seedLegacy(home);

    expect(migrateLegacyConfig({ homeDir: home }).migrated).toBe(true);
    const second = migrateLegacyConfig({ homeDir: home });

    expect(second.migrated).toBe(false);
    expect(second.reason).toBe('target-exists');
  });

  it('清掉上次中断残留的暂存目录后重新迁移', () => {
    const home = tmpHome();
    seedLegacy(home);
    const staging = path.join(home, `${CONFIG_DIR}.migrating`);
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, 'junk.txt'), 'half-written', 'utf8');

    const r = migrateLegacyConfig({ homeDir: home });

    expect(r.migrated).toBe(true);
    expect(fs.existsSync(path.join(home, CONFIG_DIR, 'junk.txt'))).toBe(false);
    expect(fs.existsSync(staging)).toBe(false);
  });

  it('目标是普通文件时按 target-exists 处理，不抛异常', () => {
    const home = tmpHome();
    seedLegacy(home);
    const messages: string[] = [];

    // 用一个已存在的普通文件占用目标路径，让 rename 必定失败
    fs.writeFileSync(path.join(home, CONFIG_DIR), 'not a directory', 'utf8');

    expect(() => migrateLegacyConfig({ homeDir: home, warn: (m) => messages.push(m) })).not.toThrow();
    // target-exists 分支会先命中，所以这里只需保证不抛
    expect(messages.length).toBe(0);
  });
});
