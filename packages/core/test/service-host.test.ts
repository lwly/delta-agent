import { describe, expect, it } from 'vitest';
import { createServiceHost } from '../src/plugins/services.js';

describe('createServiceHost', () => {
  it('start 按登记顺序，stop 按相反顺序', () => {
    const log: string[] = [];
    const host = createServiceHost();
    host.add({ id: 'dispatcher', start: () => log.push('start:dispatcher'), stop: () => log.push('stop:dispatcher') });
    host.add({ id: 'cron', start: () => log.push('start:cron'), stop: () => log.push('stop:cron') });
    host.start();
    host.stop();
    expect(log).toEqual(['start:dispatcher', 'start:cron', 'stop:cron', 'stop:dispatcher']);
  });

  it('重复 id、启动后登记都抛错；stop 未启动与二次 stop 为空操作', () => {
    const host = createServiceHost();
    host.add({ id: 'cron', start() {}, stop() {} });
    expect(() => host.add({ id: 'cron', start() {}, stop() {} })).toThrow(/already registered: cron/);
    host.stop();
    host.start();
    host.start();
    expect(() => host.add({ id: 'notify', start() {}, stop() {} })).toThrow(/already started: notify/);
    host.stop();
    host.stop();
  });
});
