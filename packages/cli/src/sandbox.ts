/**
 * `delta sandbox` 子命令组（F-30 设计 §11 T05）：
 *  - status   查看生效模式 + 后端探测 + 警告（格式化单点 formatSandboxStatus，CLI 与未来 Web 复用）
 *  - enable   全局启用沙箱（默认 seatbelt；--mode docker 切换容器后端）
 *  - disable  全局关闭（mode=local）
 *  - pull     预拉取镜像（仅 docker 后端有意义）
 *  - gc       清理残留容器（仅 docker 后端有意义）
 *
 * enable/disable 经 core 的 updateUserSandboxMode：只改 mode、写前读、tmp+rename 原子写。
 */
import { createSandboxRuntime, updateUserSandboxMode, type SandboxStatus } from '@delta/core';

/** status 的人类可读格式化（R7：macOS bind mount 慢提示固定追加）。 */
export function formatSandboxStatus(st: SandboxStatus): string {
  const lines: string[] = [];
  const explicitTag = st.explicit ? '显式启用' : '未显式配置（缺省 local，零影响）';
  lines.push(`模式：${st.mode}（${explicitTag}）`);
  lines.push(`enforce：${st.enforce ? 'on（项目级强制）' : 'off'}   fallback：${st.fallback}`);
  const probeMark = st.docker.available ? '✔' : '✘';
  lines.push(`后端探测：${probeMark} ${st.docker.detail}${st.docker.fromCache ? '（缓存）' : ''}`);
  if (st.mode === 'docker') {
    lines.push(`镜像：${st.image}（${st.imagePresent ? '已在本地' : '未拉取，可用 delta sandbox pull 预热'}）`);
    lines.push(`残留容器：${st.residues.length} 个${st.residues.length > 0 ? '，可用 delta sandbox gc 清理' : ''}`);
    if (process.platform === 'darwin') {
      lines.push('ℹ macOS 上 Docker bind mount I/O 明显慢于本地（首次 pnpm install 可能 60–120s），这是 Docker Desktop 的已知特性');
    }
  }
  if (st.mode === 'seatbelt') {
    lines.push('ℹ Seatbelt 不支持内存/CPU/进程数上限（docker 后端支持）；写范围 = 项目工作区 + 系统临时目录，HOME 只读');
  }
  for (const w of st.warnings) lines.push(`⚠ [${w.source}]${w.field ? ` ${w.field}:` : ''} ${w.message}`);
  for (const e of st.errors) lines.push(`✘ [${e.source}] ${e.message}`);
  return lines.join('\n');
}

/** 构造 status 用的短命 runtime（cwd 即项目根；不做任何命令执行）。 */
export function sandboxStatusCommand(opts: { refresh?: boolean } = {}): void {
  const runtime = createSandboxRuntime({
    projectRoot: process.cwd(),
    sessionId: 'cli-sandbox-status',
    projectId: 'cli',
    interactive: false,
  });
  void runtime
    .status({ refresh: opts.refresh === true })
    .then((st) => {
      console.log(formatSandboxStatus(st));
      if (!st.explicit) {
        console.log('\n启用：`delta sandbox enable`（默认 seatbelt；--mode docker 用容器）');
      }
    })
    .catch((e: unknown) => {
      console.error(`✘ ${(e as Error).message}`);
      process.exitCode = 1;
    });
}

/** enable：写全局 mode（默认 seatbelt；--mode docker 显式选容器）。 */
export function sandboxEnableCommand(opts: { mode?: string }): void {
  const mode = opts.mode === 'docker' ? 'docker' : 'seatbelt';
  try {
    const r = updateUserSandboxMode(mode);
    console.log(`✔ 沙箱已启用（${mode}）：${r.path}`);
    if (mode === 'docker') {
      console.log('ℹ docker 后端需要本机 daemon 运行；未安装 Docker 时建议 `delta sandbox enable`（seatbelt，macOS 自带）');
    }
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** disable：写回 mode=local（其它字段保留）。 */
export function sandboxDisableCommand(): void {
  try {
    const r = updateUserSandboxMode('local');
    console.log(`✔ 沙箱已关闭（local）：${r.path}`);
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/** pull：预拉取 docker 镜像（seatbelt/local 下拒绝——无镜像概念）。 */
export function sandboxPullCommand(opts: { image?: string }): void {
  const runtime = createSandboxRuntime({
    projectRoot: process.cwd(),
    sessionId: 'cli-sandbox-pull',
    projectId: 'cli',
    interactive: false,
  });
  void runtime
    .pull(opts.image)
    .then((r) => {
      console.log(`${r.ok ? '✔' : '✘'} ${r.image}：${r.detail}${r.pulled ? '（本次执行了拉取）' : ''}`);
      if (!r.ok) process.exitCode = 1;
    })
    .catch((e: unknown) => {
      console.error(`✘ ${(e as Error).message}`);
      process.exitCode = 1;
    });
}

/** gc：清理 delta 残留容器（seatbelt/local 下返回 0 个，不报错）。 */
export function sandboxGcCommand(): void {
  const runtime = createSandboxRuntime({
    projectRoot: process.cwd(),
    sessionId: 'cli-sandbox-gc',
    projectId: 'cli',
    interactive: false,
  });
  void runtime
    .gc()
    .then((r) => {
      console.log(r.removed > 0 ? `✔ 已清理 ${r.removed} 个残留容器：${r.names.join(', ')}` : '✔ 无残留容器');
    })
    .catch((e: unknown) => {
      console.error(`✘ ${(e as Error).message}`);
      process.exitCode = 1;
    });
}
