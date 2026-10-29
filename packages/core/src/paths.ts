/**
 * 应用标识与路径常量（单一事实来源）
 *
 * 改名 / 换配置目录只需修改本文件。其余模块一律引用这里的常量，
 * 不再写死 `.delta`、`models.json` 之类的字面量。
 *
 * 目录布局：
 *   - 用户级：`~/.delta/`        （models.json、agent.db、cron.json、skills/ …）
 *   - 项目级：`<projectRoot>/.delta/`（mcp.json、hooks.json、sandbox.json、agent.md …）
 *
 * 这是底层模块，只依赖 node 内置模块，不得 import 其他 core 模块（避免循环依赖）。
 */
import os from 'node:os';
import path from 'node:path';

/** 应用名：CLI 命令、npm scope、界面展示名 */
export const APP_NAME = 'delta';

/**
 * 应用版本（单一事实来源）。
 *
 * 修改时同步各 package 的 package.json version 字段（发布脚本以 package.json 为准，
 * 本常量供 CLI --version、更新检查等运行时读取；SEA 与 npm 两渠道共用）。
 */
export const APP_VERSION = '0.1.0';

/** 配置目录名（用户级与项目级共用） */
export const CONFIG_DIR = '.delta';

/** 用户级配置根目录，默认 `~/.delta` */
export function userConfigDir(homeDir: string = os.homedir()): string {
  return path.join(homeDir, CONFIG_DIR);
}

/** 项目级配置根目录，默认 `<projectRoot>/.delta` */
export function projectConfigDir(projectRoot: string): string {
  return path.join(projectRoot, CONFIG_DIR);
}

/** 配置文件与子目录名 */
export const FILES = {
  /** 模型 Provider 配置（API Key 加密存储） */
  models: 'models.json',
  /** SQLite 会话数据库 */
  database: 'agent.db',
  /** MCP Server 配置 */
  mcp: 'mcp.json',
  /** 桌面通知配置 */
  notify: 'notify.json',
  /** 沙箱配置 */
  sandbox: 'sandbox.json',
  /** Hook 配置 */
  hooks: 'hooks.json',
  /** cron 任务清单 */
  cron: 'cron.json',
  /** Skill Hub 源配置（旧版，F-52 起市场源配置迁移至 registry.json，读取时兼容） */
  skillHub: 'skill-hub.json',
  /** F-52 市场订阅源配置（skills/mcp 统一） */
  registry: 'registry.json',
  /** 项目引导状态 */
  onboarding: 'onboarding.json',
  /** 项目静态记忆 */
  agentMd: 'agent.md',
  /** 项目引导产出的 agent.md 草案 */
  agentMdDraft: 'agent.md.draft',
  /** Web 控制台设置 */
  settings: 'settings.json',
  /** F-50 自动更新：配置（enabled/source/intervalMs）与状态（lastCheckAt/lastSeenVersion）共用 */
  update: 'update.json',
  /** F-50 SEA 渠道更新包下载暂存目录 */
  updateStagingDir: 'update-staging',
  /** 技能包目录 */
  skillsDir: 'skills',
  /** 专家包目录 */
  expertsDir: 'experts',
  /** 专家库配置（disabled[] / trusted[]，F-39 P1） */
  expertsConfig: 'experts.json',
  /** 评测集目录 */
  evalsDir: 'evals',
  /** F-41 运行日志目录（serve-YYYYMMDD.log / runs/） */
  logsDir: 'logs',
} as const;

/** Docker 容器 label 键：用于识别本应用创建的沙箱容器（GC / 清理） */
export const LABELS = {
  session: `${APP_NAME}.session`,
  project: `${APP_NAME}.project`,
  created: `${APP_NAME}.created`,
} as const;

/** 环境变量前缀，如 `DELTA_MODEL`、`DELTA_SKILL_HUB_URL` */
export const ENV_PREFIX = 'DELTA_';

/** 构造环境变量名，如 envName('MODEL') === 'DELTA_MODEL' */
export function envName(suffix: string): string {
  return `${ENV_PREFIX}${suffix}`;
}
