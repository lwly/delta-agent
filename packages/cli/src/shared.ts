/**
 * CLI 入口共享助手（主命令 / run 子命令共用），避免 index ↔ headless-run 循环依赖。
 */

/** CLI --mode → 会话模式（存储值与引擎值对齐）。 */
export function normalizeMode(mode?: string): 'react' | 'plan-execute' | 'multi-agent' {
  switch (mode) {
    case 'plan':
    case 'plan-execute':
      return 'plan-execute';
    case 'multi':
    case 'multi-agent':
      return 'multi-agent';
    default:
      return 'react';
  }
}

/**
 * F-23 权限模式解析（双重开启）：
 * - `--permission yolo` 必须同时传 `--yolo`，否则告警降级 default
 * - `--yolo` 单独使用（历史用法）同样告警降级 default
 */
export function resolvePermissionMode(yoloFlag: boolean, permission?: string): 'plan' | 'default' | 'yolo' {
  const requested = permission === 'plan' || permission === 'yolo' ? permission : 'default';
  if (requested === 'yolo' && !yoloFlag) {
    console.error('⚠ yolo 模式需双重开启：同时传入 --permission yolo 与 --yolo；本次降级为 default');
    return 'default';
  }
  if (requested !== 'yolo' && yoloFlag) {
    console.error('⚠ --yolo 需与 --permission yolo 同时使用（双重开启）；本次降级为 default');
    return 'default';
  }
  return requested;
}

/** F-24 工具级 allowlist：逗号分隔 → 去空白去重。 */
export function parseAllowTools(raw?: string): string[] | undefined {
  if (!raw?.trim()) return undefined;
  const list = [...new Set(raw.split(',').map((t) => t.trim()).filter(Boolean))];
  return list.length > 0 ? list : undefined;
}

/** F-24 git 策略解析（非法值降级 suggest）。 */
export function normalizeGitPolicy(mode?: string): 'off' | 'suggest' | 'auto' {
  return mode === 'off' || mode === 'auto' ? mode : 'suggest';
}

/** L2 记忆召回块（memory-design §7 动态段；空则隐藏）。 */
export function renderMemoryRecallBlock(
  memory: import('@y-zero/core').MemoryStore | undefined,
  input: string,
  scopes: string[],
): string {
  if (!memory) return '';
  try {
    const hits = memory.recall(input, scopes, 5);
    if (hits.length === 0) return '';
    return `## 相关长期记忆（自动召回）\n${hits.map((h) => `- (${h.item.kind}) ${h.item.content}`).join('\n')}`;
  } catch {
    return '';
  }
}
