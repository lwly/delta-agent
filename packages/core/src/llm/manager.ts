import type { LLMProvider } from '@y-zero/shared';
import {
  encryptKey,
  decryptKey,
  decryptKeyDetailed,
  loadModelsFile,
  saveModelsFile,
  modelsConfigPath,
  maskKey,
  type StoredProvider,
  type RoutingConfig,
} from './keychain.js';

const KNOWN_VENDORS: Record<string, StoredProvider['vendor']> = {
  anthropic: 'anthropic',
  openai: 'openai-compatible',
  deepseek: 'openai-compatible',
  qwen: 'openai-compatible',
};

export interface ProviderView {
  id: string;
  vendor: StoredProvider['vendor'];
  baseUrl?: string;
  model?: string;
  enabled: boolean;
  default: boolean;
  keyMasked: string;
}

/** Managed provider configuration (F-04a): CRUD + enable/default/order + resolve. */
export class ProviderManager {
  private file: string;

  constructor(file?: string) {
    this.file = file ?? modelsConfigPath();
  }

  private load() {
    return loadModelsFile(this.file);
  }

  private save(data: ReturnType<ProviderManager['load']>): void {
    saveModelsFile(data, this.file);
  }

  /** All providers (keys masked) in stored order. */
  list(): ProviderView[] {
    return this.load().providers.map((p) => ({
      id: p.id,
      vendor: p.vendor,
      baseUrl: p.baseUrl,
      model: p.model,
      enabled: p.enabled,
      default: Boolean(p.default),
      keyMasked: maskKey(p.apiKey),
    }));
  }

  /** Add (or replace) a provider. `id` must be a known vendor or any openai-compatible id.
   *  apiKey 留空时：编辑已有 Provider 视为「保留原 Key」（密文原样沿用，不二次加密）；新增仍必须提供。 */
  add(opts: {
    id: string;
    apiKey: string;
    baseUrl?: string;
    model?: string;
    setDefault?: boolean;
  }): void {
    const data = this.load();
    const idx = data.providers.findIndex((p) => p.id === opts.id);
    if (!opts.apiKey && idx < 0) throw new Error('apiKey 不能为空');
    const vendor = KNOWN_VENDORS[opts.id] ?? 'openai-compatible';
    const entry: StoredProvider = {
      id: opts.id,
      vendor,
      apiKey: opts.apiKey ? encryptKey(opts.apiKey) : data.providers[idx]!.apiKey,
      baseUrl: opts.baseUrl,
      model: opts.model,
      enabled: true,
      default: Boolean(opts.setDefault),
    };
    if (idx >= 0) {
      entry.enabled = data.providers[idx]!.enabled;
      entry.default = data.providers[idx]!.default;
      data.providers[idx] = entry;
    } else {
      data.providers.push(entry);
    }
    if (opts.setDefault) this.applyDefault(data, opts.id);
    this.save(data);
  }

  remove(id: string): boolean {
    const data = this.load();
    const idx = data.providers.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    const wasDefault = Boolean(data.providers[idx]!.default);
    data.providers.splice(idx, 1);
    if (wasDefault && data.providers.length > 0) data.providers[0]!.default = true;
    this.save(data);
    return true;
  }

  setDefault(id: string): void {
    const data = this.load();
    this.applyDefault(data, id);
    this.save(data);
  }

  private applyDefault(data: { providers: StoredProvider[] }, id: string): void {
    const target = data.providers.find((p) => p.id === id);
    if (!target) throw new Error(`未找到 provider: ${id}`);
    for (const p of data.providers) p.default = p.id === id;
  }

  setEnabled(id: string, enabled: boolean): void {
    const data = this.load();
    const target = data.providers.find((p) => p.id === id);
    if (!target) throw new Error(`未找到 provider: ${id}`);
    target.enabled = enabled;
    if (!enabled && target.default) {
      target.default = false;
      const next = data.providers.find((p) => p.enabled);
      if (next) next.default = true;
    }
    this.save(data);
  }

