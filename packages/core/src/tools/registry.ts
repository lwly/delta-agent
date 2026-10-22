import AjvPkg from 'ajv';
import type {
  ConfirmDecision,
  ConfirmRequest,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '@y-zero/shared';
import { AgentError } from '@y-zero/shared';
import type { AgentTool, ToolContext } from './types.js';
import {
  readFileTool, writeFileTool, editFileTool, listDirTool, globSearchTool, grepSearchTool,
} from './builtin/fs.js';
import { runCommandTool, runTestsTool } from './builtin/exec.js';
import { webFetchTool, todoWriteTool, askUserTool } from './builtin/web.js';
import { loadSkillTool, unloadSkillTool } from './builtin/skill.js';
import { saveMemoryTool, recallMemoryTool } from './builtin/memory.js';

/** minimal structural type for compiled validators (avoids ajv CJS/ESM ctor quirks) */
interface CompiledValidator {
  (data: unknown): boolean;
  errors?: unknown;
}
interface AjvLike {
  compile(schema: object): CompiledValidator;
}
const ajv = new (AjvPkg as unknown as new (opts?: object) => AjvLike)({ strict: false });

function errorsText(errors: unknown): string {
  return JSON.stringify(errors);
}

/** run_command global concurrency cap (技术方案 §4.2). */
const CMD_CONCURRENCY = 2;

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();
  private fileLocks = new Map<string, Promise<unknown>>();
  private cmdQueue: Array<() => void> = [];
  private cmdRunning = 0;

  constructor() {
    this.registerBuiltins();
  }

  registerBuiltins(): void {
    for (const t of [
      readFileTool, writeFileTool, editFileTool, listDirTool, globSearchTool, grepSearchTool,
      runCommandTool, runTestsTool, webFetchTool, todoWriteTool, askUserTool,
      loadSkillTool, unloadSkillTool,
      saveMemoryTool, recallMemoryTool,
    ]) {
      this.register(t);
    }
  }

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) {
      throw new AgentError(`tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Tool definitions for the L4 prompt layer / chat request. */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.schema,
    }));
  }

  /**
   * Execute tool calls: schema-validate, confirm high-risk tools, then run.
   * Read tools run fully parallel; write tools serialize per file path;
   * run_command respects a global concurrency cap. Results are returned in
   * the same order as the input calls (Promise.allSettled semantics).
   */
  async executeAll(calls: ToolCall[], ctx: ToolContext): Promise<ToolResult[]> {
    return Promise.all(
      calls.map((call) =>
        this.executeOne(call, ctx).catch((e) => this.errResult(call, e as Error)),
      ),
    );
  }

  private errResult(call: ToolCall, e: Error): ToolResult {
    return {
      callId: call.id,
      name: call.name,
      ok: false,
      content: `tool ${call.name} crashed: ${e.message}`,
      error: e.message,
    };
  }

  private async executeOne(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        callId: call.id, name: call.name, ok: false,
        content: `unknown tool: ${call.name}. Available: ${this.names().join(', ')}`,
        error: 'unknown_tool',
      };
    }

    // 1. schema validation (args may carry __parse_error marker)
    if (!call.args && call.argsJson) {
      const parsed = tryParse(call.argsJson);
      if (parsed) call.args = parsed;
    }
    const validate = ajv.compile(tool.schema);
    if (!validate(call.args ?? {})) {
      const msg = errorsText(validate.errors);
      return {
        callId: call.id, name: call.name, ok: false,
        content: `invalid arguments for ${call.name}: ${msg}`,
        error: 'invalid_args',
      };
    }

    // 2. confirmation for danger tools (decision #3: confirm every time)
    if (tool.danger === 'confirm') {
      const req: ConfirmRequest = {
        id: call.id,
        tool: call.name,
        args: call.args ?? {},
        reason: `工具 ${call.name} 属高危操作，需要确认`,
      };
      const decision: ConfirmDecision = await ctx.confirm(req);
      if (decision.kind === 'reject') {
        return {
          callId: call.id, name: call.name, ok: false,
          content: `用户拒绝了该操作${decision.reason ? `：${decision.reason}` : ''}。请调整方案或询问用户。`,
          error: 'rejected_by_user',
        };
      }
      if (decision.kind === 'edit') {
        call.args = decision.args;
      }
      // allow / allow_session → proceed
    }

    // 3. dispatch with concurrency policies
    if (call.name === 'run_command') {
      return this.runWithCmdSlot(() => tool.execute(call.args ?? {}, ctx));
    }
    if (call.name === 'write_file' || call.name === 'edit_file') {
      const key = String((call.args as Record<string, unknown>)?.path ?? '');
      return this.runWithFileLock(key, () => tool.execute(call.args ?? {}, ctx));
    }
    return tool.execute(call.args ?? {}, ctx);
  }

  private async runWithFileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.fileLocks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.fileLocks.set(key, next.catch(() => undefined));
    return next;
  }

  private runWithCmdSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.cmdRunning < CMD_CONCURRENCY) {
      this.cmdRunning++;
      return fn().finally(() => {
        this.cmdRunning--;
        this.cmdQueue.shift()?.();
      });
    }
    return new Promise<T>((resolve) => {
      this.cmdQueue.push(() => {
        this.cmdRunning++;
        fn().finally(() => {
          this.cmdRunning--;
          this.cmdQueue.shift()?.();
        }).then(resolve);
      });
    });
  }
}

function tryParse(json: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(json);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
