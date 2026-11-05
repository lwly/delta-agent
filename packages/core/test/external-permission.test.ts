/**
 * F-55 外部权限桥接单测（docs/design-f55-external-cli-agents.md §5.1）：
 * 权限三档（plan/default/yolo）在 permission_request 上的映射语义 + plan 档启动门禁。
 * adapter 用内联 AsyncGenerator 脚本化吐事件（复用 external-mapper.test.ts 的模式），
 * permissions 用真实 PermissionState 验证 allow_session 会话记忆闭环。
 */
import { describe, expect, it } from 'vitest';
import type { AgentEvent, ConfirmDecision, ConfirmRequest } from '@delta/shared';
import { runExternalAgent } from '../src/engine/external.js';
import type { RunContext } from '../src/engine/react.js';
import { registerExternalAdapter } from '../src/external/registry.js';
import type { ExternalAgentAdapter, ExternalAgentSpec, ExternalEvent } from '../src/external/types.js';
import { PermissionState } from '../src/tools/permissions.js';

const MODEL = 'cli:fake';

function baseSpec(overrides: Partial<ExternalAgentSpec> = {}): ExternalAgentSpec {
  return {
    id: MODEL,
    kind: 'stream-json-jsonl',
    command: 'fake-cli',
    args: [],
    tier: 'B',
    version: '0.0.0-test',
    permissionArgs: { plan: [], default: [], yolo: [] },
    ...overrides,
  };
}

/** 内联 adapter：按脚本吐 ExternalEvent，记录 run 入参与 respondPermission 回包 */
function scriptAdapter(
  script: ExternalEvent[],
  opts: { spec?: Partial<ExternalAgentSpec> } = {},
): ExternalAgentAdapter & { captures: unknown[]; decisions: Array<{ id: string; decision: string }> } {
  const self: ExternalAgentAdapter & { captures: unknown[]; decisions: Array<{ id: string; decision: string }> } = {
    spec: baseSpec(opts.spec),
    captures: [],
    decisions: [],
    run: async function* (req) {
      self.captures.push(req);
      for (const ev of script) yield ev;
    },
  };
  self.respondPermission = (id, decision) => {
    self.decisions.push({ id, decision });
  };
  return self;
}

/** 极简 RunContext：只填 runExternalAgent 用到的字段；permissions 传真实 PermissionState */
function makeCtx(opts: {
  confirm?: (req: ConfirmRequest) => Promise<ConfirmDecision>;
  permissions?: PermissionState;
  model?: string;
} = {}): RunContext {
  const confirm = opts.confirm ?? (async () => ({ kind: 'allow' }) as ConfirmDecision);
  return {
    sessionId: 's_test',
    projectId: 'p_test',
    mode: 'react',
    model: opts.model ?? MODEL,
    systemPrompt: '',
    maxTurns: 1,
    signal: new AbortController().signal,
    provider: {} as never,
    registry: {} as never,
    toolContext: {
      projectRoot: '/tmp/fake-project',
      signal: new AbortController().signal,
      confirm,
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    },
    budget: {} as never,
    windowTokens: 100_000,
  } as unknown as RunContext;
}

async function collect(ctx: RunContext, input = '你好'): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of runExternalAgent(ctx, [], input)) events.push(ev);
  return events;
}

const permReq = (overrides: Partial<Extract<ExternalEvent, { type: 'permission_request' }>> = {}): ExternalEvent => ({
  type: 'permission_request',
  id: 'perm_1',
  tool: 'exec',
  argsJson: '{"cmd":"ls -la"}',
  options: ['allow', 'reject'],
  ...overrides,
});

/** plan 档 Tier B 正常启动的前提：上游有只读 flags（否则启动门禁直接拒绝，见启动门禁 describe） */
const planFlags = { permissionArgs: { plan: ['--permission-mode plan'], default: [], yolo: [] } };

