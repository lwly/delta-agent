/**
 * 桌面壳桥接探测单测：node 环境（无 window）恒不可用；
 * 桥接存在时透传结果；取消（null）/ 抛异常均降级为 null，不向调用方弹错。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hasDesktopBridge, pickDirectory } from './desktop';

type Bridge = { pickDirectory: () => Promise<string | null> };

function installBridge(bridge: Bridge | undefined) {
  (globalThis as { window?: unknown }).window = bridge ? { deltaDesktop: bridge } : {};
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('hasDesktopBridge', () => {
  it('node 环境无 window：不可用', () => {
    expect(hasDesktopBridge()).toBe(false);
  });

  it('window.deltaDesktop 存在且 pickDirectory 为函数：可用', () => {
    installBridge({ pickDirectory: async () => null });
    expect(hasDesktopBridge()).toBe(true);
  });

  it('deltaDesktop 形状不符（缺方法）：不可用', () => {
    (globalThis as { window?: unknown }).window = { deltaDesktop: {} };
    expect(hasDesktopBridge()).toBe(false);
  });
});

describe('pickDirectory', () => {
  it('桥接不可用：返回 null（浏览器形态降级手输）', async () => {
    expect(await pickDirectory()).toBeNull();
  });

  it('桥接可用：透传所选绝对路径', async () => {
    installBridge({ pickDirectory: async () => 'C:\\repo\\demo' });
    expect(await pickDirectory()).toBe('C:\\repo\\demo');
  });

  it('用户取消（桥接返回 null）：透传 null', async () => {
    installBridge({ pickDirectory: async () => null });
    expect(await pickDirectory()).toBeNull();
  });

  it('桥接调用异常：降级为 null 不抛出', async () => {
    installBridge({ pickDirectory: async () => { throw new Error('ipc failed'); } });
    expect(await pickDirectory()).toBeNull();
  });
});
