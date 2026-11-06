/**
 * F-58 Task T1：WorkerTaskStore / InboxStore 单测。
 * 状态机合法边/非法迁移、原子认领、幂等送达、台账桶序（对齐设计稿 §7.4/§8.2）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionService } from '../src/index.js';
import { toWorkerTaskView } from '../src/router/store.js';

const dirs: string[] = [];
async function tmpSvc(): Promise<SessionService> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-f58-store-'));
  dirs.push(dir);
  return new SessionService(path.join(dir, 'test.db'));
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true });
});

async function setup() {
  const svc = await tmpSvc();
  const pid = svc.ensureProject('/tmp/demo-f58-store').id;
  const router = svc.createSession(pid, { title: '总管' });
  svc.store.setSessionKind(router.id, 'router');
  return { svc, pid, routerId: router.id };
}

function createTask(
  svc: SessionService,
  routerId: string,
  overrides?: Partial<{ title: string; priority: number; status: 'draft' | 'queued' }>,
) {
  return svc.workerTasks.create({
    projectId: svc.store.getSession(routerId)!.project_id,
    routerSessionId: routerId,
    title: overrides?.title ?? '登录页',
    goal: '实现登录页与表单校验',
    priority: overrides?.priority,
    status: overrides?.status,
  });
}

describe('WorkerTaskStore', () => {
  it('create：缺省 queued / default 档 / depends_on 空数组；draft 需显式', async () => {
    const { svc, routerId } = await setup();
    const t = createTask(svc, routerId);
    expect(t.status).toBe('queued');
    expect(t.permission_mode).toBe('default');
    expect(t.priority).toBe(1);
    expect(t.attempt).toBe(0);
    expect(t.depends_on).toBe('[]');
    expect(t.worker_session_id).toBeNull();

    const draft = createTask(svc, routerId, { status: 'draft', title: '草稿' });
    expect(draft.status).toBe('draft');
  });

  it('list：priority DESC, created_at ASC 桶序；支持 projectId/status/limit 过滤', async () => {
    const { svc, routerId } = await setup();
    const low = createTask(svc, routerId, { title: '低优先', priority: 0 });
    const high = createTask(svc, routerId, { title: '高优先', priority: 5 });
    createTask(svc, routerId, { title: '草稿不放行', status: 'draft' });

    const all = svc.workerTasks.list({ routerSessionId: routerId });
    // priority DESC：5 → 1 → 0
    expect(all.map((r) => r.title)).toEqual(['高优先', '草稿不放行', '低优先']);

    expect(svc.workerTasks.list({ routerSessionId: routerId, status: 'queued' }).map((r) => r.title)).toEqual([
      '高优先',
      '低优先',
    ]);
    expect(svc.workerTasks.list({ routerSessionId: routerId, limit: 1 }).length).toBe(1);
    expect(low.id).not.toBe(high.id);
  });

  it('claimSlot：单条 UPDATE 原子认领，queued → preflight 且 attempt+1；并发两次只有一次成功', async () => {
    const { svc, routerId } = await setup();
    const t = createTask(svc, routerId);
    expect(svc.workerTasks.claimSlot(t.id)).toBe(true);
    const claimed = svc.workerTasks.get(t.id);
    expect(claimed.status).toBe('preflight');
    expect(claimed.attempt).toBe(1);

    // 第二次认领同一条：WHERE status='queued' 不命中（changes===0）
    expect(svc.workerTasks.claimSlot(t.id)).toBe(false);
    expect(svc.workerTasks.get(t.id).attempt).toBe(1);
  });

  it('状态机合法边：queued → preflight → running → done 全程可走通', async () => {
    const { svc, routerId } = await setup();
    const t = createTask(svc, routerId);
    svc.workerTasks.claimSlot(t.id);
    svc.workerTasks.transition(t.id, 'running', { workerSessionId: 's-worker-1' });
    svc.workerTasks.setResult(t.id, '登录页完成，表单校验通过');
    const finished = svc.workerTasks.transition(t.id, 'done');
    expect(finished.status).toBe('done');
    expect(finished.started_at).not.toBeNull();
    expect(finished.finished_at).not.toBeNull();
    expect(finished.worker_session_id).toBe('s-worker-1');
    expect(svc.workerTasks.get(t.id).result_summary).toBe('登录页完成，表单校验通过');
  });

  it('非法迁移抛错：done → running、queued → running、终态无出边', async () => {
    const { svc, routerId } = await setup();
    const t = createTask(svc, routerId);
    svc.workerTasks.claimSlot(t.id);
    svc.workerTasks.transition(t.id, 'running');
    svc.workerTasks.transition(t.id, 'done');

    expect(() => svc.workerTasks.transition(t.id, 'running')).toThrow('非法状态迁移');
    // queued → running 必须经过 preflight（跳级非法）
    const t2 = createTask(svc, routerId, { title: '跳级' });
    expect(() => svc.workerTasks.transition(t2.id, 'running')).toThrow('非法状态迁移');
    // failed → queued 也非法（重试走 needs_decision → queued，attempt 血缘）
    const t3 = createTask(svc, routerId, { title: '失败后' });
    svc.workerTasks.claimSlot(t3.id);
    svc.workerTasks.transition(t3.id, 'running');
    svc.workerTasks.transition(t3.id, 'failed', { failureKind: 'runtime' });
    expect(() => svc.workerTasks.transition(t3.id, 'queued')).toThrow('非法状态迁移');
  });

  it('failed 必须显式 failure_kind；failureKind 只在 failed 时可写', async () => {
    const { svc, routerId } = await setup();
    const t = createTask(svc, routerId);
    svc.workerTasks.claimSlot(t.id);
    svc.workerTasks.transition(t.id, 'running');
    expect(() => svc.workerTasks.transition(t.id, 'failed')).toThrow('failure_kind');
    expect(() => svc.workerTasks.transition(t.id, 'done', { failureKind: 'runtime' })).toThrow('failure_kind');
  });

  it('needs_decision → queued（裁决 retry）attempt+1；不占并发槽位', async () => {
    const { svc, routerId } = await setup();
    const t = createTask(svc, routerId);
    svc.workerTasks.claimSlot(t.id); // attempt=1
    svc.workerTasks.transition(t.id, 'needs_decision');
    svc.workerTasks.setDecision(t.id, { reason: 'preflight', message: 'CLI 未安装' });

    expect(svc.workerTasks.countRunning(routerId)).toBe(0); // 不占槽位
    const requeued = svc.workerTasks.transition(t.id, 'queued', { attemptIncrement: true });
    expect(requeued.attempt).toBe(2);
    expect(svc.workerTasks.get(t.id).decision_json).toContain('preflight');
  });

  it('needs_decision → done（裁决 accept）收敛终态', async () => {
    const { svc, routerId } = await setup();
    const t = createTask(svc, routerId);
    svc.workerTasks.claimSlot(t.id);
    svc.workerTasks.transition(t.id, 'needs_decision');
    const accepted = svc.workerTasks.transition(t.id, 'done');
    expect(accepted.status).toBe('done');
    expect(accepted.finished_at).not.toBeNull();
  });

  it('countRunning 只数 preflight + running；running → canceled 合法；preflight 不可直接取消', async () => {
    const { svc, routerId } = await setup();
    const a = createTask(svc, routerId, { title: 'A' });
    const b = createTask(svc, routerId, { title: 'B' });
    svc.workerTasks.claimSlot(a.id);
    expect(svc.workerTasks.countRunning(routerId)).toBe(1);
    svc.workerTasks.transition(a.id, 'running');
    svc.workerTasks.claimSlot(b.id);
    expect(svc.workerTasks.countRunning(routerId)).toBe(2);

    // 设计稿 §7.4：preflight 只有 running/needs_decision 两条出边（窗口极短，取消走 needs_decision 或等进入 running）
    expect(() => svc.workerTasks.transition(b.id, 'canceled')).toThrow('非法状态迁移');
    svc.workerTasks.transition(b.id, 'running');
    svc.workerTasks.transition(b.id, 'canceled');
    expect(svc.workerTasks.countRunning(routerId)).toBe(1);
    expect(svc.workerTasks.get(b.id).failure_kind).toBeNull();
  });

  it('listTerminalSince：按 finished_at DESC 返回终态行', async () => {
    const { svc, routerId } = await setup();
    const before = Date.now() - 10_000;
    const a = createTask(svc, routerId, { title: '早完成' });
    svc.workerTasks.claimSlot(a.id);
    svc.workerTasks.transition(a.id, 'running');
    svc.workerTasks.transition(a.id, 'done');
    // 伪造较早的 finished_at 验证 since 过滤
    svc.store.db.prepare('UPDATE worker_tasks SET finished_at = ? WHERE id = ?').run(before, a.id);

    const b = createTask(svc, routerId, { title: '刚失败' });
    svc.workerTasks.claimSlot(b.id);
    svc.workerTasks.transition(b.id, 'running');
    svc.workerTasks.transition(b.id, 'failed', { failureKind: 'watchdog_l2' });

    const sinceNow = svc.workerTasks.listTerminalSince(routerId, Date.now() - 5_000);
    expect(sinceNow.map((r) => r.title)).toEqual(['刚失败']);
    expect(sinceNow[0]!.failure_kind).toBe('watchdog_l2');

    const sinceAll = svc.workerTasks.listTerminalSince(routerId, 0);
    expect(sinceAll.map((r) => r.status)).toEqual(['failed', 'done']); // DESC
  });

  it('toWorkerTaskView：JSON 列解析 + decision 解析；损坏 JSON 回退空值不炸', async () => {
    const { svc, routerId } = await setup();
    const t = createTask(svc, routerId);
    svc.workerTasks.transition(t.id, 'canceled');
    const view = toWorkerTaskView(svc.workerTasks.get(t.id));
    expect(view.depends_on).toEqual([]);
    expect(view.artifacts).toEqual([]);
    expect(view.decision).toBeNull();

    // 带依赖、产物与损坏的 decision_json
    svc.store.db
      .prepare('UPDATE worker_tasks SET depends_on = ?, artifacts = ?, decision_json = ? WHERE id = ?')
      .run('["wt-a"]', '[{"kind":"file","ref":"src/a.ts"}]', 'not-json', t.id);
    const dirty = toWorkerTaskView(svc.workerTasks.get(t.id));
    expect(dirty.depends_on).toEqual(['wt-a']);
    expect(dirty.artifacts).toEqual([{ kind: 'file', ref: 'src/a.ts' }]);
    expect(dirty.decision).toBeNull();
  });

  it('红线：role_label 只是标签——store 提供写入但不参与任何查询过滤', async () => {
    const { svc, routerId } = await setup();
    const t = createTask(svc, routerId);
    svc.store.db.prepare('UPDATE worker_tasks SET role_label = ? WHERE id = ?').run('前端', t.id);
    // list 不接受 role_label 参数（类型上即不存在）；结果与标签无关
    const rows = svc.workerTasks.list({ routerSessionId: routerId });
    expect(rows.length).toBe(1);
    expect(rows[0]!.role_label).toBe('前端');
  });
});

describe('InboxStore', () => {
  it('append/listUndelivered：payload 解析、severity/kind 往返、task_id 可空', async () => {
    const { svc, routerId } = await setup();
    svc.inbox.append({
      routerSessionId: routerId,
      taskId: 'wt-1',
      kind: 'task_done',
      severity: 'silent',
      payload: { title: '登录页' },
    });
    const digest = svc.inbox.append({
      routerSessionId: routerId,
      kind: 'digest',
      severity: 'batch',
      payload: { summary: '2 条终态' },
    });
    expect(digest.task_id).toBeNull();

    const undelivered = svc.inbox.listUndelivered(routerId);
    expect(undelivered.length).toBe(2);
    expect(undelivered[0]!.payload).toEqual({ title: '登录页' });
    expect(undelivered[1]!.severity).toBe('batch');

    expect(svc.inbox.listUndelivered(routerId, { severity: 'batch' }).length).toBe(1);
    expect(svc.inbox.listUndelivered(routerId, { severity: 'interrupt' }).length).toBe(0);
  });

  it('markDelivered 幂等：重复调用不报错、delivered_at 不被覆盖', async () => {
    const { svc, routerId } = await setup();
    const item = svc.inbox.append({
      routerSessionId: routerId,
      kind: 'needs_decision',
      severity: 'interrupt',
      payload: {},
    });
    const t0 = 1_000;
    svc.inbox.markDelivered([item.id], t0);
    expect(svc.inbox.get(item.id).delivered_at).toBe(t0);

    // 幂等：再标记不同时间不覆盖
    svc.inbox.markDelivered([item.id], 2_000);
    expect(svc.inbox.get(item.id).delivered_at).toBe(t0);

    // 空数组不炸
    expect(() => svc.inbox.markDelivered([], t0)).not.toThrow();
  });

  it('unmarkDelivered：send 失败回滚为 NULL；lastDeliveredAt = MAX(delivered_at)', async () => {
    const { svc, routerId } = await setup();
    const a = svc.inbox.append({ routerSessionId: routerId, kind: 'task_failed', severity: 'interrupt', payload: {} });
    const b = svc.inbox.append({ routerSessionId: routerId, kind: 'digest', severity: 'batch', payload: {} });

    expect(svc.inbox.lastDeliveredAt(routerId)).toBeNull();
    svc.inbox.markDelivered([a.id, b.id], 5_000);
    expect(svc.inbox.lastDeliveredAt(routerId)).toBe(5_000);
    expect(svc.inbox.listUndelivered(routerId).length).toBe(0);

    svc.inbox.unmarkDelivered([a.id, b.id]);
    expect(svc.inbox.listUndelivered(routerId).length).toBe(2);
    expect(svc.inbox.lastDeliveredAt(routerId)).toBeNull();
  });
});

describe('SessionService 装配（T1 完成判据）', () => {
  it('workerTasks / inbox 与 tasks/memory/changes 同风格挂载且可用', async () => {
    const { svc, pid, routerId } = await setup();
    expect(svc.workerTasks).toBeTruthy();
    expect(svc.inbox).toBeTruthy();
    const t = createTask(svc, routerId);
    expect(t.project_id).toBe(pid);
    // 同库连接：直接 SQL 可见
    const row = svc.store.db.prepare('SELECT status FROM worker_tasks WHERE id = ?').get(t.id) as { status: string };
    expect(row.status).toBe('queued');
  });
});
