/**
 * F-39 专家库：三层发现 + mtime 指纹缓存 + 头像校验（design §6.2）
 *
 * 目录语义与 Skills 完全同构：
 *   <core>/experts  <  ~/.delta/experts  <  <projectRoot>/.delta/experts
 *
 * 缓存 key 覆盖「目录 mtime + expert.json + agents/*.md」：
 * 只算目录 mtime 会让「改正文不改文件名」不失效，用户改完包看到旧人格 —— 最容易被当 bug 报的行为。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FILES, projectConfigDir, userConfigDir } from '../paths.js';
import { discoverLayered, type LayeredDir, type LayerName } from '../skills/layered.js';
import { parseExpertPackage, resolveInPackage } from './parser.js';
import type {
  ExpertDiscoverResult,
  ExpertLayer,
  ExpertLayers,
  ExpertListItem,
  ExpertRecord,
} from './types.js';

/** 单层包数上限（超出按名称截断并告警） */
export const MAX_EXPERTS_PER_LAYER = 200;
/** 头像体积上限 */
export const AVATAR_MAX_BYTES = 500 * 1024;
/** 头像允许的扩展名 */
export const AVATAR_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

export interface ExpertStoreOptions {
  /** 项目根（扫描 <root>/.delta/experts）；缺省跳过项目层 */
  projectRoot?: string;
  /** 用户主目录（扫描 <home>/.delta/experts）；缺省跳过用户层 */
  homeDir?: string;
  /** 内置目录；缺省 defaultBuiltinExpertsDir() */
  builtinDir?: string;
  /** 单层包数上限，默认 200 */
  maxPerLayer?: number;
  /** 停用清单（P1 读 ~/.delta/experts.json 的 disabled[]）；P0 恒为空 */
  disabled?: readonly string[];
}

export class ExpertStore {
  private cached: { fingerprint: string; result: ExpertDiscoverResult; byLayer: ExpertLayers['byLayer'] } | null = null;

  constructor(private readonly opts: ExpertStoreOptions = {}) {}

  /** 三层发现（命中 mtime 指纹缓存时零解析） */
  async list(): Promise<ExpertDiscoverResult> {
    const snap = await this.load();
    return { experts: snap.result.experts.slice(), errors: snap.result.errors.slice() };
  }

  /** 单查（走缓存；未命中返回 undefined，不抛错） */
  async get(name: string): Promise<ExpertRecord | undefined> {
    const snap = await this.load();
    return snap.result.experts.find((e) => e.name === name);
  }

  /** 按层原始视图（设置页分组 / `expert list --verbose` 显示被覆盖项） */
  async layers(): Promise<ExpertLayers> {
    const snap = await this.load();
    return {
      byLayer: {
        builtin: snap.byLayer.builtin.slice(),
        user: snap.byLayer.user.slice(),
        project: snap.byLayer.project.slice(),
      },
      errors: snap.result.errors.slice(),
    };
  }

  /** 强制失效（导入/导出/删除/创建后调用） */
  invalidate(): void {
    this.cached = null;
  }

  /** 当前指纹（调试与测试用） */
  async fingerprint(): Promise<string> {
    return this.computeFingerprint();
  }

  private async load(): Promise<NonNullable<ExpertStore['cached']>> {
    const fingerprint = await this.computeFingerprint();
    if (this.cached && this.cached.fingerprint === fingerprint) return this.cached;

    const warnings: string[] = [];
    const layers = this.layerDirs();
    const { byName, entries, errors } = await discoverLayered<ExpertRecord>({
      layers,
      maxPerLayer: this.opts.maxPerLayer ?? MAX_EXPERTS_PER_LAYER,
      readEntry: (dir, name, layer) => this.readExpertDir(dir, name, layer, warnings),
    });

    const disabled = new Set(this.opts.disabled ?? []);
    const experts = [...byName.values()]
      .map((e) => e.value)
      .filter((e) => !disabled.has(e.name));

    const byLayer: ExpertLayers['byLayer'] = { builtin: [], user: [], project: [] };
    for (const entry of entries) {
      if (disabled.has(entry.name)) continue;
      byLayer[entry.layer].push(entry.value);
    }

    this.cached = {
      fingerprint,
      result: { experts, errors: [...warnings, ...errors] },
      byLayer,
    };
    return this.cached;
  }

  private layerDirs(): LayeredDir[] {
    const { projectRoot, homeDir, builtinDir } = this.opts;
    return [
      { layer: 'builtin', dir: builtinDir ?? defaultBuiltinExpertsDir() },
      { layer: 'user', dir: homeDir ? path.join(userConfigDir(homeDir), FILES.expertsDir) : undefined },
      { layer: 'project', dir: projectRoot ? path.join(projectConfigDir(projectRoot), FILES.expertsDir) : undefined },
    ];
  }

