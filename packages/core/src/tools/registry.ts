import AjvPkg from 'ajv';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import type {
  ConfirmDecision,
  ConfirmRequest,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from '@y-zero/shared';
import { AgentError } from '@y-zero/shared';
import type { AgentTool, ToolContext } from './types.js';
import { resolveInSandbox } from './sandbox.js';
import { readSnapshot } from '../session/changes.js';
import {
  readFileTool, writeFileTool, editFileTool, listDirTool, globSearchTool, grepSearchTool,
} from './builtin/fs.js';
import { runCommandTool, runTestsTool } from './builtin/exec.js';
import { webFetchTool, todoWriteTool, askUserTool } from './builtin/web.js';
import { loadSkillTool, unloadSkillTool } from './builtin/skill.js';
import { saveMemoryTool, recallMemoryTool } from './builtin/memory.js';
import { taskTool } from './builtin/task.js';

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
      taskTool,
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

    // 2. F-27 PreToolUse 钩子：可阻断（exit 2 → stderr 作为拒绝原因回传给模型）
    if (ctx.hooks?.has('PreToolUse', call.name)) {
      const verdict = await ctx.hooks.preToolUse(call.name, call.args ?? {}, {
        sessionId: ctx.sessionId,
        projectId: ctx.projectId,
      });
      if (verdict.blocked) {
        return {
          callId: call.id, name: call.name, ok: false,
          content: `PreToolUse 钩子拦截了该操作${verdict.reason ? `：${verdict.reason}` : ''}。请调整方案（如修改目标路径/命令）或跳过。`,
          error: 'hook_blocked',
        };
      }
    }

    // 3. F-23 权限判定（plan 拒写/执行；default 写需确认；yolo 放行），
    //    再衔接 danger:'confirm' 确认流（allow_session 记入会话白名单）
    const perms = ctx.permissions;
    const verdict = perms?.check(call.name, call.args);
    if (verdict?.action === 'deny') {
      return {
        callId: call.id, name: call.name, ok: false,
        content: verdict.reason,
        error: 'permission_denied',
      };
    }
    const needsConfirm =
      verdict?.action === 'confirm' ||
      // 无 permissions 注入时保持历史行为：danger 工具每次确认
      (!perms && tool.danger === 'confirm');
    if (needsConfirm && tool.danger === 'confirm') {
      // F-30：确认卡必须显示执行环境徽标（badge() 只读探测缓存，绝不触发探测）
      const badge = ctx.sandbox?.badge();
      const req: ConfirmRequest = {
        id: call.id,
        tool: call.name,
        args: call.args ?? {},
        reason: `工具 ${call.name} 属高危操作，需要确认`,
        ...(badge ? { sandbox: badge } : {}),
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
      if (decision.kind === 'allow_session') {
        perms?.allowSession(call.name); // "本会话不再询问"
      }
      // allow / allow_session → proceed
    }

    // 4. dispatch with concurrency policies
    let dispatched: Promise<ToolResult>;
    if (call.name === 'run_command') {
      dispatched = this.runWithCmdSlot(() => tool.execute(call.args ?? {}, ctx));
    } else if (call.name === 'write_file' || call.name === 'edit_file') {
      const key = String((call.args as Record<string, unknown>)?.path ?? '');
      dispatched = this.runWithFileLock(key, () => this.runWithSnapshot(call, tool, ctx));
    } else {
      dispatched = tool.execute(call.args ?? {}, ctx);
    }
    // F-27 PostToolUse 钩子：旁路记录，不阻塞、不改变结果
    void dispatched
      .then((r) => {
        if (ctx.hooks?.has('PostToolUse', call.name)) {
          return ctx.hooks.postToolUse(call.name, call.args ?? {}, r, {
            sessionId: ctx.sessionId,
            projectId: ctx.projectId,
          });
        }
        return undefined;
      })
      .catch(() => undefined);
    return dispatched;
  }

  /**
   * F-24：写工具执行前后自动快照，成功后记录变更（供 diff 汇总/回滚）。
   * 快照失败不阻断执行（记录能力是尽力而为）。
   */
  private async runWithSnapshot(
    call: ToolCall,
    tool: AgentTool,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const args = call.args ?? {};
    const changes = ctx.changes;
    const rel = String(args['path'] ?? '');
    if (!changes || !ctx.sessionId || !rel) return tool.execute(args, ctx);

    let abs = '';
    let before: Awaited<ReturnType<typeof readSnapshot>> = { content: null, oversized: false };
    try {
      abs = await resolveInSandbox(ctx.projectRoot, rel);
      before = await readSnapshot(abs);
    } catch {
      return tool.execute(args, ctx); // 沙箱校验失败交给工具自身报错
    }

    const result = await tool.execute(args, ctx);
    if (!result.ok) return result;

    try {
      const after = await readSnapshot(abs);
      // 归一化用 realpath 基准（macOS /var → /private/var 符号链接），存相对路径
      const base = await fs.realpath(ctx.projectRoot).catch(() => path.resolve(ctx.projectRoot));
      const normalized = path.relative(base, abs);
      changes.record(ctx.sessionId, {
        tool: call.name,
        path: normalized,
        before: before.content,
        after: after.content,
        beforeOversized: before.oversized,
        afterOversized: after.oversized,
      });
    } catch {
      // 快照记录失败不影响执行结果
    }
    return result;
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