  /** Move a provider up/down in the probe order. */
  move(id: string, dir: 'up' | 'down'): void {
    const data = this.load();
    const idx = data.providers.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`未找到 provider: ${id}`);
    const to = dir === 'up' ? idx - 1 : idx + 1;
    if (to < 0 || to >= data.providers.length) return;
    const [item] = data.providers.splice(idx, 1);
    data.providers.splice(to, 0, item!);
    this.save(data);
  }

  /**
   * Enabled providers in probe order (default first, then stored order).
   * Used as the fallback chain when no env key is configured.
   */
  activeIds(): string[] {
    const enabled = this.load().providers.filter((p) => p.enabled);
    const sorted = [...enabled].sort((a, b) => Number(b.default ?? false) - Number(a.default ?? false));
    return sorted.map((p) => p.id);
  }

  /** Stored config for one provider, key decrypted. */
  private storedById(id: string): StoredProvider | undefined {
    return this.load().providers.find((p) => p.id === id);
  }

  /** Construct a live LLMProvider from stored config (key must decrypt). */
  async createProvider(id: string): Promise<LLMProvider> {
    const stored = this.storedById(id);
    if (!stored) throw new Error(`未找到 provider: ${id}`);
    const d = decryptKeyDetailed(stored.apiKey);
    if (!d.plain) throw new Error(`provider ${id} 的 Key 无法解密（是否换了机器？请重新 add）`);
    // 旧 hostname 派生方案解密成功 → 透明升级为稳定平台号方案重加密（防 hostname 漂移复发）
    if (d.scheme === 'legacy-hostname') this.upgradeKeyEncryption(stored.id, d.plain);
    const apiKey = d.plain;
    if (stored.vendor === 'anthropic') {
      const { AnthropicProvider } = await import('./providers/anthropic.js');
      return new AnthropicProvider({ apiKey, baseUrl: stored.baseUrl, model: stored.model });
    }
    if (stored.id === 'deepseek') {
      const { DeepSeekProvider } = await import('./providers/deepseek.js');
      return new DeepSeekProvider({ apiKey, baseUrl: stored.baseUrl, model: stored.model });
    }
    if (stored.id === 'qwen') {
      const { QwenProvider } = await import('./providers/qwen.js');
      return new QwenProvider({ apiKey, baseUrl: stored.baseUrl, model: stored.model });
    }
    const { OpenAICompatibleProvider } = await import('./providers/openai-compatible.js');
    return new OpenAICompatibleProvider({
      id: stored.id,
      apiKey,
      baseUrl: stored.baseUrl,
      model: stored.model,
    });
  }

  /** 用稳定方案重加密某 provider 的 Key 并落盘（一次性升级）。 */
  private upgradeKeyEncryption(id: string, plainKey: string): void {
    try {
      const data = this.load();
      const p = data.providers.find((x) => x.id === id);
      if (!p) return;
      p.apiKey = encryptKey(plainKey);
      this.save(data);
    } catch {
      // 升级失败不影响本次使用（下次仍走 legacy 回退）
    }
  }

  // ── F-32 模型路由配置（routing 字段 CRUD，CLI/Web 设置页共用）────────────

  /** 读取路由配置（未配置时返回 undefined） */
  getRouting(): RoutingConfig | undefined {
    return this.load().routing;
  }

  /** 整体写入路由配置；传 undefined 清除（回退全部走主模型） */
  setRouting(routing: RoutingConfig | undefined): void {
    const data = this.load();
    if (routing) {
      // 写入前兜底校验：每条规则必须有非空 model
      for (const [kind, rule] of Object.entries(routing.rules)) {
        if (!rule || typeof rule.model !== 'string' || rule.model.trim() === '') {
          throw new Error(`路由规则 ${kind} 非法：model 不能为空`);
        }
      }
    }
    data.routing = routing;
    this.save(data);
  }

  /** Connectivity probe: minimal chat request, returns latency ms. */
  async test(id: string, timeoutMs = 15_000): Promise<{ ok: boolean; latencyMs: number; detail: string }> {    const t0 = Date.now();
    try {
      const provider = await this.createProvider(id);
      const stored = this.storedById(id);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        for await (const ev of provider.chat({
          messages: [{ role: 'user', content: 'ping' }],
          tools: [],
          model: stored?.model ?? '',
          maxTokens: 8,
          signal: ac.signal,
        })) {
          if (ev.type === 'error') return { ok: false, latencyMs: Date.now() - t0, detail: ev.message };
          if (ev.type === 'done') break;
        }
      } finally {
        clearTimeout(timer);
      }
      return { ok: true, latencyMs: Date.now() - t0, detail: '连通正常' };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, detail: (e as Error).message };
    }
  }
}
