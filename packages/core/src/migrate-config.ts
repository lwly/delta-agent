/**
 * 老配置目录迁移：`~/.y-zero/` → `~/.delta/`
 *
 * 项目由 y-zero-agent 更名为 delta-agent，配置目录随之从 `.y-zero` 换成
 * `.delta`。为免老用户丢失 Provider Key、会话库、技能包与专家配置，
 * 首次启动时整目录复制一次。
 *
 * 语义：
 *  - 旧目录不存在，或新目录已存在 ⇒ 什么都不做（幂等，可反复调用）
 *  - 复制先落到 `.delta.migrating`，成功后 rename 成 `.delta`：
 *    中途失败不会留下「半成品新目录」把后续迁移永久堵死
 *  - 旧目录**保留**，只写一个标记文件，用户确认无误后可自行删除
 *  - 任何失败只 warn、不 throw —— 配置迁移不该让 agent 起不来
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CONFIG_DIR, userConfigDir } from './paths.js';

/** 更名前的配置目录名 */
export const LEGACY_CONFIG_DIR = '.y-zero';

/** 迁移完成后写在旧目录里的标记文件名 */
export const MIGRATION_MARKER = 'MIGRATED_TO_DELTA';

export interface MigrateConfigResult {
  /** 本次调用是否真的执行了迁移 */
  migrated: boolean;
  /** 迁移来源（绝对路径） */
  from?: string;
  /** 迁移目标（绝对路径） */
  to?: string;
  /** 未迁移原因：no-legacy-dir | target-exists | <错误信息> */
  reason?: string;
}

export interface MigrateConfigOptions {
  /** 用户主目录，默认 os.homedir()（测试注入用） */
  homeDir?: string;
  /** 提示回调；迁移成功/失败时各调用一次 */
  warn?: (message: string) => void;
}

/**
 * 把老的 `~/.y-zero/` 迁移到 `~/.delta/`。
 *
 * 幂等：可在每次启动时无条件调用。
 */
export function migrateLegacyConfig(options: MigrateConfigOptions = {}): MigrateConfigResult {
  const homeDir = options.homeDir ?? os.homedir();
  const warn = options.warn ?? ((): void => {});
  const from = path.join(homeDir, LEGACY_CONFIG_DIR);
  const to = userConfigDir(homeDir);

  try {
    if (!fs.existsSync(from)) return { migrated: false, reason: 'no-legacy-dir' };
    if (fs.existsSync(to)) return { migrated: false, reason: 'target-exists' };

    const staging = path.join(homeDir, `${CONFIG_DIR}.migrating`);
    // 清掉上次中断可能残留的暂存目录，保证从干净状态复制
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(from, staging, { recursive: true });

    // 迁移完成后不应把标记文件也带进新目录
    fs.rmSync(path.join(staging, MIGRATION_MARKER), { force: true });

    fs.renameSync(staging, to);
    fs.writeFileSync(
      path.join(from, MIGRATION_MARKER),
      `migrated to ${to} at ${new Date().toISOString()}\n`,
      'utf8',
    );

    warn(`已将旧配置目录 ${from} 迁移到 ${to}（原目录保留，确认无误后可手动删除）`);
    return { migrated: true, from, to };
  } catch (e) {
    warn(`旧配置目录迁移失败（${from} → ${to}）：${(e as Error).message}`);
    return { migrated: false, from, to, reason: (e as Error).message };
  }
}
