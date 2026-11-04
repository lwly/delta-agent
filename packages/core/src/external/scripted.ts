/**
 * F-55 Scripted 外部适配器：测试 / e2e 专用（对齐 llm/fake-provider.ts 的
 * 「测试支撑代码进生产 src」先例，默认关闭、对生产链路零影响）。
 *
 * 用法：DELTA_FAKE_CLI 环境变量指向场景 JSON 文件（即 fake-cli.mjs 读取的
 * FAKE_CLI_SCRIPT 同一场景，adapter 会把它镜像为子进程的 FAKE_CLI_SCRIPT），
 * fake-cli.mjs 路径由 adapter 按 import.meta.url 自行解析（见 FAKE_CLI_PATH）。
 *
 * 注册时机说明：注册逻辑放在本模块加载时（env 命中才生效）而非
 * resolveExternalAdapter 内部 lazy 检查——ESM 无同步动态 import，而
 * resolveExternalAdapter 是同步签名（engine/external.ts 与 hub 均同步调用），
 * 改异步会波及调用方；本模块经 barrel（index.ts）导出，宿主装配 @delta/core
 * 时即完成注册，env 未命中时零副作用。
 *
 * 红线：本适配器不做任何真实协议解析（只逐行 parse ExternalEvent JSONL）；
 * P2 的 external/stream-json.ts 才是协议特化实现。
 */
import { fileURLToPath } from 'node:url';
import { spawnExternal } from './spawn.js';
import { registerExternalAdapter } from './registry.js';
import type { ExternalAgentAdapter, ExternalAgentSpec, ExternalEvent } from './types.js';

/** 假 CLI fixture 绝对路径：test/fixtures/fake-cli.mjs（测试/e2e 专用，不随 dist 发布） */
const FAKE_CLI_PATH = fileURLToPath(
  new URL('../../test/fixtures/fake-cli.mjs', import.meta.url),
);

export class ScriptedExternalAdapter implements ExternalAgentAdapter {
  readonly spec: ExternalAgentSpec = {
    id: 'cli:fake',
    kind: 'stream-json-jsonl',
    command: process.execPath,
    args: [FAKE_CLI_PATH],
    tier: 'A',
    version: 'fake',
    // 假 CLI 无权限语义，三档全空
    permissionArgs: { plan: [], default: [], yolo: [] },
  };

  /** 最近一次 run() 的进程句柄（stderrTail 供映射引擎收尾带出 stderr 摘要） */
  private lastProc: ReturnType<typeof spawnExternal> | undefined;

  stderrTail(): string[] {
    return this.lastProc?.stderrTail() ?? [];
  }

  async *run(req: {
    prompt: string;
    cwd: string;
    permissionMode: 'plan' | 'default' | 'yolo';
    resumeSessionId?: string;
    mcpConfigPath?: string;
    signal: AbortSignal;
  }): AsyncGenerator<ExternalEvent> {
    // 场景 JSON → 子进程：DELTA_FAKE_CLI 指向场景文件，fake-cli.mjs 读的是 FAKE_CLI_SCRIPT。
    // 经 spawnExternal 的 extraEnv 直接注入（不改父进程 env，P4 多场景并发安全）
    const scriptPath = process.env.DELTA_FAKE_CLI ?? '';
    const proc = spawnExternal({
      command: process.execPath,
      args: [FAKE_CLI_PATH],
      cwd: req.cwd,
      extraEnv: scriptPath ? { FAKE_CLI_SCRIPT: scriptPath } : undefined,
      signal: req.signal,
    });
    this.lastProc = proc;
    try {
      for await (const ev of proc.events) {
        if (ev.type === 'line') {
          try {
            const parsed = JSON.parse(ev.text) as ExternalEvent;
            if (typeof parsed?.type !== 'string') throw new Error('缺少 type 字段');
            yield parsed;
          } catch {
            // 非法行不致命：透出 error 事件带原始行，继续消费后续输出
            yield { type: 'error', message: `fake-cli 输出行不是合法 ExternalEvent JSON：${ev.text}`, fatal: false };
          }
        }
        // stderr_line：spawnExternal 已进环形缓冲，脚本化场景无需上抛
        // 进程收尾统一映射为 done 事件：脚本未显式 stdout done 时兜底，
        // 保证退出码语义可达映射引擎（engine/external.ts 的 fatal 判定依赖它）
        else if (ev.type === 'exit') {
          yield { type: 'done', exitCode: ev.code ?? -1 };
        }
      }
    } finally {
      // 消费方提前 return（引擎收到 done 即 break）时确保子进程收敛；已退出时幂等
      await proc.cancel();
    }
  }
}

// DELTA_FAKE_CLI 命中 → 自动注册（见文件头「注册时机说明」）；env 指向场景 JSON，
// fake-cli.mjs 路径由 adapter 自己按 import.meta.url 解析，env 不承载路径信息。
if (process.env.DELTA_FAKE_CLI) {
  registerExternalAdapter(new ScriptedExternalAdapter());
}
