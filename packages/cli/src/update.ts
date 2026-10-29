/**
 * `delta update` 子命令（F-50，AC-50-2）：按渠道执行升级动作。
 *
 *  - `delta update`          检查 + 升级：npm 渠道走 `npm i -g @delta/cli@latest`；
 *                            SEA 渠道下载 release 资产（delta-<platform>-<arch>）原子替换当前二进制
 *  - `delta update --check`  只检查不升级
 *  - `delta update status`   查看渠道 / 更新源 / 上次检查时间（不发起网络请求）
 *
 * 手动检查失败**如实报错**（与启动检查的静默口径不同）；降级拒绝：远端不严格大于当前版本一律不动作。
 */
import { spawn } from 'node:child_process';
import {
  APP_VERSION,
  FILES,
  RunLog,
  applyBinarySwap,
  checkForUpdate,
  detectChannel,
  downloadUpdateAsset,
  loadUpdateConfig,
  maybeCheckOnStartup,
  userConfigDir,
  userUpdateConfigPath,
  type UpdateCheckResult,
} from '@delta/core';

/** F-41 留档：更新事件写 serve-YYYYMMDD.log（source=update），失败静默 */
function updateLog(): RunLog | undefined {
  try {
    return new RunLog({ dir: `${userConfigDir()}/${FILES.logsDir}` });
  } catch {
    return undefined;
  }
}

/** SEA 渠道 release 资产命名（对齐 scripts/build-sea.mjs 产物 delta-<platform>-<arch>）。 */
function seaAssetName(): string {
  return `delta-${process.platform}-${process.arch}`;
}

/** status：打印渠道 / 配置 / 上次检查（不发网络请求）。 */
export function updateStatusCommand(): void {
  const { config, warnings } = loadUpdateConfig();
  const lines: string[] = [];
  lines.push(`当前版本：${APP_VERSION}`);
  lines.push(`更新配置：${userUpdateConfigPath()}`);
  lines.push(`启动检查：${config.enabled ? '已启用' : '已关闭'}（间隔 ${Math.round(config.intervalMs / 86_400_000)} 天）`);
  const src = config.source;
  lines.push(`更新源：${src.type}${src.repo ? ` ${src.repo}` : ''}${src.url ? ` ${src.url}` : ''}`);
  lines.push(`上次启动检查：${config.lastCheckAt ?? '从未'}`);
  if (config.lastSeenVersion) lines.push(`已知新版本：${config.lastSeenVersion}（运行 \`delta update --check\` 刷新）`);
  for (const w of warnings) lines.push(`⚠ ${w.field ? `[${w.field}] ` : ''}${w.message}`);
  console.log(lines.join('\n'));
}

/** --check：只检查不升级。返回结果供测试/脚本断言（失败抛错，由调用方收口退出码）。 */
export async function updateCheckOnlyCommand(): Promise<UpdateCheckResult | undefined> {
  const channel = await detectChannel();
  console.log(`渠道：${channel === 'sea' ? 'SEA 单文件' : 'npm 安装'}    当前版本：${APP_VERSION}`);
  try {
    const r = await checkForUpdate({ currentVersion: APP_VERSION, log: updateLog() });
    if (r.hasUpdate) {
      console.log(`⬆ 发现新版本 ${r.latestVersion}（当前 ${r.currentVersion}）：${r.releaseUrl}`);
      console.log('运行 `delta update` 升级');
    } else {
      console.log(`✔ 已是最新（远端 ${r.latestVersion}）`);
    }
    if (r.notes) console.log(`\n${r.notes}`);
    return r;
  } catch (e) {
    console.error(`✘ 更新检查失败：${(e as Error).message}`);
    console.error('可检查网络，或在 ~/.delta/update.json 配置 source（github / gitee / 自定义 JSON）后重试');
    process.exitCode = 1;
    return undefined;
  }
}

