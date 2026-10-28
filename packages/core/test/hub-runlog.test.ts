/**
 * F-41 运行日志 —— SessionHub 埋点单测（design-f41 §4）：
 * 注入伪造 RunLogSink，断言 send 全程产生 任务开始 / 工具调用 / 任务完成 /
 * 任务异常（catch 分支）日志行，均携带 sessionId。
 */
import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ChatMessage, ChatRequest, LLMProvider, StreamEvent, ToolCall } from '@delta/shared';
import { SessionService } from '../src/session/service.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionHub } from '../src/server/hub.js';
import type { RunLogSink, LogLevel } from '../src/logging/logger.js';
import { saveModelsFile } from '../src/llm/keychain.js';
import { ModelRouter } from '../src/llm/router.js';

/** 伪造 sink：记录全部 append 调用 */
class FakeSink implements RunLogSink {
  entries: Array<{ level: LogLevel; source: string; message: string; sessionId?: string }> = [];
  append(level: LogLevel, source: string, message: string, sessionId?: string): void {
    this.entries.push({ level, source, message, ...(sessionId ? { sessionId } : {}) });
  }
}

/** Scripted mock provider（与 usage.test 同思路）。 */
class MockProvider implements LLMProvider {
  readonly id = 'mock';
  constructor(private script: Array<{ text?: string; toolCalls?: ToolCall[] }>) {}
  async *chat(req: ChatRequest): AsyncIterable<StreamEvent> {
    void req;
    const next = this.script.shift();
    if (!next) {
      yield { type: 'error', message: 'mock exhausted', retriable: false };
      return;
    }
    if (next.text) {
      for (const chunk of next.text.match(/.{1,4}/gs) ?? []) {
        yield { type: 'text_delta', text: chunk };
      }
    }
    for (const [i, c] of (next.toolCalls ?? []).entries()) {
      yield { type: 'tool_call_delta', index: i, id: c.id, name: c.name, argsDelta: c.argsJson };
    }
    yield { type: 'usage', input: 10, output: 5 };
    yield { type: 'done' };
  }
  estimateTokens(messages: ChatMessage[]): number {
    return messages.reduce((n, m) => n + m.content.length, 0);
  }
}

describe('F-41 SessionHub 运行日志埋点', () => {
  it('正常任务：任务开始 / 工具调用行 / 任务完成，均带 sessionId', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-runlog-hub-'));
    await fs.writeFile(path.join(dir, 'note.txt'), 'hello');
    const svc = new SessionService(path.join(dir, 'db.sqlite'));
    try {
      const pid = svc.ensureProject(dir).id;
      const sid = svc.createSession(pid, { title: '日志埋点' }).id;
      const provider = new MockProvider([
        { toolCalls: [{ id: 'c1', name: 'read_file', argsJson: JSON.stringify({ path: 'note.txt' }) }] },
        { text: '完成' },
      ]);
      const sink = new FakeSink();
      const hub = new SessionHub({
        service: svc,
        registry: new ToolRegistry(),
        resolveProvider: async () => provider,
        runLog: sink,
      });
      await hub.send(sid, '读一下 note.txt');

      const sources = sink.entries.map((e) => e.source);
      expect(new Set(sources)).toEqual(new Set(['hub']));
      for (const e of sink.entries) expect(e.sessionId).toBe(sid);

      const messages = sink.entries.map((e) => e.message);
      expect(messages[0]).toContain('任务开始：读一下 note.txt');
      expect(messages.some((m) => m.includes('工具 read_file ✔') && m.includes('ms'))).toBe(true);
      expect(messages[messages.length - 1]).toContain('任务完成（');
      // 级别语义：开始/完成 info，无 error
      expect(sink.entries[0]!.level).toBe('info');
      expect(sink.entries[sink.entries.length - 1]!.level).toBe('info');
      expect(sink.entries.some((e) => e.level === 'error')).toBe(false);
    } finally {
      svc.close();
    }
  });

  it('异常任务（项目根不存在）：任务开始 + 任务异常 error 行', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-runlog-hub-err-'));
    const svc = new SessionService(path.join(dir, 'db.sqlite'));
    try {
      const missingRoot = path.join(dir, 'no-such-root');
      const pid = svc.ensureProject(missingRoot).id;
      const sid = svc.createSession(pid, { title: '异常埋点' }).id;
      const sink = new FakeSink();
      const hub = new SessionHub({
        service: svc,
        registry: new ToolRegistry(),
        resolveProvider: async () => new MockProvider([]),
        runLog: sink,
      });
      await hub.send(sid, '触发根目录校验失败');

      const levels = sink.entries.map((e) => e.level);
      expect(levels[0]).toBe('info'); // 任务开始
      expect(levels).toContain('error');
      const err = sink.entries.find((e) => e.level === 'error')!;
      expect(err.message).toContain('任务异常：');
      expect(err.sessionId).toBe(sid);
    } finally {
      svc.close();
    }
  });

  it('未注入 runLog：send 正常运行不抛错（可选依赖）', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-runlog-hub-off-'));
    const svc = new SessionService(path.join(dir, 'db.sqlite'));
    try {
      const pid = svc.ensureProject(dir).id;
      const sid = svc.createSession(pid, { title: '无日志' }).id;
      const provider = new MockProvider([{ text: 'ok' }]);
      const hub = new SessionHub({
        service: svc,
        registry: new ToolRegistry(),
        resolveProvider: async () => provider,
      });
      await expect(hub.send(sid, 'plain')).resolves.toBeUndefined();
    } finally {
      svc.close();
    }
  });
});

