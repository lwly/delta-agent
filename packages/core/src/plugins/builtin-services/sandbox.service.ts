import { probeDocker } from '../../sandbox/probe.js';
import { realDockerCli } from '../../sandbox/docker-cli.js';
import type { HostService } from '../services.js';

export function createSandboxService(log: (line: string) => void): HostService {
  return {
    id: 'sandbox',
    start() {
      void probeDocker(realDockerCli).then((r) => {
        if (r.available) log(`✔ 沙箱：Docker 可用（${r.serverVersion ?? 'server ok'}）`);
        else log(`ℹ 沙箱：Docker 不可用（${r.reason ?? 'unknown'}）；容器沙箱降级为路径沙箱`);
      });
    },
    stop() {},
  };
}
