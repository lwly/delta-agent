/**
 * F-58 T5a：Router 台账单测（design-f58 §8 / 计划 T5a / AC6）。
 *
 * 覆盖：
 *  1. estTokensOf 与 openai-compatible.ts:29 同规则（CJK 1 tok/char、latin 3 chars/tok）。
 *  2. §8.2 裁剪五步逐条：桶序 / 完成桶 finished_at DESC 取 5 / 超预算按序丢弃
 *     （完成桶最旧先丢 → queued 丢 goal 留标题 → running 丢 goal）/ 永不裁项
 *     （needs_decision 与未送达 interrupt）/ 超 2× 预算降级计数摘要。
 *  3. AC6：连续 20 个任务（混合状态）后 estTokens ≤ 4000；text 不含任何 messages 内容
 *     ——ledger 是零 IO 纯函数（签名上无 messages 入口），用 goal/result 特征串断言
 *     文本只含台账自造内容（goal 超 200 字截断不含越界部分）。
 *  4. hub 注入：router 会话 prompt 含台账段；chat 会话不含（复用 router-hub.test.ts
 *     的 CapturingProvider 手法）。
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent } from '@delta/shared';
import { buildRouterLedger, estTokensOf } from '../src/router/ledger.js';
import type { InboxItem, WorkerTaskRow } from '../src/router/types.js';
import { SessionService } from '../src/session/service.js';
import { SessionHub } from '../src/server/hub.js';
import { ToolRegistry } from '../src/tools/registry.js';

// ── 纯函数脚手架 ─────────────────────────────────────────────────────────────

let seq = 0;

function makeTask(overrides: Partial<WorkerTaskRow> = {}): WorkerTaskRow {
  seq += 1;
  const now = 1_700_000_000_000 + seq * 1_000;
  const id = `wt-${String(seq).padStart(3, '0')}-xxxx`;
  return {
    id,
    project_id: 'p1',
    router_session_id: 'r1',
    title: `任务${seq}`,
    goal: `目标${seq}`,
    acceptance: null,
    role_label: null,
    executor: null,
    permission_mode: 'default',
    status: 'queued',
    priority: 1,
    depends_on: '[]',
    artifacts: '[]',
    worker_session_id: null,
    result_summary: null,
    failure_kind: null,
    decision_json: null,
    watchdog_flag: null,
    attempt: 0,
    created_at: now,
    started_at: null,
    finished_at: null,
    updated_at: now,
    ...overrides,
  };
}

function makeInterrupt(overrides: Partial<InboxItem> = {}): InboxItem {
  seq += 1;
  return {
    id: seq,
    router_session_id: 'r1',
    task_id: null,
    kind: 'needs_decision',
    severity: 'interrupt',
    payload: {},
    created_at: 1_700_000_000_000,
    delivered_at: null,
    ack_at: null,
    ...overrides,
  };
}

/** 全预算跑一次，返回完整文本（供后续按预算差值驱动确定性裁剪）。 */
function fullText(tasks: WorkerTaskRow[], interrupts: InboxItem[] = []): string {
  return buildRouterLedger({ tasks, interrupts, budget: 1_000_000 }).text;
}

// ── estTokensOf（与 openai-compatible.ts:29 同规则）─────────────────────────

describe('estTokensOf：CJK 1 tok/char、latin 3 chars/tok（§8.2）', () => {
  it('中文 100 字 → 100', () => {
    const text = '字'.repeat(100);
    expect(estTokensOf(text)).toBe(100);
  });

  it('英文 300 字符 → 100', () => {
    expect(estTokensOf('a'.repeat(300))).toBe(100);
  });

  it('混合：中文字符逐个计 1，latin 段向上取整', () => {
    // 2 CJK + 3 latin → 2 + ceil(3/3) = 3
    expect(estTokensOf('中文abc')).toBe(3);
    // 4 CJK + 1 latin → 4 + 1
    expect(estTokensOf('中文字符x')).toBe(5);
  });

  it('全角中文标点按 CJK 计（，！：），空串为 0', () => {
    expect(estTokensOf('，！：')).toBe(3);
    expect(estTokensOf('')).toBe(0);
  });
});

// ── §8.2 第 1/2 步：桶序 ─────────────────────────────────────────────────────

