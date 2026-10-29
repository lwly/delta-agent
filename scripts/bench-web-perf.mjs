#!/usr/bin/env node
/**
 * F-53（AC-53-5）Web 性能基准脚本：固化「优化前 vs 优化后」端点对比数据。
 *
 * - 临时 DB + 真实 SessionService 种入 5000 条消息
 * - 对比四组指标（延迟 + 响应体大小）：
 *   1. 消息历史：全量 GET /api/sessions/:id（旧口径）vs 分页 ?limit=50（新首屏）
 *   2. 向上翻页：?before=<seq>&limit=50
 *   3. done 增量校准：?after=<seq>（10 条新增）
 *   4. 会话列表：全量 vs ?limit=50（100 个会话）
 *
 * 用法：node scripts/bench-web-perf.mjs [消息数=5000]
 * 依赖：先 pnpm build:deps（packages/core/dist）
 */
import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SessionService, SessionHub, createWebServer, ToolRegistry } from '../packages/core/dist/index.js';

const N = Number(process.argv[2] ?? 5000);

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'yz-bench-'));
const svc = new SessionService(path.join(tmp, 'db.sqlite'));
const project = svc.ensureProject(tmp);
const session = svc.createSession(project.id, { title: 'bench' });

process.stdout.write(`种入 ${N} 条消息…\n`);
const big = 'x'.repeat(6000); // 每 10 条带一条大 tool 输出（模拟真实会话的 read_file/run_command 结果）
for (let i = 1; i <= N; i++) {
  svc.appendMessage(session.id, { role: 'user', content: `bench msg-${i}` });
  if (i % 10 === 0) {
    svc.appendMessage(session.id, { role: 'tool', content: big, toolCallId: `call-${i}` });
  }
}
// 会话列表分页数据源
for (let i = 0; i < 100; i++) svc.createSession(project.id, { title: `filler-${i}` });

const server = createWebServer({ service: svc, hub: new SessionHub({ service: svc, registry: new ToolRegistry(), resolveProvider: async () => { throw new Error('unused'); } }), port: 0, skillsHomeDir: tmp, configHomeDir: tmp });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

async function measure(label, p) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(`${base}${p}`);
  const text = await res.text();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { label, ms, bytes: Buffer.byteLength(text) };
}

const fmt = (r) => `${r.label.padEnd(46)} ${String(r.ms.toFixed(1)).padStart(8)} ms  ${(r.bytes / 1024).toFixed(0).padStart(7)} KB`;

// 预热（连接池 / JIT / SQLite 页缓存）
await fetch(`${base}/api/sessions/${session.id}`).then((r) => r.text());
await fetch(`${base}/api/sessions/${session.id}/messages?limit=50`).then((r) => r.text());

const rows = [];
rows.push(await measure('消息历史 全量（旧口径 GET /sessions/:id）', `/api/sessions/${session.id}`));
rows.push(await measure('消息历史 首屏一屏（新 ?limit=50）', `/api/sessions/${session.id}/messages?limit=50`));

const first = await (await fetch(`${base}/api/sessions/${session.id}/messages?limit=50`)).json();
const oldest = first.messages[0].seq;
rows.push(await measure('消息历史 向上翻页（?before&limit=50）', `/api/sessions/${session.id}/messages?before=${oldest}&limit=50`));
rows.push(await measure('done 增量校准（?after=<last-10>）', `/api/sessions/${session.id}/messages?after=${first.messages[first.messages.length - 1].seq - 10}`));
rows.push(await measure('tool 全文懒加载（:seq/content，6KB 样本）', `/api/sessions/${session.id}/messages/${first.messages.find((m) => m.message.role === 'tool')?.seq ?? 10}/content`));
rows.push(await measure('会话列表 全量（旧口径）', `/api/projects/${project.id}/sessions`));
rows.push(await measure('会话列表 分页（新 ?limit=50）', `/api/projects/${project.id}/sessions?limit=50`));

console.log('\n=== F-53 Web 性能基准（' + N + ' 条消息，其中 ' + Math.floor(N / 10) + ' 条 6KB tool 输出；100 个会话） ===');
for (const r of rows) console.log(fmt(r));
console.log('\n说明：全量口径旧端点为兼容保留；Web 首屏/翻页/done 校准均已切到分页端点。');

server.close();
svc.close();
await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
