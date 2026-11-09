import { autoOnboardProject } from '../../onboarding/index.js';
import { defaultModelFor } from '../../llm/defaults.js';
import { resolveProviderFromEnv } from '../../session/service.js';
import type { BuiltinServicesOptions } from './types.js';
import type { HostService } from '../services.js';

export function createOnboardingService(
  opts: Pick<BuiltinServicesOptions, 'log' | 'logError' | 'onboarding'>,
): HostService | null {
  const target = opts.onboarding;
  if (!target) return null;
  return {
    id: 'onboarding',
    start() {
      void (async () => {
        try {
          const onboardingProvider = await resolveProviderFromEnv(undefined);
          const r = await autoOnboardProject({
            projectRoot: target.projectRoot,
            provider: onboardingProvider,
            model: process.env.DELTA_MODEL || defaultModelFor(onboardingProvider.id),
          });
          if (r && !r.skipped) {
            opts.log(`✔ onboarding 草案已生成：${r.agentMdDraftPath}（用 \`delta onboarding confirm\` 采纳）`);
          }
        } catch {
          opts.logError('⚠ onboarding 扫描失败（可稍后手动运行 `delta onboarding run`）');
        }
      })();
    },
    stop() {},
  };
}