  /** 读取并解析单个包目录（IO 全部集中在这里，parser 保持纯函数） */
  private async readExpertDir(
    layerDir: string,
    name: string,
    layer: LayerName,
    warnings: string[],
  ): Promise<ExpertRecord> {
    const dir = path.join(layerDir, name);
    const jsonPath = path.join(dir, 'expert.json');
    const expertJson = await fs.readFile(jsonPath, 'utf-8');

    // 先宽容解析出 agents[]/avatar，供 IO 侧决定读哪些文件（语法错误留给 parser 报）
    let declared: { agents?: unknown; avatar?: unknown } = {};
    try {
      declared = JSON.parse(expertJson) as typeof declared;
    } catch {
      // parser 会给出带行号的错误
    }

    const agentFiles = new Map<string, { raw: string; absPath: string }>();
    const agentList = Array.isArray(declared.agents) ? declared.agents : [];
    for (const rel of agentList) {
      if (typeof rel !== 'string') continue;
      try {
        const abs = resolveInPackage(dir, rel);
        const st = await fs.lstat(abs);
        if (st.isSymbolicLink()) {
          warnings.push(`${layer}/${name}: 拒绝符号链接 ${rel}`);
          continue;
        }
        if (!st.isFile()) continue;
        agentFiles.set(path.basename(abs), { raw: await fs.readFile(abs, 'utf-8'), absPath: abs });
      } catch {
        // 文件缺失 → 交给 parser 抛「声明的文件不存在」
      }
    }

    const avatarPath = await this.checkAvatar(dir, typeof declared.avatar === 'string' ? declared.avatar : undefined, layer, name, warnings);

    return parseExpertPackage(
      { dir, layer: layer as ExpertLayer, name, expertJson, agentFiles, avatarPath },
      warnings,
    );
  }

  /** 头像校验：体积 ≤500KB + 扩展名白名单；不满足 → null + warning（不废整包） */
  private async checkAvatar(
    dir: string,
    rel: string | undefined,
    layer: string,
    name: string,
    warnings: string[],
  ): Promise<string | null> {
    if (!rel) return null;
    try {
      const abs = resolveInPackage(dir, rel);
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink()) {
        warnings.push(`${layer}/${name}: 头像为符号链接，已忽略`);
        return null;
      }
      if (!st.isFile()) return null;
      if (!AVATAR_EXTS.has(path.extname(abs).toLowerCase())) {
        warnings.push(`${layer}/${name}: 头像扩展名 ${path.extname(abs)} 不支持（png/jpg/webp），已忽略`);
        return null;
      }
      if (st.size > AVATAR_MAX_BYTES) {
        warnings.push(`${layer}/${name}: 头像超过 ${AVATAR_MAX_BYTES / 1024}KB，已忽略`);
        return null;
      }
      return abs;
    } catch {
      warnings.push(`${layer}/${name}: 头像路径越界（${rel}），已忽略`);
      return null;
    }
  }

  /** 指纹 = 三层目录 + 每个包目录 + expert.json + agents 目录 + 每个 md 的 mtime */
  private async computeFingerprint(): Promise<string> {
    const hash = createHash('sha1');
    for (const { layer, dir } of this.layerDirs()) {
      if (!dir) continue;
      hash.update(`\n${layer}:${dir}:${await mtime(dir)}`);
      let names: string[] = [];
      try {
        names = (await fs.readdir(dir, { withFileTypes: true }))
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
          .sort()
          .slice(0, this.opts.maxPerLayer ?? MAX_EXPERTS_PER_LAYER);
      } catch {
        continue;
      }
      for (const name of names) {
        const pkgDir = path.join(dir, name);
        hash.update(`\n${pkgDir}:${await mtime(pkgDir)}`);
        hash.update(`\n${path.join(pkgDir, 'expert.json')}:${await mtime(path.join(pkgDir, 'expert.json'))}`);
        const agentsDir = path.join(pkgDir, 'agents');
        hash.update(`\n${agentsDir}:${await mtime(agentsDir)}`);
        try {
          const files = (await fs.readdir(agentsDir, { withFileTypes: true }))
            .filter((e) => e.isFile())
            .map((e) => e.name)
            .sort();
          for (const f of files) {
            const p = path.join(agentsDir, f);
            hash.update(`\n${p}:${await mtime(p)}`);
          }
        } catch {
          // 无 agents 目录 → 交给解析器报错
        }
        // 头像体积变化也要失效（详情页展示依赖）
        hash.update(`\n${path.join(pkgDir, 'avatars')}:${await mtime(path.join(pkgDir, 'avatars'))}`);
      }
    }
    return hash.digest('hex');
  }
}

/** 内置专家默认目录：packages/core/experts/（与 defaultBuiltinSkillsDir 同构） */
export function defaultBuiltinExpertsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../experts');
}

/**
 * 列表 DTO 映射：不内联 body / 头像内容（D13），只给 UI 需要的元信息。
 * `enabledMcp` = 当前已启用的 MCP server 名（用于 missingMcp 计算）。
 */
export function toExpertListItem(record: ExpertRecord, enabledMcp: readonly string[] = []): ExpertListItem {
  const enabled = new Set(enabledMcp);
  return {
    name: record.name,
    displayName: record.displayName,
    profession: record.profession,
    expertType: record.expertType,
    layer: record.layer,
    description: record.description,
    keywords: record.keywords,
    categoryId: record.categoryId,
    memberCount: record.members.length,
    missingMcp: record.dependencies.mcpServers.filter((m) => !enabled.has(m)),
    hasAvatar: record.avatarPath !== null,
  };
}

async function mtime(p: string): Promise<string> {
  try {
    const st = await fs.stat(p);
    return String(st.mtimeMs);
  } catch {
    return 'missing';
  }
}