describe('runExternalAgent 权限桥接（F-55 §5.1 三档映射）', () => {
  describe('plan 档', () => {
    it.each(['execute', 'edit', 'delete', 'move', undefined] as const)(
      '写/执行类与未知 toolKind（%j）→ respondPermission 收到 reject，不弹确认卡，有非致命提示',
      async (toolKind) => {
        const confirmCalls: ConfirmRequest[] = [];
        const adapter = scriptAdapter(
          [permReq({ toolKind }), { type: 'done', exitCode: 0 }],
          { spec: planFlags },
          // 未知即拒（安全默认）：toolKind 缺省时无法证明只读，宁可拒绝也不放行写/执行副作用
        );
        registerExternalAdapter(adapter);
        const events = await collect(
          makeCtx({
            permissions: new PermissionState({ mode: 'plan' }),
            confirm: async (req) => {
              confirmCalls.push(req);
              return { kind: 'allow' };
            },
          }),
        );

        expect(adapter.decisions).toEqual([{ id: 'perm_1', decision: 'reject' }]);
        expect(confirmCalls).toHaveLength(0); // plan 档不走确认流
        const errs = events.filter((e) => e.type === 'error');
        expect(errs).toHaveLength(1);
        expect(errs[0]).toMatchObject({
          type: 'error',
          message: `外部 agent 的 exec 请求在 plan 档被拒绝（写/执行类操作）`,
          fatal: false,
        });
        expect(events.at(-1)?.type).toBe('done');
      },
    );

    it('只读类 toolKind=read → 自动放行（respondPermission 收到 allow，不弹卡无报错）', async () => {
      // 依据：PermissionState.check 在 plan 档对只读工具（toolCapability === 'read'）
      // 直接 { action: 'allow' }，从不走确认 —— 外部映射保持同语义
      const adapter = scriptAdapter([permReq({ toolKind: 'read' }), { type: 'done', exitCode: 0 }], {
        spec: planFlags,
      });
      registerExternalAdapter(adapter);
      const events = await collect(makeCtx({ permissions: new PermissionState({ mode: 'plan' }) }));

      expect(adapter.decisions).toEqual([{ id: 'perm_1', decision: 'allow' }]);
      expect(events.filter((e) => e.type === 'error')).toEqual([]);
      expect(events.at(-1)?.type).toBe('done');
    });
  });

  describe('yolo 档', () => {
    it('全放行：respondPermission 收到 allow，confirm 未被调用，无 error', async () => {
      const confirmCalls: ConfirmRequest[] = [];
      const adapter = scriptAdapter([permReq({ toolKind: 'execute' }), { type: 'done', exitCode: 0 }]);
      registerExternalAdapter(adapter);
      const events = await collect(
        makeCtx({
          permissions: new PermissionState({ mode: 'yolo' }),
          confirm: async (req) => {
            confirmCalls.push(req);
            return { kind: 'reject' };
          },
        }),
      );

      expect(adapter.decisions).toEqual([{ id: 'perm_1', decision: 'allow' }]);
      expect(confirmCalls).toHaveLength(0);
      expect(events.filter((e) => e.type === 'error')).toEqual([]);
    });
  });

  describe('default 档', () => {
    it('allow_session 记忆：第一次走 confirm 并记入会话白名单，第二次同工具自动 allow', async () => {
      const confirmCalls: ConfirmRequest[] = [];
      const permissions = new PermissionState({ mode: 'default' });
      const adapter = scriptAdapter([
        permReq({ id: 'perm_1', tool: 'run_command' }),
        permReq({ id: 'perm_2', tool: 'run_command' }),
        { type: 'done', exitCode: 0 },
      ]);
      registerExternalAdapter(adapter);
      const events = await collect(
        makeCtx({
          permissions,
          confirm: async (req) => {
            confirmCalls.push(req);
            return { kind: 'allow_session', tool: req.tool };
          },
        }),
      );

      // 第一次：走 confirm → 回包 allow_session；会话记忆已记入
      expect(confirmCalls).toHaveLength(1);
      expect(adapter.decisions).toEqual([
        { id: 'perm_1', decision: 'allow_session' },
        { id: 'perm_2', decision: 'allow' },
      ]);
      expect(permissions.isSessionAllowed('run_command')).toBe(true);
      expect(events.filter((e) => e.type === 'error')).toEqual([]);
    });

    it('headless 形态：confirm 自动 reject → respondPermission 收到 reject（无需新代码路径）', async () => {
      const adapter = scriptAdapter([permReq(), { type: 'done', exitCode: 0 }]);
      registerExternalAdapter(adapter);
      await collect(makeCtx({ confirm: async () => ({ kind: 'reject' }) }));

      expect(adapter.decisions).toEqual([{ id: 'perm_1', decision: 'reject' }]);
    });

    it('allowlist 已含该工具 → 自动 allow，不弹确认卡', async () => {
      const confirmCalls: ConfirmRequest[] = [];
      const adapter = scriptAdapter([permReq({ tool: 'run_command' }), { type: 'done', exitCode: 0 }]);
      registerExternalAdapter(adapter);
      await collect(
        makeCtx({
          permissions: new PermissionState({ mode: 'default', allowlist: ['run_command'] }),
          confirm: async (req) => {
            confirmCalls.push(req);
            return { kind: 'reject' };
          },
        }),
      );

      expect(adapter.decisions).toEqual([{ id: 'perm_1', decision: 'allow' }]);
      expect(confirmCalls).toHaveLength(0);
    });
  });

  describe('启动门禁（plan 档能力降级拒绝）', () => {
    it("Tier B + plan 档 + permissionArgs.plan=[] → external_no_plan_mode 致命错误 + done，adapter 不启动", async () => {
      const adapter = scriptAdapter([{ type: 'done', exitCode: 0 }]);
      registerExternalAdapter(adapter);
      const events = await collect(makeCtx({ permissions: new PermissionState({ mode: 'plan' }) }));

      const errs = events.filter((e) => e.type === 'error');
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatchObject({
        type: 'error',
        message: `external_no_plan_mode: 外部 agent ${MODEL} 不支持只读档，拒绝启动（plan 档）`,
        fatal: true,
      });
      expect(events.at(-1)).toEqual({
        type: 'done',
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      });
      expect(adapter.captures).toHaveLength(0); // adapter.run 未被调用
    });

    it('同 spec 但 permissionArgs.plan 非空 → 正常启动（adapter.run 被调用）', async () => {
      const adapter = scriptAdapter([{ type: 'done', exitCode: 0 }], {
        spec: { permissionArgs: { plan: ['--plan'], default: [], yolo: [] } },
      });
      registerExternalAdapter(adapter);
      const events = await collect(makeCtx({ permissions: new PermissionState({ mode: 'plan' }) }));

      expect(adapter.captures).toHaveLength(1);
      expect(adapter.captures[0]).toMatchObject({ permissionMode: 'plan' });
      expect(events.filter((e) => e.type === 'error')).toEqual([]);
      expect(events.at(-1)?.type).toBe('done');
    });

    it("Tier A + plan=[] 不受门禁：正常启动并走逐次拦截（execute → reject）", async () => {
      const adapter = scriptAdapter(
        [permReq({ toolKind: 'execute' }), { type: 'done', exitCode: 0 }],
        { spec: { tier: 'A' } },
      );
      registerExternalAdapter(adapter);
      const events = await collect(makeCtx({ permissions: new PermissionState({ mode: 'plan' }) }));

      expect(adapter.captures).toHaveLength(1); // Tier A 内建 request_permission 逐次拦截，不受门禁
      expect(adapter.decisions).toEqual([{ id: 'perm_1', decision: 'reject' }]);
      const errs = events.filter((e) => e.type === 'error');
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatchObject({ fatal: false });
    });

    it("Tier C（cli:codex，app-server-jsonl）+ plan 档 + permissionArgs.plan=[] → external_no_plan_mode 拒绝启动", async () => {
      // Codex 无只读 plan 模式（设计稿 §5.1 Tier C 弱权限）：零适配器代码，靠同一门禁拒绝
      const adapter = scriptAdapter([{ type: 'done', exitCode: 0 }], {
        spec: { id: 'cli:codex', kind: 'app-server-jsonl', tier: 'C' },
      });
      registerExternalAdapter(adapter);
      const events = await collect(makeCtx({ model: 'cli:codex', permissions: new PermissionState({ mode: 'plan' }) }));

      const errs = events.filter((e) => e.type === 'error');
      expect(errs).toHaveLength(1);
      expect(errs[0]).toMatchObject({
        type: 'error',
        message: 'external_no_plan_mode: 外部 agent cli:codex 不支持只读档，拒绝启动（plan 档）',
        fatal: true,
      });
      expect(events.at(-1)).toEqual({
        type: 'done',
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      });
      expect(adapter.captures).toHaveLength(0); // adapter.run 未被调用
    });
  });
});
