/**
 * `yzero notify` 子命令组（F-33 设计 §6，样例沿用 sandbox.ts）：
 *  - status   查看生效配置 + 来源层 + 平台后端 + 配置警告
 *  - enable   全局启用（写 ~/.y-zero/notify.json 的 enabled=true，其它字段保留）
 *  - disable  全局关闭（enabled=false）
 *  - test     发送一条样例通知（人工验证端到端链路）
 *
 * enable/disable 经 core 的 updateUserNotifyEnabled：只改 enabled、写前读、tmp+rename 原子写。
 */
import { createDesktopNotifier, loadNotifyConfig, updateUserNotifyEnabled } from '@y-zero/core';

/** status：打印生效配置与来源（不发送通知）。 */
export function notifyStatusCommand(): void {
  const projectRoot = process.cwd();
  const { config, warnings, explicit } = loadNotifyConfig({ projectRoot });
  const notifier = createDesktopNotifier({ projectRoot, config });
  const lines: string[] = [];
  lines.push(`通知：${config.enabled ? '已启用' : '已关闭'}（${explicit ? '显式配置' : '缺省值'}）`);
  lines.push(`任务结束通知：${config.onDone ? '开' : '关'}   确认卡通知：${config.onConfirm ? '开' : '关'}`);
  lines.push(`长任务时长门槛：${config.minDurationMs}ms（低于该值的任务结束不打扰）`);
  lines.push(`平台后端：${notifier.backendName()}`);
  for (const w of warnings) lines.push(`⚠ [${w.source}]${w.field ? ` ${w.field}:` : ''} ${w.message}`);
  console.log(lines.join('\n'));
  if (!config.enabled) console.log('\n启用：`yzero notify enable`');
  if (process.platform === 'darwin' && config.enabled) {
    console.log('ℹ 收不到通知时检查「系统设置 → 通知」是否允许终端 / Node.js 发送通知');
  }
}

/** enable：写全局 enabled=true（其它字段保留）。 */
export function notifyEnableCommand(): void {
  try {
    const r = updateUserNotifyEnabled(true);
    console.log(`✔ 桌面通知已启用：${r.path}`);
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** disable：写全局 enabled=false（其它字段保留）。 */
export function notifyDisableCommand(): void {
  try {
    const r = updateUserNotifyEnabled(false);
    console.log(`✔ 桌面通知已关闭：${r.path}`);
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** test：发送一条样例通知（等待发送完成以便脚本验证退出码）。 */
export async function notifyTestCommand(): Promise<void> {
  const notifier = createDesktopNotifier({ projectRoot: process.cwd() });
  await notifier.deliver('y-zero-agent 通知测试', '如果你看到这条通知，桌面通知链路已就绪（F-33）');
  if (process.platform === 'darwin' || process.platform === 'win32' || process.platform === 'linux') {
    console.log('✔ 已发送样例通知（若未看到请检查系统通知权限设置）');
  } else {
    console.log(`ℹ 平台 ${process.platform} 暂不支持系统通知（已静默忽略）`);
  }
}
