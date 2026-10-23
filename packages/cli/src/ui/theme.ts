/**
 * F-36 CLI TUI 细节 —— 主题集中管理：
 * 语义色 token 与状态图标收拢到单一模块，消除 app.tsx / confirm.tsx 的硬编码散点。
 * 零依赖：`NO_COLOR` 环境变量置位时全部颜色置为 undefined（Ink 视为无色，即纯文本降级）；
 * 颜色只用 Ink 内置 16 色命名色，深浅色终端均安全，不引入 truecolor 检测。
 */

function noColor(): boolean {
  return process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '';
}

/** 语义色 token（值为 Ink Text 的 color prop；undefined = 不着色） */
export interface Theme {
  /** 会话主边框 */
  border: string | undefined;
  /** 用户输入提示 */
  user: string | undefined;
  /** 工具执行中 / 工具成功 / 工具失败 */
  toolPending: string | undefined;
  toolOk: string | undefined;
  toolFail: string | undefined;
  /** 系统提示（多数走 dimColor，颜色仅在强调时用） */
  system: string | undefined;
  /** 输入提示符 */
  prompt: string | undefined;
  /** 警告 / 错误（确认卡、预算告警等） */
  warn: string | undefined;
  error: string | undefined;
  /** diff 着色 */
  diffAdd: string | undefined;
  diffDel: string | undefined;
  diffHunk: string | undefined;
  /** 思考过程（thinking_delta） */
  thinking: string | undefined;
  /** 流式输出光标 */
  cursor: string | undefined;
}

/** 状态图标集中收拢（保持与既有输出一致，避免同义图标散布） */
export const icons = {
  user: '›',
  tool: '⚙',
  ok: '✔',
  fail: '✘',
  warn: '⚠',
  plan: '📋',
  ask: '❓',
  git: '⎇',
  image: '🖼',
  review: '🔍',
  subtask: '▶',
  compress: '🗜',
  sandbox: '🛡',
  rollback: '↩',
} as const;

export const theme: Theme = noColor()
  ? {
      border: undefined,
      user: undefined,
      toolPending: undefined,
      toolOk: undefined,
      toolFail: undefined,
      system: undefined,
      prompt: undefined,
      warn: undefined,
      error: undefined,
      diffAdd: undefined,
      diffDel: undefined,
      diffHunk: undefined,
      thinking: undefined,
      cursor: undefined,
    }
  : {
      border: 'gray',
      user: 'cyan',
      toolPending: 'yellow',
      toolOk: 'green',
      toolFail: 'red',
      system: undefined, // system 走 dimColor
      prompt: 'green',
      warn: 'yellow',
      error: 'red',
      diffAdd: 'green',
      diffDel: 'red',
      diffHunk: 'cyan',
      thinking: 'gray',
      cursor: 'gray',
    };
