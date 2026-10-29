#!/usr/bin/env node
/**
 * F-45 Web E2E 专用 serve：临时 DB + 假 Provider（ScriptedFakeProvider scripted 模式）
 * + 真 ToolRegistry（read_file 可真实执行，项目根含 note.txt）。
 *
 * 就绪后向 stdout 打印 `E2E_SERVE_READY <port>`（Playwright webServer 轮询 /api/projects 判活也可）。
 * SIGTERM/SIGINT 退出并清理临时目录。
 *
 * 环境变量：
 * - E2E_PORT          监听端口（缺省 7790）
 * - E2E_WEB_DIST      Vue 构建产物目录（缺省 packages/web/dist）
 * - E2E_KEEP          设为 1 时退出前不删临时目录（排障用）
 */
import { SessionService, SessionHub, createWebServer, ToolRegistry, ScriptedFakeProvider } from '../packages/core/dist/index.js';
import { promises as fsp } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.E2E_PORT ?? 7790);
const webDist = process.env.E2E_WEB_DIST
  ?? fileURLToPath(new URL('../packages/web/dist/', import.meta.url));

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'yz-e2e-serve-'));
// 项目根：带 note.txt（假 Provider 的 read_file 调用目标）与 README（prompt 组装）
const projectRoot = path.join(tmp, 'proj');
await fsp.mkdir(projectRoot);
await fsp.writeFile(path.join(projectRoot, 'note.txt'), 'e2e note content\n');
await fsp.writeFile(path.join(projectRoot, 'README.md'), '# e2e 项目\n');

const svc = new SessionService(path.join(tmp, 'db.sqlite'));
// 启动即注册 e2e 项目（Web 测试经 API 列表复用，避免测试侧构造 root 路径）
svc.ensureProject(projectRoot);
const hub = new SessionHub({
  service: svc,
  registry: new ToolRegistry(),
  resolveProvider: async () => new ScriptedFakeProvider('scripted'),
});
const server = createWebServer({
  service: svc,
  hub,
  port,
  host: '127.0.0.1',
  webDistDir: fs.existsSync(path.join(webDist, 'index.html')) ? webDist : undefined,
  // 隔离 HOME：用户级 skills / registry.json / mcp.json / models.json 全部落临时目录，
  // 防止 e2e 的安装类用例（F-52 市场面板）污染真实 ~/.delta
  skillsHomeDir: tmp,
  configHomeDir: tmp,
});
await new Promise((r) => server.listen(port, '127.0.0.1', r));
console.log(`E2E_SERVE_READY ${port}`);

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await new Promise((r) => server.close(() => r()));
  svc.close();
  if (process.env.E2E_KEEP !== '1') await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// 心跳：防止被父进程误判僵死；同时便于日志观测
setInterval(() => {
  if (!closing) console.log('E2E_SERVE_ALIVE');
}, 30_000);