describe('F-42 路由回退 debug 标注（AC-42-4）', () => {
  it('路由目标 provider 构建失败：debug 日志标注回退主模型，任务不受阻', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-runlog-hub-route-'));
    await fs.writeFile(path.join(dir, 'README.md'), '# demo');
    const svc = new SessionService(path.join(dir, 'db.sqlite'));
    try {
      const pid = svc.ensureProject(dir).id;
      const sid = svc.createSession(pid, { title: '路由回退' }).id;
      const modelsFile = path.join(dir, 'models.json');
      saveModelsFile(
        {
          version: 1,
          providers: [],
          routing: { enabled: true, rules: { summarize: { provider: 'ghost', model: 'small-model' } } },
        },
        modelsFile,
      );
      const sink = new FakeSink();
      const hub = new SessionHub({
        service: svc,
        registry: new ToolRegistry(),
        resolveProvider: async () => new MockProvider([{ text: 'ok' }]),
        modelRouter: new ModelRouter(modelsFile),
        resolveProviderById: async () => {
          throw new Error('provider ghost 未配置');
        },
        runLog: sink,
      });
      await expect(hub.send(sid, '普通任务')).resolves.toBeUndefined();

      const dbg = sink.entries.find((e) => e.level === 'debug');
      expect(dbg).toBeDefined();
      expect(dbg!.message).toContain('summarize');
      expect(dbg!.message).toContain('回退主模型');
      expect(dbg!.sessionId).toBe(sid);
    } finally {
      svc.close();
    }
  });

  it('规则未命中 / 路由命中且可用：不产生 debug 回退行', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yz-runlog-hub-route-ok-'));
    await fs.writeFile(path.join(dir, 'README.md'), '# demo');
    const svc = new SessionService(path.join(dir, 'db.sqlite'));
    try {
      const pid = svc.ensureProject(dir).id;
      const sid = svc.createSession(pid, { title: '路由正常' }).id;
      const modelsFile = path.join(dir, 'models.json');
      saveModelsFile(
        {
          version: 1,
          providers: [],
          routing: { enabled: true, rules: { summarize: { model: 'small-model' } } },
        },
        modelsFile,
      );
      const sink = new FakeSink();
      const hub = new SessionHub({
        service: svc,
        registry: new ToolRegistry(),
        resolveProvider: async () => new MockProvider([{ text: 'ok' }]),
        modelRouter: new ModelRouter(modelsFile),
        runLog: sink,
      });
      await expect(hub.send(sid, '普通任务')).resolves.toBeUndefined();

      // 规则命中（provider 缺省 = 主 provider，构建必成功）→ 无 debug 行
      expect(sink.entries.some((e) => e.level === 'debug')).toBe(false);
    } finally {
      svc.close();
    }
  });
});
