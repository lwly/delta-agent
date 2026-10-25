/**
 * F-32 模型路由单测：ModelRouter 解析 + ProviderManager routing CRUD + 配置容错。
 * 全部走临时 models.json（DI file 参数），不触碰真实 ~/.delta。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { saveModelsFile } from '../src/llm/keychain.js';
import { ProviderManager } from '../src/llm/manager.js';
import { ModelRouter } from '../src/llm/router.js';

let tmpFile = '';

beforeEach(() => {
  tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yz-router-')), 'models.json');
});

function seed(data: unknown): string {
  // 直接落盘任意 JSON（含非法 routing），用于验证 loadModelsFile 容错
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
  return tmpFile;
}

describe('ModelRouter', () => {
  it('returns undefined when no config file / no routing field', () => {
    saveModelsFile({ version: 1, providers: [] }, tmpFile);
    expect(new ModelRouter(tmpFile).resolve('distill')).toBeUndefined();
    expect(new ModelRouter(tmpFile).config()).toBeUndefined();
  });

  it('returns undefined when routing disabled', () => {
    const file = seed({
      version: 1,
      providers: [],
      routing: { enabled: false, rules: { distill: { model: 'deepseek-chat' } } },
    });
    expect(new ModelRouter(file).resolve('distill')).toBeUndefined();
  });

  it('resolves a configured kind with provider passthrough', () => {
    const file = seed({
      version: 1,
      providers: [],
      routing: {
        enabled: true,
        rules: { distill: { provider: 'deepseek', model: 'deepseek-chat' }, classify: { model: 'qwen-turbo' } },
      },
    });
    const r = new ModelRouter(file);
    expect(r.resolve('distill')).toEqual({ provider: 'deepseek', model: 'deepseek-chat', kind: 'distill' });
    // 未指定 provider → undefined（跟随会话主 Provider）
    expect(r.resolve('classify')).toEqual({ provider: undefined, model: 'qwen-turbo', kind: 'classify' });
  });

  it('returns undefined for unknown kind', () => {
    const file = seed({
      version: 1,
      providers: [],
      routing: { enabled: true, rules: { summarize: { model: 'm' } } },
    });
    const r = new ModelRouter(file);
    expect(r.resolve('summarize')).toBeDefined();
    expect(r.resolve('execute')).toBeUndefined(); // 未配置的 kind
  });

  it('blank-model rule invalidates the whole routing block (all-or-nothing load)', () => {
    const file = seed({
      version: 1,
      providers: [],
      routing: { enabled: true, rules: { distill: { model: '  ' }, summarize: { model: 'm' } } },
    });
    const r = new ModelRouter(file);
    expect(r.config()).toBeUndefined();
    expect(r.resolve('summarize')).toBeUndefined(); // 整体忽略，不部分生效
  });

  it('ignores malformed routing payloads (tolerant load)', () => {
    // rules 缺失 / model 类型错误 → routing 整体忽略，providers 仍可读
    const file = seed({
      version: 1,
      providers: [{ id: 'deepseek', vendor: 'openai-compatible', apiKey: 'sk', enabled: true }],
      routing: { enabled: true, rules: { distill: { model: 42 } } },
    });
    const r = new ModelRouter(file);
    expect(r.config()).toBeUndefined();
    expect(r.resolve('distill')).toBeUndefined();
    const mgr = new ProviderManager(tmpFile);
    expect(mgr.list()).toHaveLength(1);
  });
});

describe('ProviderManager routing CRUD', () => {
  it('setRouting persists and getRouting round-trips', () => {
    const mgr = new ProviderManager(tmpFile);
    expect(mgr.getRouting()).toBeUndefined();
    mgr.setRouting({ enabled: true, rules: { distill: { provider: 'qwen', model: 'qwen-turbo' } } });
    expect(mgr.getRouting()).toEqual({
      enabled: true,
      rules: { distill: { provider: 'qwen', model: 'qwen-turbo' } },
    });
    // 清除路由
    mgr.setRouting(undefined);
    expect(mgr.getRouting()).toBeUndefined();
  });

  it('setRouting rejects rules with blank model', () => {
    const mgr = new ProviderManager(tmpFile);
    expect(() => mgr.setRouting({ enabled: true, rules: { distill: { model: '' } } })).toThrow(/model 不能为空/);
  });

  it('routing survives provider CRUD (same file, no clobber)', () => {
    const mgr = new ProviderManager(tmpFile);
    mgr.add({ id: 'deepseek', apiKey: 'sk-test', model: 'deepseek-chat' });
    mgr.setRouting({ enabled: true, rules: { distill: { model: 'deepseek-chat' } } });
    mgr.setDefault('deepseek'); // 再次读写 models.json 不应丢 routing
    expect(mgr.getRouting()?.enabled).toBe(true);
    expect(mgr.list()).toHaveLength(1);
  });
});
