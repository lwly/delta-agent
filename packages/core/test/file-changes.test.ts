/**
 * F-24 文件变更管理：写快照 + 会话级 diff 汇总 + 一键回滚。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { ConfirmDecision, ToolCall } from '@delta/shared';
import { SessionStore } from '../src/session/store.js';
import { FileChangeStore, countLineDelta, MAX_SNAPSHOT_BYTES } from '../src/session/changes.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolContext } from '../src/tools/types.js';

// ── 纯函数 ───────────────────────────────────────────────────────────────────

describe('countLineDelta', () => {
  it('新建文件：全部记 added', () => {
    expect(countLineDelta(null, 'a\nb\nc')).toEqual({ added: 3, removed: 0 });
  });
  it('删除文件：全部记 removed', () => {
    expect(countLineDelta('a\nb', null)).toEqual({ added: 0, removed: 2 });
  });
  it('修改：相同行抵消', () => {
    expect(countLineDelta('a\nb\nc', 'a\nx\nc\nd')).toEqual({ added: 2, removed: 1 });
  });
  it('无变化：0/0', () => {
    expect(countLineDelta('a\nb', 'a\nb')).toEqual({ added: 0, removed: 0 });
  });
});

// ── FileChangeStore ──────────────────────────────────────────────────────────

describe('FileChangeStore', () => {
  let tmpRoot = '';
  let store: SessionStore;
  let changes: FileChangeStore;

  beforeEach(async () => {
    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yz-fc-'));
    store = new SessionStore(path.join(tmpRoot, 'test.db'));
    changes = new FileChangeStore(store.db);
  });

  it('record/list 往返', () => {
    const id = changes.record('s1', { tool: 'write_file', path: 'a.txt', before: null, after: 'v1' });
    expect(changes.get('s1', id)?.tool).toBe('write_file');
    expect(changes.list('s1')).toHaveLength(1);
    expect(changes.list('s2')).toHaveLength(0); // 会话隔离
  });

  it('summary 按文件聚合变更次数与行数', () => {
    changes.record('s1', { tool: 'write_file', path: 'a.txt', before: null, after: 'l1\nl2\nl3' });
    changes.record('s1', { tool: 'edit_file', path: 'a.txt', before: 'l1\nl2\nl3', after: 'l1\nx\nl3\nl4' });
    changes.record('s1', { tool: 'write_file', path: 'b.txt', before: null, after: 'hello' });
    const s = changes.summary('s1');
    expect(s).toHaveLength(2);
    const a = s.find((i) => i.path === 'a.txt')!;
    expect(a.changes).toBe(2);
    expect(a.added).toBe(5); // 新建 3 行 + 修改新增 x,l4
    expect(a.removed).toBe(1); // l2
    expect(a.lastChangeId).toBe(2);
  });

  it('countAfter 支持检查点锚点', () => {
    changes.record('s1', { tool: 'write_file', path: 'a', before: null, after: '1' });
    const second = changes.record('s1', { tool: 'write_file', path: 'b', before: null, after: '2' });
    changes.record('s1', { tool: 'write_file', path: 'c', before: null, after: '3' });
    expect(changes.countAfter('s1')).toBe(3);
    expect(changes.countAfter('s1', second)).toBe(1);
  });

  it('rollbackTo：新建文件回滚即删除，修改恢复 before 内容', async () => {
    // 1) 新建 a.txt = v1（change 1）
    fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'v1');
    changes.record('s1', { tool: 'write_file', path: 'a.txt', before: null, after: 'v1' });
    // 2) 修改为 v2（change 2）
    fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'v2');
    changes.record('s1', { tool: 'write_file', path: 'a.txt', before: 'v1', after: 'v2' });

    // 回滚到 change 1 之后（即撤销 change 2）→ 恢复 v1
    const res = await changes.rollbackTo('s1', tmpRoot, 1);
    expect(res.reverted).toEqual([{ id: 2, path: 'a.txt', action: 'restored' }]);
    expect(fs.readFileSync(path.join(tmpRoot, 'a.txt'), 'utf8')).toBe('v1');

    // 全量回滚：change 1 尚未应用过 → 撤销新建 = 删除
    const res2 = await changes.rollbackTo('s1', tmpRoot);
    expect(res2.reverted).toEqual([{ id: 1, path: 'a.txt', action: 'deleted' }]);
    expect(fs.existsSync(path.join(tmpRoot, 'a.txt'))).toBe(false);

    // 新变更 3（写入 v3）→ 回滚后恢复 change 3 的 before 内容
    fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'v3');
    changes.record('s1', { tool: 'write_file', path: 'a.txt', before: 'v1', after: 'v3' });
    const res3 = await changes.rollbackTo('s1', tmpRoot);
    expect(res3.reverted).toEqual([{ id: 3, path: 'a.txt', action: 'restored' }]);
    expect(fs.readFileSync(path.join(tmpRoot, 'a.txt'), 'utf8')).toBe('v1');
  });

  it('rollbackTo：超大快照跳过（无法还原）', async () => {
    const big = 'x'.repeat(MAX_SNAPSHOT_BYTES + 1);
    fs.writeFileSync(path.join(tmpRoot, 'big.txt'), big);
    // 写前已存在且超大：before 内容未存（oversized 标记）
    changes.record('s1', {
      tool: 'write_file', path: 'big.txt',
      before: null, after: null,
      beforeOversized: true, afterOversized: true,
    });
    const res = await changes.rollbackTo('s1', tmpRoot);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]!.reason).toContain('oversized');
    expect(fs.existsSync(path.join(tmpRoot, 'big.txt'))).toBe(true);
  });

  it('rollbackTo：沙箱外路径跳过不抛错', () => {
    changes.record('s1', { tool: 'write_file', path: '../escape.txt', before: null, after: 'x' });
    return expect(changes.rollbackTo('s1', tmpRoot)).resolves.toMatchObject({
      reverted: [],
      skipped: [{ path: '../escape.txt' }],
    });
  });
});

// ── registry 自动快照集成 ─────────────────────────────────────────────────────

describe('registry 写工具自动快照', () => {
  let tmpRoot = '';
  let store: SessionStore;
  let changes: FileChangeStore;

  beforeEach(async () => {
    tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yz-fc2-'));
    store = new SessionStore(path.join(tmpRoot, 'test.db'));
    changes = new FileChangeStore(store.db);
  });

  function makeCtx(): ToolContext {
    return {
      projectRoot: tmpRoot,
      signal: new AbortController().signal,
      sessionId: 's1',
      confirm: async (): Promise<ConfirmDecision> => ({ kind: 'allow' }),
      askUser: async () => 'ok',
      todos: [],
      changes,
    };
  }

  const call = (name: string, args: Record<string, unknown>): ToolCall => ({
    id: 'c1', name, argsJson: JSON.stringify(args), args,
  });

  it('write_file 成功后记录变更，路径归一化为相对路径', async () => {
    const registry = new ToolRegistry();
    const r = await registry.executeAll([call('write_file', { path: 'sub/a.txt', content: 'hello' })], makeCtx());
    expect(r[0]!.ok).toBe(true);
    const rows = changes.list('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.path).toBe('sub/a.txt');
    expect(rows[0]!.before_content).toBeNull(); // 新建
    expect(rows[0]!.after_content).toBe('hello');
  });

  it('edit_file 前后快照正确；失败调用不记录', async () => {
    const registry = new ToolRegistry();
    fs.writeFileSync(path.join(tmpRoot, 'a.txt'), 'one two');
    await registry.executeAll(
      [call('edit_file', { path: 'a.txt', old_string: 'one', new_string: 'ONE' })],
      makeCtx(),
    );
    const rows = changes.list('s1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.before_content).toBe('one two');
    expect(rows[0]!.after_content).toBe('ONE two');

    // 失败调用（old_string 不存在）→ 不记录
    const r2 = await registry.executeAll(
      [call('edit_file', { path: 'a.txt', old_string: 'ghost', new_string: 'x' })],
      makeCtx(),
    );
    expect(r2[0]!.ok).toBe(false);
    expect(changes.list('s1')).toHaveLength(1);
  });

  it('未注入 changes 时不记录、行为不变', async () => {
    const registry = new ToolRegistry();
    const ctx = { ...makeCtx(), changes: undefined };
    const r = await registry.executeAll([call('write_file', { path: 'a.txt', content: 'x' })], ctx);
    expect(r[0]!.ok).toBe(true);
    expect(changes.list('s1')).toHaveLength(0);
  });

  it('端到端：写 → 改 → 回滚全部 → 文件删除', async () => {
    const registry = new ToolRegistry();
    const ctx = makeCtx();
    await registry.executeAll([call('write_file', { path: 'e2e.txt', content: 'v1' })], ctx);
    await registry.executeAll([call('write_file', { path: 'e2e.txt', content: 'v2' })], ctx);
    expect(fs.readFileSync(path.join(tmpRoot, 'e2e.txt'), 'utf8')).toBe('v2');

    const res = await changes.rollbackTo('s1', tmpRoot);
    // 逆序：先恢复 change 2 的 before（v1），再撤销 change 1 的新建（删除）
    expect(res.reverted.map((r) => r.action)).toEqual(['restored', 'deleted']);
    expect(fs.existsSync(path.join(tmpRoot, 'e2e.txt'))).toBe(false);
  });
});
