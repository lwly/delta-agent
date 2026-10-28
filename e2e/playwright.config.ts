/**
 * F-45 Web E2E Playwright 配置。
 * webServer：启动 scripts/e2e-serve.mjs（假 Provider + 临时 DB + 内嵌 webDist），
 * 轮询 /api/projects 判活；CLI 黄金路径不在此跑（node e2e/cli/e2e-cli.mjs，见根 package.json `e2e`）。
 */
import { defineConfig } from '@playwright/test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.E2E_PORT ?? 7790);
const baseURL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './web',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // 共享同一 serve 实例，串行避免会话互相干扰
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node scripts/e2e-serve.mjs',
    cwd: repoRoot,
    url: `${baseURL}/api/projects`,
    // 恒为 false：残留的旧 serve（旧 DB 状态）会让用例互相污染，宁可失败暴露
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
