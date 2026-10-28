import { describe, expect, it, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { SessionStore } from '../src/session/store.js';
import { SessionService } from '../src/session/service.js';

let service: SessionService;
let dbFile = '';

beforeEach(() => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yz-replay-')), 'test.db');
  service = new SessionService(dbFile);
});

function append(sessionId: string, at: string, m: Parameters<SessionService['appendMessage']>[1]) {
  service.appendMessage(sessionId, m);
  // 覆写 created_at 以便时间线断言（模拟真实间隔）
  service.store.db
    .prepare('UPDATE messages SET created_at = ? WHERE session_id = ? AND seq = (SELECT MAX(seq) FROM messages WHERE session_id = ?)')
    .run(at, sessionId, sessionId);
}

describe('F-18 会话回放', () => {
  let sid = '';

  beforeEach(() => {
    const project = service.ensureProject('/tmp');
    sid = service.createSession(project.id, { title: 'replay-test' }).id;
    // run 0：一次带工具调用的任务
    append(sid, '2026-10-22T10:00:00.000Z', { role: 'user', content: '修复预算检查 bug' });
    append(sid, '2026-10-22T10:00:05.000Z', {
      role: 'assistant',
      content: '我先读一下代码。',
      toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{"path":"src/loop.ts"}' }],
    });
    append(sid, '2026-10-22T10:00:08.000Z', { role: 'tool', content: '{"ok":true}', toolCallId: 'c1' });
    append(sid, '2026-10-22T10:00:20.000Z', { role: 'assistant', content: '已修复，检查前移至轮首。' });
    // run 1：纯问答任务
    append(sid, '2026-10-22T11:00:00.000Z', { role: 'user', content: '什么是闭包？' });
    append(sid, '2026-10-22T11:00:10.000Z', { role: 'assistant', content: '闭包是函数与其词法环境的组合。' });
  });

  it('getRuns splits tasks by user messages', () => {
    const runs = service.getRuns(sid);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({
      index: 0,
      startedAt: '2026-10-22T10:00:00.000Z',
      endedAt: '2026-10-22T10:00:20.000Z',
      userPreview: '修复预算检查 bug',
      messages: 4,
      toolCalls: 1,
      afterIndex: 0,
    });
    expect(runs[1]).toMatchObject({ index: 1, messages: 2, toolCalls: 0, afterIndex: 4 });
  });

  it('afterIndex 可直接用于 forkSession（F-46 回放页分叉入口）', () => {
    const runs = service.getRuns(sid);
    // 从 run 1 的 user 消息分叉：副本 = run 0 的全部 4 条消息，源会话不动
    const forked = service.forkSession(sid, runs[1]!.afterIndex);
    expect(service.getHistory(forked.id)).toHaveLength(4);
    expect(service.getHistory(sid)).toHaveLength(6);
  });

  it('getRunTimeline pairs tool results with calls by callId', () => {
    const tl = service.getRunTimeline(sid, 0)!;
    expect(tl.index).toBe(0);
    expect(tl.steps.map((s) => s.type)).toEqual(['user', 'assistant', 'tool_call', 'assistant']);
    const call = tl.steps[2]!;
    if (call.type !== 'tool_call') return expect.unreachable();
    expect(call.name).toBe('read_file');
    expect(call.result?.ok).toBe(true);
    expect(call.result?.at).toBe('2026-10-22T10:00:08.000Z');
  });

  it('run 1 timeline has no tool steps', () => {
    const tl = service.getRunTimeline(sid, 1)!;
    expect(tl.steps.map((s) => s.type)).toEqual(['user', 'assistant']);
  });

  it('unknown run index → undefined', () => {
    expect(service.getRunTimeline(sid, 99)).toBeUndefined();
    expect(service.getRunTimeline('no-such-session', 0)).toBeUndefined();
  });

  it('user input mid-run starts a new run', () => {
    append(sid, '2026-10-22T12:00:00.000Z', { role: 'user', content: '再来一个任务' });
    expect(service.getRuns(sid)).toHaveLength(3);
    expect(service.getRunTimeline(sid, 2)!.steps[0]!.type).toBe('user');
  });
});