describe('桶序：needs_decision → running → queued；桶内 priority DESC / created_at ASC；完成桶 finished_at DESC 取 5', () => {
  it('待办桶按状态分组排序，组内 priority DESC、同优先级 created_at ASC', () => {
    const q1 = makeTask({ status: 'queued', title: 'Q低P晚', priority: 1, created_at: 200 });
    const q2 = makeTask({ status: 'queued', title: 'Q高P', priority: 5, created_at: 300 });
    const q3 = makeTask({ status: 'queued', title: 'Q低P早', priority: 1, created_at: 100 });
    const r1 = makeTask({ status: 'running', title: 'R1' });
    const n1 = makeTask({ status: 'needs_decision', title: 'N1' });
    const text = fullText([q1, r1, q2, n1, q3]);

    const idx = (t: string) => text.indexOf(t);
    expect(idx('N1')).toBeGreaterThan(-1);
    expect(idx('R1')).toBeGreaterThan(idx('N1'));
    expect(idx('Q高P')).toBeGreaterThan(idx('R1'));
    // 同优先级（priority=1）按 created_at ASC：Q低P早(100) 在 Q低P晚(200) 前
    expect(idx('Q低P早')).toBeGreaterThan(idx('Q高P'));
    expect(idx('Q低P晚')).toBeGreaterThan(idx('Q低P早'));
  });

  it('完成桶只取最近 5 条终态（finished_at DESC），更旧的不出现', () => {
    const tasks: WorkerTaskRow[] = [];
    for (let i = 1; i <= 7; i++) {
      tasks.push(
        makeTask({
          status: 'done',
          title: `完成${i}`,
          finished_at: i * 1_000,
          result_summary: `结论${i}`,
        }),
      );
    }
    const text = fullText(tasks);
    for (const i of [3, 4, 5, 6, 7]) expect(text).toContain(`完成${i}`);
    for (const i of [1, 2]) expect(text).not.toContain(`完成${i}`);
    // 新→旧：完成7 在 完成3 之前
    expect(text.indexOf('完成7')).toBeLessThan(text.indexOf('完成3'));
  });
});

// ── §8.2 第 4/5 步：裁剪 ─────────────────────────────────────────────────────

describe('裁剪第 4 步：超预算按序丢弃（完成桶最旧 → queued 丢 goal → running 丢 goal）', () => {
  it('完成桶从最旧开始丢，最新保留', () => {
    const t1 = makeTask({ status: 'done', title: '旧完成', finished_at: 1, result_summary: '旧结论标记' });
    const t2 = makeTask({ status: 'done', title: '新完成', finished_at: 2, result_summary: '新结论标记' });
    const full = fullText([t1, t2]);
    const budget = estTokensOf(full) - 1; // 恰好挤掉一行
    const { text, estTokens } = buildRouterLedger({ tasks: [t1, t2], budget });
    expect(text).not.toContain('旧完成');
    expect(text).toContain('新完成');
    expect(estTokens).toBeLessThanOrEqual(budget);
  });

  it('queued 只留标题（丢 goal），标题保留', () => {
    const q = makeTask({ status: 'queued', title: '排队任务A', goal: 'QUEUED_GOAL_特征串_不应出现' + '长'.repeat(200) });
    const full = fullText([q]);
    // 无完成桶可丢 → 直接进入 queued 丢 goal；预算取「仅标题版」刚好够
    const titleOnly = `${full.split('待办：')[0]}待办：\n[T-${q.id.slice(0, 6)}] queued 排队任务A`;
    const budget = estTokensOf(titleOnly);
    const { text } = buildRouterLedger({ tasks: [q], budget });
    expect(text).toContain('排队任务A');
    expect(text).not.toContain('QUEUED_GOAL_特征串');
  });

  it('running 丢 goal（needs_decision 不受影响，goal 保留）', () => {
    const r = makeTask({ status: 'running', title: '运行任务B', goal: 'RUNNING_GOAL_特征串_不应出现' + '长'.repeat(200) });
    const n = makeTask({ status: 'needs_decision', title: '决策任务C', goal: 'NEEDS_GOAL_特征串_必须保留' });
    const full = fullText([r, n]);
    const runningTitleOnly = `${full.split('待办：')[0]}待办：\n[T-${n.id.slice(0, 6)}] needs_decision 决策任务C｜NEEDS_GOAL_特征串_必须保留\n[T-${r.id.slice(0, 6)}] running 运行任务B`;
    const budget = estTokensOf(runningTitleOnly);
    const { text } = buildRouterLedger({ tasks: [r, n], budget });
    expect(text).toContain('运行任务B');
    expect(text).not.toContain('RUNNING_GOAL_特征串');
    // needs_decision 永不裁：goal 仍在
    expect(text).toContain('NEEDS_GOAL_特征串');
  });
});

