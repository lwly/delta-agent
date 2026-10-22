/**
 * 降级链（设计 §7）—— 全部是**纯函数**，不探测、不 IO、可直接表驱动单测。
 *
 * `resolveExecutionPlan` 只回答「这一次该跑在哪」；真正执行（含 confirmDegrade 询问）
 * 由 `SandboxRuntime` 承担，保证决策与副作用分离。
 */
import type {
  ExecutionPlan,
  SandboxConfig,
  SandboxFallback,
  SandboxProbeReason,
  SandboxProbeResult,
} from './types.js';
import { DEFAULT_SANDBOX_IMAGE } from './types.js';

export interface ResolvePlanInput {
  config: SandboxConfig;
  /** null = 尚未探测（mode=local 的常态；本函数内**绝不触发探测**） */
  probe: SandboxProbeResult | null;
  interactive: boolean;
  degradeApproved: boolean;
}

/**
 * 决策链（与 PRD §5.2 / 设计 §7.2 表逐格对齐）：
 *   mode=local                        → {local, mode_local}
 *   可用                              → {docker, docker_ready}
 *   enforce 且不可用                   → {deny, enforced_deny}
 *   fallback=deny                     → {deny, fallback_deny}
 *   fallback=ask + 已获准              → {local, degrade_approved}
 *   fallback=ask + 交互式              → {ask, fallback_ask}
 *   fallback=ask + 非交互              → {deny, fallback_ask_headless}
 *   fallback=local                    → {local, fallback_local}
 */
export function resolveExecutionPlan(input: ResolvePlanInput): ExecutionPlan {
  const { config, probe, interactive, degradeApproved } = input;

  // 1) 配置 local：不探测、零开销（probe 传 null 是常态）
  if (config.mode === 'local') return { action: 'local', reason: 'mode_local' };

  // 2) Docker 可用
  if (probe?.available === true) return { action: 'docker', reason: 'docker_ready' };

  // 3) enforce：容器是项目强制的隔离承诺，只允许 deny（双保险，配置阶段已强制 fallback=deny）
  if (config.enforce) return { action: 'deny', reason: 'enforced_deny' };

  // 4) fallback 三档（probe=null 视同不可用：宁可拒绝也不静默降级）
  const fallback: SandboxFallback = config.fallback;
  if (fallback === 'local') return { action: 'local', reason: 'fallback_local' };
  if (fallback === 'deny') return { action: 'deny', reason: 'fallback_deny' };

  // fallback === 'ask'
  if (!interactive) return { action: 'deny', reason: 'fallback_ask_headless' };
  if (degradeApproved) return { action: 'local', reason: 'degrade_approved' };
  return { action: 'ask', reason: 'fallback_ask' };
}

export interface UnavailableMessageInput {
  reason: SandboxProbeReason;
  /** 判定依据（probe.detail） */
  detail: string;
  fallback: SandboxFallback;
  image: string;
  enforced: boolean;
  interactive: boolean;
}

/** reason → 第一行动作（全部是可照做的具体指令）。 */
function firstAction(reason: SandboxProbeReason, image: string): string {
  switch (reason) {
    case 'cli_missing':
      return '安装 Docker Desktop（或 docker CLI）并确认 `docker version` 在 PATH 中可执行';
    case 'permission_denied':
      return '把当前用户加入 docker 组（或修 /var/run/docker.sock 权限）后重试';
    case 'timeout':
      return '重启 Docker Desktop 后重试（可用 `yzero sandbox status` 复查）';
    case 'image_unavailable':
      return `拉取镜像：\`yzero sandbox pull\`（或检查镜像名 sandbox.image=${image} 与网络）`;
    case 'daemon_down':
    case 'not_applicable':
    default:
      return '启动 Docker Desktop（daemon）后重试（可用 `yzero sandbox status` 复查）';
  }
}

/**
 * 「不可用/拒绝」文案的**唯一生成点**（§15.9）。
 * 三段缺一不可：判定依据 + 后果 + ≥2 个可执行动作。
 *
 * `enforced=true` 时不给「设置 fallback:'ask'」这类在 enforce 下必然被拒的假动作。
 */
export function buildUnavailableMessage(input: UnavailableMessageInput): string {
  const { reason, detail, fallback, image, enforced, interactive } = input;
  const head = `[sandbox] Docker 不可用：${detail}`;

  const consequence =
    fallback === 'ask' && !interactive
      ? '  命令未执行——非交互（headless）下 fallback=ask 等价于 deny，容器隔离在本次不可用。'
      : `  命令未执行——容器隔离在本次不可用，已按 fallback=${fallback} 拒绝。`;

  const actions: string[] = [firstAction(reason, image)];
  if (enforced) {
    actions.push('联系项目维护者调整 .y-zero/sandbox.json（enforce:true 下会话无法降级）');
    actions.push('在维护者调整前，直接在宿主 shell 执行该命令（不经过 yzero）');
  } else {
    actions.push('本次临时改用本地执行：`yzero run ... --sandbox local`');
    actions.push(
      fallback === 'ask'
        ? '若希望本项目始终不降级（不再询问）：.y-zero/sandbox.json → {"fallback":"deny"}'
        : '长期允许降级并询问：.y-zero/sandbox.json → {"fallback":"ask"}',
    );
  }

  const lines = [head, consequence, '  下一步任选其一：'];
  actions.forEach((action, i) => lines.push(`    ${i + 1}) ${action}`));
  return lines.join('\n');
}

/** 文案里必须带镜像名（诊断时用户第一眼要知道「哪个镜像不可用」）。 */
export function unavailableImageLabel(image: string | undefined): string {
  return image && image.trim() !== '' ? image : DEFAULT_SANDBOX_IMAGE;
}
