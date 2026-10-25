import React, { useState } from 'react';
import { Box, Text } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import type { ConfirmDecision, ConfirmRequest } from '@delta/shared';
import { theme, icons } from './theme.js';

/**
 * TUI confirmation card (decision #9): arrow keys to choose
 * 允许 / 拒绝 / 编辑参数. "编辑" opens a JSON text field pre-filled with
 * the current args; submitting parses it back into an `edit` decision.
 */
export function ConfirmCard(props: {
  request: ConfirmRequest;
  onDecide: (d: ConfirmDecision) => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <EditArgs
        request={props.request}
        onSubmit={(args) => props.onDecide({ kind: 'edit', args })}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const options = [
    { label: '允许（执行一次）', value: 'allow' },
    { label: '允许（本会话不再询问）', value: 'allow_session' },
    { label: '编辑参数后执行', value: 'edit' },
    { label: '拒绝', value: 'reject' },
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1} marginY={0}>
      <Text color={theme.warn}>{icons.warn} 确认操作 · {props.request.tool}</Text>
      <Text dimColor>{props.request.reason}</Text>
      <ArgsView tool={props.request.tool} args={props.request.args} />
      <SelectInput
        items={options}
        onSelect={(item) => {
          if (item.value === 'allow') props.onDecide({ kind: 'allow' });
          else if (item.value === 'allow_session')
            props.onDecide({ kind: 'allow_session', tool: props.request.tool });
          else if (item.value === 'reject') props.onDecide({ kind: 'reject' });
          else setEditing(true);
        }}
      />
    </Box>
  );
}

/** F-36 edit_file：确认前展示替换内容彩色对照（旧红 / 新绿），先看后批。 */
function EditPreview({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  const clip = (s: string): string[] => {
    const lines = s.split('\n').slice(0, 10);
    if (s.split('\n').length > 10) lines.push(`…（其余 ${s.split('\n').length - 10} 行省略）`);
    return lines;
  };
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {clip(oldStr).map((l, i) => (
        <Text key={`o${i}`} color={theme.diffDel}>
          - {l}
        </Text>
      ))}
      {clip(newStr).map((l, i) => (
        <Text key={`n${i}`} color={theme.diffAdd}>
          + {l}
        </Text>
      ))}
    </Box>
  );
}

function ArgsView({ tool, args }: { tool: string; args: Record<string, unknown> }) {
  // edit_file：old_string/new_string 逐行彩色对照（其余参数仍列摘要行）
  if (tool === 'edit_file' && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
    return (
      <Box flexDirection="column">
        <Text dimColor>  path: {String(args.path ?? '')}</Text>
        <EditPreview oldStr={args.old_string} newStr={args.new_string} />
      </Box>
    );
  }
  const lines = Object.entries(args).map(([k, v]) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    const shown = s.length > 300 ? s.slice(0, 300) + '…' : s;
    return `  {k}: ${shown}`.replace('{k}', k);
  });
  return (
    <Box flexDirection="column">
      {lines.map((l, i) => (
        <Text key={i}>{l}</Text>
      ))}
    </Box>
  );
}

function EditArgs(props: {
  request: ConfirmRequest;
  onSubmit: (args: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(() => JSON.stringify(props.request.args, null, 0));
  const [error, setError] = useState('');

  return (
    <Box flexDirection="column">
      <Text color={theme.user}>编辑参数（JSON，回车提交，Esc 取消）：</Text>
      {error ? <Text color={theme.error}>{error}</Text> : null}
      <TextInput
        value={value}
        onChange={setValue}
        onSubmit={(v) => {
          try {
            const parsed = JSON.parse(v) as Record<string, unknown>;
            props.onSubmit(parsed);
          } catch (e) {
            setError(`JSON 解析失败: ${(e as Error).message}`);
          }
        }}
      />
      <Text dimColor>（取消请 Ctrl+C 中断本次会话操作）</Text>
    </Box>
  );
}