describe('裁剪第 4 步：永不裁项（宁可超预算）', () => {
  it('needs_decision 超预算仍在（goal 与决策摘要都保留）', () => {
    const n = makeTask({
      status: 'needs_decision',
      title: '待决策D',
      goal: 'NEEDS_GOAL_永不裁' + '长'.repeat(300),
      decision_json: JSON.stringify({ reason: 'probe_failed', message: '未找到 cursor CLI，请先安装' }),
    });
    const full = fullText([n]);
    // 预算 = ceil(est/2)：必然超预算，但 ≤ 2× 预算（不触发第 5 步降级）
    const budget = Math.ceil(estTokensOf(full) / 2);
    const { text, estTokens } = buildRouterLedger({ tasks: [n], budget });
    expect(estTokens).toBeGreaterThan(budget); // 宁可超预算
    expect(text).toContain('NEEDS_GOAL_永不裁');
    expect(text).toContain('未找到 cursor CLI，请先安装');
  });

  it('未送达 interrupt 超预算仍在', () => {
    const item = makeInterrupt({
      payload: { taskId: 'wt-xyz123', title: '中断标题E', reason: 'watchdog_l2', message: '越界写入已终止' },
    });
    const full = fullText([], [item]);
    const budget = Math.ceil(estTokensOf(full) / 2);
    const { text, estTokens } = buildRouterLedger({ tasks: [], interrupts: [item], budget });
    expect(estTokens).toBeGreaterThan(budget);
    expect(text).toContain('中断标题E');
    expect(text).toContain('越界写入已终止');
  });
});

describe('裁剪第 5 步：超 2× 预算降级为计数摘要', () => {
  it('estTokens > 2×预算 → 只输出计数摘要，任务行全部消失', () => {
    const tasks = [
      makeTask({ status: 'needs_decision', title: '决策X', goal: '长'.repeat(500) }),
      makeTask({ status: 'queued', title: '排队Y', goal: '长'.repeat(500) }),
      makeTask({ status: 'queued', title: '排队Z', goal: '长'.repeat(500) }),
    ];
    // 预算 100：goal 行恒截到 200 字（~213 tok），needs_decision 永不裁 → 丢弃后仍 > 2×100 → 降级；计数摘要本身 ≪ 200
    const { text, estTokens } = buildRouterLedger({ tasks, budget: 100 });
    expect(estTokens).toBeLessThanOrEqual(200); // 2× 预算封顶
    expect(text).toContain('降级为计数摘要');
    expect(text).toContain('1 个待决策任务');
    expect(text).toContain('2 个排队任务');
    expect(text).not.toContain('决策X');
    expect(text).not.toContain('排队Y');
  });
});

// ── 决策摘要与行格式 ─────────────────────────────────────────────────────────

describe('决策摘要：decision_json 人类可读片段 ≤100 字，解析失败宽容回退', () => {
  it('优先 message，缺失回退 reason；超 100 字截断', () => {
    const n = makeTask({
      status: 'needs_decision',
      title: '摘要测试',
      decision_json: JSON.stringify({ reason: 'r1', message: '好'.repeat(150) }),
    });
    const text = fullText([n]);
    expect(text).toContain('好'.repeat(100));
    expect(text).not.toContain('好'.repeat(101));
  });

  it('message 缺失 → 用 reason；decision_json 非法 → 回退原文截断', () => {
    const r = makeTask({ status: 'needs_decision', title: '仅reason', decision_json: '{"reason":"preflight_unavailable"}' });
    const bad = makeTask({ status: 'needs_decision', title: '坏json', decision_json: 'not-json{{{' });
    const text = fullText([r, bad]);
    expect(text).toContain('preflight_unavailable');
    expect(text).toContain('not-json{{{');
  });
});

describe('行格式与投影边界（§8.2 禁止项）', () => {
  it('行格式 [T-<id 前 6 位>] <status> <title>｜goal 前 200 字', () => {
    const goal260 = 'G'.repeat(260);
    const t = makeTask({ status: 'running', title: '格式行', goal: goal260 });
    const text = fullText([t]);
    expect(text).toContain(`[T-${t.id.slice(0, 6)}] running 格式行｜${'G'.repeat(200)}`);
    expect(text).not.toContain('G'.repeat(201));
  });

  it('failed 终态行带 failure_kind；空输入只出表头', () => {
    const f = makeTask({ status: 'failed', title: '失败行', failure_kind: 'watchdog_l2', finished_at: 9 });
    const text = fullText([f]);
    expect(text).toContain(`[T-${f.id.slice(0, 6)}] failed 失败行｜watchdog_l2`);

    const empty = buildRouterLedger({ tasks: [], interrupts: [] });
    expect(empty.text).toBe('[系统] 台账（自动维护，任务状态以此为准）');
    expect(empty.estTokens).toBe(estTokensOf(empty.text));
  });
});

// ── AC6 ─────────────────────────────────────────────────────────────────────

