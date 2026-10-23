import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import type { BranchInfo } from '@y-zero/core';
import { theme, icons } from './theme.js';

/**
 * F-37 分支选择卡（与 ConfirmCard 同风格，PRD §5.1 /branch）：
 * - 方向键选择、回车 checkout
 * - `n` 进入新建分支输入（就地 checkout -b）
 * - Esc 取消
 */
export function BranchCard(props: {
  branches: BranchInfo[];
  busy?: boolean;
  onPick: (branch: string) => void;
  onNew: (name: string) => void;
  onCancel: () => void;
}) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');

  useInput((_input, key) => {
    if (props.busy) return;
    if (key.escape) props.onCancel();
    if (_input === 'n' && !creating) setCreating(true);
  });

  if (props.busy) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginY={0}>
        <Text color={theme.warn}>{icons.git} 切换中…</Text>
      </Box>
    );
  }

  if (creating) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginY={0}>
        <Text color={theme.warn}>{icons.git} 新建分支并切换（回车确认，Esc 取消输入）：</Text>
        <TextInput
          value={newName}
          onChange={setNewName}
          onSubmit={(v) => {
            const name = v.trim();
            if (name) props.onNew(name);
          }}
          placeholder="分支名，如 yzero/fix-login"
        />
        <Text dimColor>（Esc 放弃新建，返回分支列表）</Text>
      </Box>
    );
  }

  const options = props.branches.map((b) => ({
    label: `${b.current ? '✔ ' : '   '}${b.name}`,
    value: b.name,
  }));

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} marginY={0}>
      <Text color={theme.warn}>{icons.git} 切换分支（会话级 checkout，只影响当前会话）</Text>
      <SelectInput
        items={options}
        onSelect={(item) => props.onPick(item.value)}
      />
      <Text dimColor>↑↓ 选择 · 回车切换 · n 新建分支 · Esc 取消</Text>
    </Box>
  );
}
