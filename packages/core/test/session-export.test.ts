import { describe, expect, it, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { SessionService } from '../src/session/service.js';
import { exportSession, type ExportMeta } from '../src/session/export.js';

let service: SessionService;
let dbFile = '';

beforeEach(() => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'delta-export-')), 'test.db');
  service = new SessionService(dbFile);
});

function append(sessionId: string, at: string, m: Parameters<SessionService['appendMessage']>[1]) {
  service.appendMessage(sessionId, m);
  // 覆写 created_at 以便时间线断言（模拟真实间隔）
  service.store.db
    .prepare('UPDATE messages SET created_at = ? WHERE session_id = ? AND seq = (SELECT MAX(seq) FROM messages WHERE session_id = ?)')
    .run(at, sessionId, sessionId);
}

/** 建一个 2 任务的样例会话（run0 带工具调用与失败结果，run1 纯问答），返回会话 id */
function seedSession(): string {
  const project = service.ensureProject('/tmp');
  const sid = service.createSession(project.id, { title: 'export-test' }).id;
  append(sid, '2026-10-29T10:00:00.000Z', { role: 'user', content: '修复预算检查 bug' });
  append(sid, '2026-10-29T10:00:05.000Z', {
    role: 'assistant',
    content: '我先读一下代码。',
    toolCalls: [{ id: 'c1', name: 'read_file', argsJson: '{"path":"src/loop.ts"}' }],
  });
  append(sid, '2026-10-29T10:00:08.000Z', { role: 'tool', content: '{"ok":true}', toolCallId: 'c1' });
  append(sid, '2026-10-29T10:00:20.000Z', { role: 'assistant', content: '已修复，检查前移至轮首。' });
  append(sid, '2026-10-29T11:00:00.000Z', { role: 'user', content: '什么是闭包？' });
  append(sid, '2026-10-29T11:00:10.000Z', { role: 'assistant', content: '闭包是函数与其词法环境的组合。' });
  service.recordUsage(sid, 0, 100, 50, 0.01, 'test-model');
  service.recordUsage(sid, 1, 80, 30, 0.005, 'test-model');
  service.recordUsage(sid, 1, 10, 5, 0.001, '');
  return sid;
}

async function collect(sessionId: string, opts: Parameters<typeof exportSession>[2]) {
  const chunks: string[] = [];
  const meta = await exportSession(service, sessionId, opts, (c) => chunks.push(c));
  return { meta, doc: chunks.join(''), chunks };
}

