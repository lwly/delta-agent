import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';
import { BUILTIN_TOOL_COUNT } from '../src/experts/policy.js';
import { readFileTool } from '../src/tools/builtin/fs.js';
import { builtinTools, registerTool } from '../src/plugins/tools.js';

describe('builtin tool slot', () => {
  it('登记表与 ToolRegistry 内置清单一致', () => {
    expect(builtinTools()).toHaveLength(BUILTIN_TOOL_COUNT);
    expect(new ToolRegistry().names()).toEqual(builtinTools().map((t) => t.name));
    expect(builtinTools().map((t) => t.name)).toContain('read_file');
    expect(builtinTools().map((t) => t.name)).toContain('dispatch_task');
    expect(builtinTools().some((t) => t.name.startsWith('mcp__'))).toBe(false);
  });

  it('重复工具名抛错', () => {
    expect(() => registerTool(readFileTool)).toThrow(/already registered: read_file/);
  });
});
