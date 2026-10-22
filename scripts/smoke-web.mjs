#!/usr/bin/env node
/**
 * M4 端到端冒烟（零硬编码密钥，不依赖真实 Provider）：
 * 1. 起 createWebServer（临时 DB + webDist）
 * 2. SPA 首页 200
 * 3. 建会话 → 订阅 SSE → POST 消息（resolveProvider 抛错）→ 收到 run_error 事件
 *    ——验证 REST → 引擎桥 → SSE 全链路管道
 * 4. 回收站/检索/确认端点连通性
 * 用法：node scripts/smoke-web.mjs [--web-dist <dir>]
 */
import { SessionService, SessionHub, createWebServer, ToolRegistry } from '../packages/core/dist/index.js';
import { promises as fsp } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const webDistArg = process.argv.indexOf('--web-dist');
const webDist = webDistArg > 0 ? process.argv[webDistArg + 1] : new URL('../packages/web/dist/', import.meta.url).pathname;

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'yz-smoke-web-'));
const svc = new SessionService(path.join(tmp, 'db.sqlite'));
const hub = new SessionHub({
  service: svc,
  registry: new ToolRegistry(),
  resolveProvider: async () => {
    throw new Error('smoke: no provider configured (expected)');
  },
});
const server = createWebServer({
  service: svc,
  hub,
  port: 0,
  webDistDir: fs.existsSync(path.join(webDist, 'index.html')) ? webDist : undefined,
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? '✔' : '✘'} ${name}`);
  if (!cond) failed++;
};

// 1. SPA
const page = await fetch(`${base}/`);
check('SPA 首页 200 text/html', page.status === 200 && (page.headers.get('content-type') ?? '').includes('text/html'));

// 2. 会话 + SSE 全链路（无 Provider → run_error 事件）
const project = (await (await fetch(`${base}/api/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: tmp }) })).json());
const session = await (await fetch(`${base}/api/projects/${project.id}/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'smoke' }) })).json();

const events = [];
const ctrl = new AbortController();
const es = fetch(`${base}/api/sessions/${session.id}/events`, { signal: ctrl.signal }).then((r) => r.body.getReader());
const reader = await es;
const decoder = new TextDecoder();
let buf = '';
const readLoop = (async () => {
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const line = frame.split('\n').find((l) => l.startsWith('data: '));
        if (line) events.push(JSON.parse(line.slice(6)));
      }
    }
  } catch {
    // aborted → 已收集事件足够
  }
})();
await new Promise((r) => setTimeout(r, 100));

await fetch(`${base}/api/sessions/${session.id}/messages`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ input: '触发 run_error' }),
});
await new Promise((r) => setTimeout(r, 300));
ctrl.abort();
check('SSE 收到 run_error（全链路管道通）', events.some((e) => e.type === 'run_error'));
check('SSE 收到 state 事件（运行状态机）', events.some((e) => e.type === 'state'));

// 3. 消息落库（user 消息在 run 前已写）
const detail = await (await fetch(`${base}/api/sessions/${session.id}`)).json();
check('消息已落库（user）', detail.messages.some((m) => m.role === 'user'));

// 4. trash / search / confirm 端点连通性
await fetch(`${base}/api/sessions/${session.id}`, { method: 'DELETE' });
const trash = await (await fetch(`${base}/api/trash`)).json();
check('删除进回收站', trash.some((t) => t.kind === 'session' && t.id === session.id));
const search = await (await fetch(`${base}/api/search?q=smoke`)).json();
check('检索端点连通', Array.isArray(search));
const confirmMiss = await (await fetch(`${base}/api/sessions/${session.id}/confirm`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ requestId: 'none', decision: { kind: 'allow' } }),
})).json();
check('confirm 端点连通（无待确认 → 404 语义）', confirmMiss.error === 'no pending confirm');

server.close();
svc.close();
console.log(failed === 0 ? '\n✔ Web 冒烟全部通过' : `\n✘ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
