/**
 * P3 领域服务槽。一次 serve 一个 host：按登记顺序 start，按相反顺序 stop。
 * 内置登记见 `builtin-services/`（P3）；用户插件经 activate 的 registerService 追加。
 */
export interface HostService {
  id: string;
  start(): void;
  stop(): void;
}

export interface ServiceHost {
  add(service: HostService): void;
  start(): void;
  stop(): void;
}

export function createServiceHost(): ServiceHost {
  const services: HostService[] = [];
  const ids = new Set<string>();
  let started = false;
  return {
    add(service) {
      if (started) throw new Error(`service host already started: ${service.id}`);
      if (ids.has(service.id)) throw new Error(`service already registered: ${service.id}`);
      ids.add(service.id);
      services.push(service);
    },
    start() {
      if (started) return;
      started = true;
      for (const service of services) service.start();
    },
    stop() {
      if (!started) return;
      started = false;
      for (const service of [...services].reverse()) service.stop();
    },
  };
}