describe('AC6：连续 20 个任务后台账 estTokens ≤ 4000，不含 messages 内容', () => {
  it('20 个混合状态任务（长 goal）→ estTokens ≤ 4000；goal 超 200 字截断；result_summary 入完成桶', () => {
    const tasks: WorkerTaskRow[] = [];
    for (let i = 1; i <= 20; i++) {
      const goal = `AC6_GOAL_${i}_特征串${'细'.repeat(120)}`;
      if (i <= 8) {
        tasks.push(makeTask({ status: 'done', title: `已完成${i}`, goal, result_summary: `AC6_RESULT_${i}_结论`, finished_at: i * 1_000 }));
      } else if (i <= 11) {
        tasks.push(makeTask({ status: 'needs_decision', title: `待决策${i}`, goal, decision_json: JSON.stringify({ reason: 'preflight', message: `原因${i}` }) }));
      } else if (i <= 15) {
        tasks.push(makeTask({ status: 'running', title: `运行中${i}`, goal }));
      } else {
        tasks.push(makeTask({ status: 'queued', title: `排队${i}`, goal }));
      }
    }
    const interrupts = [
      makeInterrupt({ payload: { taskId: tasks[0]!.id, title: '已完成1', reason: 'runtime', message: 'AC6_INTERRUPT_特征串' } }),
    ];

    const { text, estTokens } = buildRouterLedger({ tasks, interrupts });
    expect(estTokens).toBeLessThanOrEqual(4000);

    // 文本只含台账自造内容：来自 worker_tasks 投影的 goal / result_summary / inbox payload
    expect(text).toContain('AC6_GOAL_20_特征串');
    expect(text).toContain('AC6_RESULT_8_结论');
    expect(text).toContain('AC6_INTERRUPT_特征串');
    // goal 超 200 字的越界部分不出现（不含任何会话 messages 内容的结构性保证见函数签名）
    expect(text).not.toContain('细'.repeat(121));
    // messages 特征串（从未写入任何行）不可能出现
    expect(text).not.toContain('AC6_MESSAGE_ONLY_绝不在台账');
  });
});

// ── hub 注入（复用 router-hub.test.ts 的 CapturingProvider 手法）────────────

class CapturingProvider implements LLMProvider {
  readonly id = 'capture';
  readonly requests: ChatRequest[] = [];

  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(req);
    yield { type: 'text_delta', text: '完成' };
    yield { type: 'usage', input: 10, output: 5 };
    yield { type: 'done' };
  }

  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
}

const LEDGER_MARKER = '[系统] 台账（自动维护，任务状态以此为准）';

describe('hub 注入：仅 router 会话拼台账（design-f58 §8.1）', () => {
  let tmp = '';
  let service: SessionService;
  let projectId = '';

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-router-ledger-'));
    service = new SessionService(path.join(tmp, 'db.sqlite'));
    projectId = service.ensureProject(tmp).id;
  });

  afterEach(async () => {
    service.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('router 会话：系统提示词动态段含台账段与任务行', async () => {
    const provider = new CapturingProvider();
    const hub = new SessionHub({
      service,
      registry: new ToolRegistry(),
      resolveProvider: async () => provider,
      autoDistill: false,
    });
    const s = service.createSession(projectId, { model: 'test-model', mode: 'react' });
    service.store.setSessionKind(s.id, 'router');
    service.workerTasks.create({
      projectId,
      routerSessionId: s.id,
      title: 'HUB注入任务',
      goal: 'HUB_GOAL_特征串',
      status: 'queued',
    });
    service.inbox.append({
      routerSessionId: s.id,
      taskId: null,
      kind: 'needs_decision',
      severity: 'interrupt',
      payload: { taskId: 'wt-hub001', title: 'HUB中断', message: 'HUB_中断_特征串' },
    });

    await hub.send(s.id, '开始总管');

    const system = provider.requests[0]!.messages[0]!;
    expect(system.role).toBe('system');
    expect(system.content).toContain(LEDGER_MARKER);
    expect(system.content).toContain('HUB注入任务');
    expect(system.content).toContain('HUB_中断_特征串');
  });

  it('chat 会话：系统提示词不含台账段（零变化护栏）', async () => {
    const provider = new CapturingProvider();
    const hub = new SessionHub({
      service,
      registry: new ToolRegistry(),
      resolveProvider: async () => provider,
      autoDistill: false,
    });
    const chatId = service.createSession(projectId, { model: 'test-model', mode: 'react' }).id;

    await hub.send(chatId, '普通对话');

    const system = provider.requests[0]!.messages[0]!;
    expect(system.role).toBe('system');
    expect(system.content).not.toContain(LEDGER_MARKER);
  });
});
