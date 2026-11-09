/**
 * P1 内置工具槽。工具实现仍在 tools/builtin，这里只登记。
 * 执行、确认、沙箱留在 ToolRegistry.executeOne。
 * MCP 工具不进这张表，仍由 McpManager.registerInto 登记到具体注册表实例。
 */
import type { AgentTool } from '../tools/types.js';
import {
  readFileTool, writeFileTool, editFileTool, listDirTool, globSearchTool, grepSearchTool,
} from '../tools/builtin/fs.js';
import { runCommandTool, runTestsTool, taskOutputTool } from '../tools/builtin/exec.js';
import { webFetchTool, todoWriteTool, askUserTool } from '../tools/builtin/web.js';
import { loadSkillTool, unloadSkillTool } from '../tools/builtin/skill.js';
import { saveMemoryTool, recallMemoryTool } from '../tools/builtin/memory.js';
import { taskTool } from '../tools/builtin/task.js';
import { dispatchTaskTool, taskStatusTool } from '../tools/builtin/dispatch.js';

const tools: AgentTool[] = [];
const names = new Set<string>();

export function registerTool(tool: AgentTool): void {
  if (names.has(tool.name)) throw new Error(`tool already registered: ${tool.name}`);
  names.add(tool.name);
  tools.push(tool);
}

export function builtinTools(): readonly AgentTool[] {
  return tools;
}

for (const tool of [
  readFileTool, writeFileTool, editFileTool, listDirTool, globSearchTool, grepSearchTool,
  runCommandTool, runTestsTool, taskOutputTool, webFetchTool, todoWriteTool, askUserTool,
  loadSkillTool, unloadSkillTool,
  saveMemoryTool, recallMemoryTool,
  taskTool,
  dispatchTaskTool, taskStatusTool,
]) {
  registerTool(tool);
}