/** npm 渠道升级：`npm i -g @delta/cli@latest`（继承 stdio，失败给手动命令）。 */
function npmUpdate(): void {
  console.log('▸ npm 渠道：执行 npm install -g @delta/cli@latest …');
  const child = spawn('npm', ['install', '-g', '@delta/cli@latest'], { stdio: 'inherit' });
  child.on('close', (code) => {
    if (code === 0) {
      console.log('✔ 升级完成，重新运行 `delta --version` 确认');
    } else {
      console.error(`✘ npm 安装失败（退出码 ${code}），可手动执行：npm install -g @delta/cli@latest`);
      process.exitCode = 1;
    }
  });
}

/** SEA 渠道升级：下载 delta-<platform>-<arch> 资产 → 原子替换当前二进制。 */
async function seaUpdate(r: UpdateCheckResult): Promise<void> {
  const assetName = seaAssetName();
  const asset = r.assets.find((a) => a.name === assetName);
  if (!asset) {
    console.error(`✘ Release 未提供 ${assetName} 资产，请到发布页手动下载：${r.releaseUrl}`);
    process.exitCode = 1;
    return;
  }
  console.log(`▸ SEA 渠道：下载 ${assetName}（${r.latestVersion}）并替换当前二进制 …`);
  try {
    const stagingDir = `${userConfigDir()}/${FILES.updateStagingDir}`;
    const { file, bytes } = await downloadUpdateAsset(asset.downloadUrl, stagingDir);
    const { backupPath } = applyBinarySwap(file, process.execPath);
    console.log(`✔ 已替换（${Math.round(bytes / 1024)} KB），旧二进制备份在 ${backupPath}`);
    console.log('重启 delta 生效：退出当前会话后重新运行 `delta --version` 确认');
  } catch (e) {
    console.error(`✘ SEA 升级失败（当前二进制未受影响）：${(e as Error).message}`);
    console.error(`可到发布页手动下载：${r.releaseUrl}`);
    process.exitCode = 1;
  }
}

/** `delta update` 主入口：检查 + 按渠道升级（--check 只检查）。 */
export async function updateRunCommand(opts: { check?: boolean } = {}): Promise<void> {
  const channel = await detectChannel();
  console.log(`渠道：${channel === 'sea' ? 'SEA 单文件' : 'npm 安装'}    当前版本：${APP_VERSION}`);
  let r: UpdateCheckResult;
  try {
    r = (await checkForUpdate({ currentVersion: APP_VERSION, log: updateLog() }))!;
  } catch (e) {
    console.error(`✘ 更新检查失败：${(e as Error).message}`);
    console.error('可检查网络，或在 ~/.delta/update.json 配置 source（github / gitee / 自定义 JSON）后重试');
    process.exitCode = 1;
    return;
  }
  if (!r.hasUpdate) {
    console.log(`✔ 已是最新（远端 ${r.latestVersion}，降级/同版拒绝动作）`);
    return;
  }
  console.log(`⬆ 发现新版本 ${r.latestVersion}（当前 ${r.currentVersion}）：${r.releaseUrl}`);
  if (opts.check) return;
  if (channel === 'npm') npmUpdate();
  else await seaUpdate(r);
}

/**
 * 启动版本检查（AC-50-1）：fire-and-forget 周节流，失败静默留档；
 * 发现新版本在 TUI 挂起前 console.error 提示一行。调用方必须 void 掉本函数。
 */
export async function startupUpdateCheck(): Promise<void> {
  try {
    const r = await maybeCheckOnStartup({
      currentVersion: APP_VERSION,
      log: updateLog(),
    });
    if (r.hasUpdate && r.latestVersion) {
      console.error(`⬆ 发现新版本 ${r.latestVersion}（当前 ${APP_VERSION}），运行 \`delta update\` 升级`);
    }
  } catch {
    // 启动检查绝不影响主流程（失败已在 checker 内留档）
  }
}
