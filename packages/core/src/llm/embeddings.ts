/**
 * F-17 语义检索：OpenAI 兼容 `/embeddings` 客户端 + 配置解析。
 * - 显式 env（YZERO_EMBEDDING_*）> 各厂商 env Key（DASHSCOPE/OPENAI）> 存储配置（~/.y-zero/models.json）
 * - 解析失败/无 Key 返回 undefined（调用方降级为纯全文检索），不抛错。
 */
import { loadModelsFile, modelsConfigPath, decryptKeyDetailed } from './keychain.js';

export interface EmbeddingOptions {
  apiKey: string;
  /** 须含版本路径，如 https://api.openai.com/v1 */
  baseUrl: string;
  model: string;
}

/** 各厂商 embedding 默认配置（仅 openai 兼容端点） */
export const VENDOR_EMBEDDING: Record<string, { model: string; baseUrl?: string }> = {
  qwen: { model: 'text-embedding-v4', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  openai: { model: 'text-embedding-3-small' },
};

export class EmbeddingClient {
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(opts: EmbeddingOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.model = opts.model;
  }

  /** 批量 embedding（调用方控制批大小）；返回向量顺序与输入一致。 */
  async embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal,
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`embeddings ${res.status}: ${body}`);
    }
    const json = (await res.json()) as {
      data?: Array<{ index?: number; embedding: number[] }>;
    };
    const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return data.map((d) => d.embedding);
  }
}

/**
 * 解析可用的 EmbeddingClient；无可用配置返回 undefined。
 * `modelsFile` 覆盖存储位置（DI / 测试用）。
 */
export function resolveEmbedding(opts?: { modelsFile?: string }): EmbeddingClient | undefined {
  const explicit = process.env.YZERO_EMBEDDING_API_KEY;
  if (explicit) {
    return new EmbeddingClient({
      apiKey: explicit,
      baseUrl: process.env.YZERO_EMBEDDING_BASE_URL ?? 'https://api.openai.com/v1',
      model: process.env.YZERO_EMBEDDING_MODEL ?? 'text-embedding-3-small',
    });
  }
  if (process.env.DASHSCOPE_API_KEY) {
    const qwen = VENDOR_EMBEDDING.qwen!;
    return new EmbeddingClient({
      apiKey: process.env.DASHSCOPE_API_KEY,
      baseUrl: qwen.baseUrl!,
      model: process.env.YZERO_EMBEDDING_MODEL ?? qwen.model,
    });
  }
  if (process.env.OPENAI_API_KEY) {
    return new EmbeddingClient({
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: 'https://api.openai.com/v1',
      model: process.env.YZERO_EMBEDDING_MODEL ?? VENDOR_EMBEDDING.openai!.model,
    });
  }
  // env miss → 存储配置（`yzero models add` 保存的 openai 兼容厂商）
  try {
    const data = loadModelsFile(opts?.modelsFile ?? modelsConfigPath());
    for (const p of data.providers) {
      if (!p.enabled) continue;
      const emb = VENDOR_EMBEDDING[p.id];
      if (!emb) continue; // deepseek/anthropic 无 embedding API，跳过
      const d = decryptKeyDetailed(p.apiKey);
      if (!d.plain) continue;
      return new EmbeddingClient({
        apiKey: d.plain,
        baseUrl: p.baseUrl ?? emb.baseUrl ?? 'https://api.openai.com/v1',
        model: process.env.YZERO_EMBEDDING_MODEL ?? emb.model,
      });
    }
  } catch {
    /* 存储配置读取失败 → 视为不可用 */
  }
  return undefined;
}
