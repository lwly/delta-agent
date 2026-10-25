/**
 * 权限模式体系（PRD F-23，agent-modes-design 确认协议扩展）
 * 三级模式：
 * - plan：只读。写文件/执行命令类工具直接拒绝（不走确认流）
 * - default：写/执行需确认（现有行为），支持工具级 allowlist 与"本会话不再询问"
 * - yolo：全放行（双重开启由 CLI/Web 入口保证）；非白名单 run_command 仍需确认
 */
import { isWhitelistedCommand } from './sandbox.js';
import type { PermissionMode } from '@delta/shared';

export type { PermissionMode };

/** 工具能力分类（权限判定用；未知工具保守按 exec 处理）。 */
export type ToolCapability = 'read' | 'write' | 'exec';

const TOOL_CAPABILITY: Record<string, ToolCapability> = {
  // 只读/无副作用
  read_file: 'read',
  list_dir: 'read',
  glob_search: 'read',
  grep_search: 'read',
  web_fetch: 'read',
  todo_write: 'read',
  ask_user: 'read',
  load_skill: 'read',
  unload_skill: 'read',
  recall_memory: 'read',
  // 写状态
  write_file: 'write',
  edit_file: 'write',
  save_memory: 'write',
  // 执行
  run_command: 'exec',
  run_tests: 'exec',
};

export function toolCapability(tool: string): ToolCapability {
  return TOOL_CAPABILITY[tool] ?? 'exec';
}

export interface PermissionPolicy {
  mode: PermissionMode;
  /** 工具级 allowlist：命中的工具在 default 模式下跳过确认（plan 仍拒绝写/执行） */
  allowlist?: string[];
}

export type PermissionCheck =
  | { action: 'allow' }
  | { action: 'confirm' }
  | { action: 'deny'; reason: string };

export class PermissionState {
  /** "本会话不再询问"：allow_session 决策的记忆（会话内有效） */
  private sessionAllowed = new Set<string>();

  constructor(readonly policy: PermissionPolicy) {}

  /** registry 收到 allow_session 决策时记入。 */
  allowSession(tool: string): void {
    this.sessionAllowed.add(tool);
  }

  isSessionAllowed(tool: string): boolean {
    return this.sessionAllowed.has(tool);
  }

  isAllowlisted(tool: string): boolean {
    return this.policy.allowlist?.includes(tool) ?? false;
  }

  /**
   * 统一判定入口。
   * - allow：直接执行（跳过确认流）
   * - confirm：走确认流（仅对 danger:'confirm' 工具有意义，registry 负责衔接）
   * - deny：拒绝执行（plan 模式写/执行）
   */
  check(tool: string, args?: Record<string, unknown>): PermissionCheck {
    const cap = toolCapability(tool);

    // plan：只读，禁写禁执行
    if (this.policy.mode === 'plan') {
      return cap === 'read'
        ? { action: 'allow' }
        : { action: 'deny', reason: `当前为 plan（只读）模式，工具 ${tool} 被禁止；切换到 default/yolo 模式后可用` };
    }

    // 会话记忆与 allowlist：default/yolo 下跳过确认
    if (this.policy.mode === 'default' && (this.sessionAllowed.has(tool) || this.isAllowlisted(tool))) {
      return { action: 'allow' };
    }

    // yolo：全放行；例外——非白名单 run_command 仍需确认（sandbox 约定）
    if (this.policy.mode === 'yolo') {
      if (tool === 'run_command') {
        const command = String(args?.['command'] ?? '');
        return isWhitelistedCommand(command) ? { action: 'allow' } : { action: 'confirm' };
      }
      return { action: 'allow' };
    }

    // default：只读放行，写/执行需确认
    return cap === 'read' ? { action: 'allow' } : { action: 'confirm' };
  }
}
