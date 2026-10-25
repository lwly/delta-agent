/**
 * F-36 CLI TUI 细节 —— diff 彩色渲染组件：
 * 消费 core 的 diffLines/compactDiff 产物，按行着色（+ 绿 / - 红 / 上下文暗）。
 */
import React from 'react';
import { Box, Text } from 'ink';
import type { DiffLine } from '@delta/core';
import { theme } from './theme.js';

export function DiffView(props: { lines: DiffLine[]; title?: string }) {
  if (props.lines.length === 0) return null;
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {props.title ? <Text dimColor>{props.title}</Text> : null}
      {props.lines.map((l, i) => {
        const prefix = l.type === 'add' ? '+ ' : l.type === 'del' ? '- ' : '  ';
        if (l.type === 'add') {
          return (
            <Text key={i} color={theme.diffAdd}>
              {prefix}
              {l.text}
            </Text>
          );
        }
        if (l.type === 'del') {
          return (
            <Text key={i} color={theme.diffDel}>
              {prefix}
              {l.text}
            </Text>
          );
        }
        return (
          <Text key={i} dimColor>
            {prefix}
            {l.text}
          </Text>
        );
      })}
    </Box>
  );
}