describe('F-49 会话导出', () => {
  let sid = '';
  beforeEach(() => {
    sid = seedSession();
  });

  it('Markdown：含任务边界、时间线步骤与用量（AC-49-2）', async () => {
    const { meta, doc } = await collect(sid, { format: 'md' });
    expect(meta.messageCount).toBe(6);
    expect(meta.runCount).toBe(2);
    expect(doc).toContain('# 会话导出：export-test');
    expect(doc).toContain('## 任务 1：修复预算检查 bug');
    expect(doc).toContain('## 任务 2：什么是闭包？');
    expect(doc).toContain('**🔧 read_file** ✔');
    expect(doc).toContain('"path": "src/loop.ts"');
    expect(doc).toContain('**👤 用户** · 2026-10-29T10:00:00.000Z');
    // 用量（F-31 口径：空 model 归「未知」，合计行）
    expect(doc).toContain('| test-model | 180 | 80 | 0.0150 | 2 |');
    expect(doc).toContain('| 未知 | 10 | 5 | 0.0010 | 1 |');
    expect(doc).toContain('| **合计** | 190 | 85 | 0.0160 | 3 |');
    expect(doc).toContain('由 delta export 生成');
  });

  it('HTML：单文件自包含（无外链脚本/样式，内联 CSS）且含工具调用卡片（AC-49-1）', async () => {
    const { meta, doc } = await collect(sid, { format: 'html' });
    expect(meta.runCount).toBe(2);
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('<style>');
    expect(doc).not.toMatch(/<script[^>]+src=/i);
    expect(doc).not.toMatch(/<link[^>]+href=/i);
    expect(doc).not.toMatch(/https?:\/\//); // 内容与样式均不应产生外链
    expect(doc).toContain('<details class="step tool">');
    expect(doc).toContain('🔧 read_file ✔');
    expect(doc).toContain('任务 2：什么是闭包？');
    expect(doc).toContain('test-model');
  });

  it('时间线口径与回放页一致（getRunTimeline 对齐）', async () => {
    const { doc } = await collect(sid, { format: 'md' });
    const timeline = service.getRunTimeline(sid, 0)!;
    expect(timeline.steps.map((s) => s.type)).toEqual(['user', 'assistant', 'tool_call', 'assistant']);
    expect(doc).toContain('我先读一下代码。');
    expect(doc).toContain('已修复，检查前移至轮首。');
    // 工具结果按 callId 配对到调用步骤
    expect(doc).toContain('{"ok":true}');
  });

  it('默认脱敏：文本凭证与 JSON 配置字段命中即剔除并告警（AC-49-3）', async () => {
    const project = service.ensureProject('/tmp');
    const sid2 = service.createSession(project.id, { title: 'redact-test' }).id;
    append(sid2, '2026-10-29T12:00:00.000Z', {
      role: 'user',
      content: '用这个 key sk-abcdefghijklmnop123456 调用，AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI 一并配置',
    });
    append(sid2, '2026-10-29T12:00:05.000Z', {
      role: 'assistant',
      content: '好的',
      toolCalls: [{ id: 'c9', name: 'write_file', argsJson: '{"path":"a.ts","api_key":"super-secret-value"}' }],
    });
    append(sid2, '2026-10-29T12:00:08.000Z', { role: 'tool', content: '{"ok":true}', toolCallId: 'c9' });

    const { meta, doc } = await collect(sid2, { format: 'md' });
    expect(doc).not.toContain('sk-abcdefghijklmnop123456');
    expect(doc).not.toContain('wJalrXUtnFEMI');
    expect(doc).not.toContain('super-secret-value');
    expect(doc).toContain('AWS_SECRET_ACCESS_KEY=[REDACTED]');
    expect(doc).toContain('"api_key": "[REDACTED]"');
    expect(doc).toContain('"path": "a.ts"'); // 非敏感字段保留
    const kinds = meta.redactions.map((r) => r.kind).join(',');
    expect(kinds).toContain('API 密钥（sk-）');
    expect(kinds).toContain('环境变量凭证');
    expect(kinds).toContain('配置字段（api_key）');
    expect(doc).toContain('默认脱敏已启用');
  });

  it('私钥块整体剔除', async () => {
    const project = service.ensureProject('/tmp');
    const sid3 = service.createSession(project.id, { title: 'pem-test' }).id;
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIB\nabc\n-----END RSA PRIVATE KEY-----';
    append(sid3, '2026-10-29T13:00:00.000Z', { role: 'user', content: `帮我看下 ${pem} 这个证书` });
    const { doc } = await collect(sid3, { format: 'md' });
    expect(doc).not.toContain('MIIB');
    expect(doc).toContain('[REDACTED]');
  });

  it('redact: false 保留原文', async () => {
    const project = service.ensureProject('/tmp');
    const sid4 = service.createSession(project.id, { title: 'noredact-test' }).id;
    append(sid4, '2026-10-29T14:00:00.000Z', { role: 'user', content: 'key 是 sk-abcdefghijklmnop123456' });
    const { meta, doc } = await collect(sid4, { format: 'md', redact: false });
    expect(doc).toContain('sk-abcdefghijklmnop123456');
    expect(meta.redactions).toHaveLength(0);
  });

  it('大会话（2160 条消息 / 120 任务）流式分块导出不爆内存（AC-49-5）', async () => {
    const project = service.ensureProject('/tmp');
    const sidBig = service.createSession(project.id, { title: 'big-test' }).id;
    for (let r = 0; r < 120; r++) {
      append(sidBig, new Date(2026, 9, 29, 0, r, 0).toISOString(), { role: 'user', content: `任务 ${r} 的输入` });
      for (let j = 0; j < 17; j++) {
        append(sidBig, new Date(2026, 9, 29, 0, r, 1 + j).toISOString(), {
          role: 'assistant',
          content: `任务 ${r} 第 ${j} 步回复`,
        });
      }
    }
    expect(service.getHistory(sidBig).length).toBe(2160);

    const chunks: string[] = [];
    let meta: ExportMeta | undefined;
    meta = await exportSession(service, sidBig, { format: 'html' }, (c) => chunks.push(c));
    expect(meta.messageCount).toBe(2160);
    expect(meta.runCount).toBe(120);
    // 流式产出：每个任务一个块（+ 头尾），而非单串
    expect(chunks.length).toBeGreaterThanOrEqual(121);
    const doc = chunks.join('');
    expect(doc).toContain('任务 120：');
    expect(doc).toContain('2160 条消息 · 120 个任务');
    // 分页读取边界：超过单页（200）的消息全部覆盖（首尾任务均在文档中）
    expect(doc).toContain('任务 0 的输入');
    expect(doc).toContain(`任务 119 的输入`);
  });

  it('会话不存在时抛错', async () => {
    await expect(collect('no-such-session', { format: 'md' })).rejects.toThrow('session not found');
  });

  it('空会话导出仍有合法文档骨架', async () => {
    const project = service.ensureProject('/tmp');
    const sid5 = service.createSession(project.id, { title: 'empty-test' }).id;
    const { meta, doc } = await collect(sid5, { format: 'html' });
    expect(meta.runCount).toBe(0);
    expect(doc).toContain('（本会话暂无任务记录）');
    expect(doc).toContain('</html>');
  });
});
