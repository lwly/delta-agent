import React from 'react';
import { Box, Text } from 'ink';
import { theme, icons } from './theme.js';

/**
 * F-37 TUI 底栏三段式（PRD §5.1）：
 * 左侧项目名 ｜ 中间当前分支（detached HEAD 显示短 hash）｜ 右侧 Worktree 开关
 * ☐ 主工作区 / ● 已切入 worktree（附目录路径）。
 */
export function WorktreeBar(props: {
  projectName: string;
  branch: string | null;
  worktreeEnabled: boolean;
  worktreePath?: string | null;
}) {
  return (
    <Box marginTop={0} paddingX={1} justifyContent="space-between">
      <Text color={theme.prompt}>📁 {props.projectName}</Text>
      <Text color={theme.border}>
        {icons.git} {props.branch ?? '（非 git 仓库）'}
      </Text>
      {props.worktreeEnabled ? (
        <Text color={theme.toolOk}>
          ● Worktree{props.worktreePath ? `（${props.worktreePath}）` : ''}
        </Text>
      ) : (
        <Text dimColor>☐ Worktree</Text>
      )}
    </Box>
  );
}
