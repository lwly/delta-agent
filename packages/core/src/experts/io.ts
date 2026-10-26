/**
 * F-39 P1（T15）：专家包 zip 导入 / 导出 / 创建骨架
 *
 * 安全约束（design R4 / AC-11）：
 * - zip-slip：拒绝绝对路径与 `..` 越界条目
 * - zip 炸弹：解压总量 ≤ MAX_EXTRACT_BYTES（复用 Skill Hub 的 64MB 口径）
 * - 目标层只能是 user/project；**内置层禁止覆盖**
 * - 装完即用解析器试解析，坏包不落盘（先写临时目录，校验通过再就位）
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { zipSync, strToU8, Unzip, UnzipInflate } from 'fflate';
import { FILES, projectConfigDir, userConfigDir } from '../paths.js';
import { MAX_EXTRACT_BYTES } from '../skills/hub.js';
import { parseExpertPackage, validateExpertName } from './parser.js';
import { ExpertStore } from './store.js';
import type { ExpertLayer } from './types.js';

export interface ImportResult {
  name: string;
  layer: 'user' | 'project';
  dir: string;
  /** 非致命告警（如成员剔除、头像忽略） */
  warnings: string[];
}

export function expertsLayerDir(layer: 'user' | 'project', opts: { homeDir?: string; projectRoot?: string }): string {
  return layer === 'user'
    ? path.join(userConfigDir(opts.homeDir ?? ''), FILES.expertsDir)
    : path.join(projectConfigDir(opts.projectRoot ?? ''), FILES.expertsDir);
}

/**
 * 解压为「相对路径 → 内容」映射（流式，替代 unzipSync）：
 * fflate 的 unzipSync 对「显式目录条目 + 子目录文件」会栈溢出（fltn 递归缺陷），
 * 且无法在解压前过滤目录条目 —— 故用 Unzip 流式回调，目录条目直接跳过。
 */
function unzipEntries(bytes: Uint8Array): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    const out: Record<string, Uint8Array> = {};
    let total = 0;
    let failed = false;
    const uz = new Unzip((file) => {
      if (file.name.endsWith('/')) return; // 目录条目
      const chunks: Uint8Array[] = [];
      let size = 0;
      file.ondata = (err, data, final) => {
        if (failed) return;
        if (err) {
          failed = true;
          reject(new Error(`zip 解压失败：${String(err)}`));
          return;
        }
        chunks.push(data);
        size += data.length;
        total += data.length;
        if (total > MAX_EXTRACT_BYTES) {
          failed = true;
          reject(new Error(`zip 解压总量超过上限（${MAX_EXTRACT_BYTES / 1024 / 1024}MB），疑似 zip 炸弹，已中止`));
          return;
        }
        if (final) out[file.name] = concat(chunks, size);
      };
      file.start();
    });
    uz.register(UnzipInflate);
    uz.push(bytes, true);
    if (!failed) resolve(out);
  });
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** 条目路径清洗：拒绝绝对路径 / `..` / 反斜杠逃逸 */
function safeEntryPath(rel: string): string | null {
  const norm = rel.replace(/\\/g, '/');
  if (path.isAbsolute(norm) || norm.split('/').includes('..')) return null;
  return norm;
}

/** 顶层目录剥离：zip 内若只有单一顶层目录且 expert.json 在其下，则剥掉前缀 */
function stripCommonRoot(entries: Record<string, Uint8Array>): Record<string, Uint8Array> {
  if (entries['expert.json']) return entries;
  const tops = new Set(Object.keys(entries).map((k) => k.split('/')[0]!));
  if (tops.size !== 1) return entries;
  const top = [...tops][0]!;
  const stripped: Record<string, Uint8Array> = {};
  let found = false;
  for (const [k, v] of Object.entries(entries)) {
    if (!k.startsWith(`${top}/`)) continue;
    stripped[k.slice(top.length + 1)] = v;
    if (k === `${top}/expert.json`) found = true;
  }
  return found ? stripped : entries;
}

/** 从 zip 字节流安装（导入链第 1-5 步共用） */
export async function installExpertFromBytes(
  bytes: Uint8Array,
  opts: {
    layer: 'user' | 'project';
    force?: boolean;
    homeDir?: string;
    projectRoot?: string;
  },
): Promise<ImportResult> {
  const { layer, force = false } = opts;
  const entries = stripCommonRoot(await unzipEntries(bytes));

  // 必含 expert.json
  const expertJsonEntry = entries['expert.json'];
  if (!expertJsonEntry) throw new Error('zip 缺少 expert.json（必须在包根）');
  const expertJson = new TextDecoder().decode(expertJsonEntry);

  // 包名前置校验（决定目标目录）
  let pkgName = '';
  try {
    pkgName = (JSON.parse(expertJson) as { name?: string }).name ?? '';
  } catch {
    throw new Error('expert.json 不是合法 JSON');
  }
  const nameError = validateExpertName(pkgName);
  if (nameError) throw new Error(nameError);

  const layerDir = expertsLayerDir(layer, opts);
  const target = path.join(layerDir, pkgName);
  if (layer === 'user' || layer === 'project') {
    // 内置层保护在路由/CLI 入口已拦截；这里防同名覆盖
    const exists = await fs
      .access(target)
      .then(() => true)
      .catch(() => false);
    if (exists && !force) throw new Error(`目标层已存在同名包 ${pkgName}（使用 --force 覆盖）`);
  }

  // 先写临时目录，试解析通过后再就位（坏包不落盘）
  const tmp = `${target}.importing-${Date.now()}`;
  const warnings: string[] = [];
  try {
    for (const [rel, data] of Object.entries(entries)) {
      const safe = safeEntryPath(rel);
      if (!safe) throw new Error(`zip 条目路径越界：${rel}`);
      if (safe.endsWith('/')) continue;
      const dest = path.join(tmp, safe);
      if (!dest.startsWith(tmp + path.sep)) throw new Error(`zip 条目路径越界：${rel}`);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, data);
    }
    // 试解析：声明文件读齐后走同一套 10 步校验链
    const raw = await fs.readFile(path.join(tmp, 'expert.json'), 'utf-8');
    let declared: { agents?: unknown } = {};
    try {
      declared = JSON.parse(raw) as typeof declared;
    } catch {
      // parser 会给出更友好的错误
    }
    const agentFiles = new Map<string, { raw: string; absPath: string }>();
    for (const rel of Array.isArray(declared.agents) ? (declared.agents as string[]) : []) {
      const file = path.basename(rel);
      try {
        agentFiles.set(file, {
          raw: await fs.readFile(path.join(tmp, 'agents', file), 'utf-8'),
          absPath: path.join(tmp, 'agents', file),
        });
      } catch {
        // 缺失 → parser 报「声明的文件不存在」
      }
    }
    parseExpertPackage(
      { dir: tmp, layer: layer as ExpertLayer, name: pkgName, expertJson: raw, agentFiles, avatarPath: null },
      warnings,
    );

    // 就位（同名已被前置检查挡住；force 时先删旧目录）
    if (force) await fs.rm(target, { recursive: true, force: true });
    await fs.rename(tmp, target);
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw e;
  }

  return { name: pkgName, layer, dir: target, warnings };
}

/** 导出为 zip（expert.json 副本写入 exportedAt / exportedBy 元信息，不改源文件） */
export async function exportExpertToBytes(
  name: string,
  opts: { homeDir?: string; projectRoot?: string },
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const store = new ExpertStore({
    ...(opts.projectRoot ? { projectRoot: opts.projectRoot } : {}),
    homeDir: opts.homeDir,
  });
  const record = await store.get(name);
  if (!record) throw new Error(`未找到专家 ${name}`);
  if (record.layer === 'builtin') throw new Error('内置专家不可导出（随程序分发）');

  const zipped: Record<string, Uint8Array> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(record.dir, p).replace(/\\/g, '/');
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) zipped[rel] = new Uint8Array(await fs.readFile(p));
    }
  };
  await walk(record.dir);

  // 元信息写入 expert.json 副本
  try {
    const pkg = JSON.parse(new TextDecoder().decode(zipped['expert.json']!)) as Record<string, unknown>;
    pkg['exportedAt'] = new Date().toISOString();
    pkg['exportedBy'] = 'delta';
    zipped['expert.json'] = strToU8(JSON.stringify(pkg, null, 2));
  } catch {
    // 副本元信息失败不阻塞导出
  }

  return { bytes: zipSync(zipped), fileName: `${record.name}.zip` };
}

export interface ScaffoldOptions {
  name: string;
  displayName: string;
  profession: string;
  expertType: 'agent' | 'team';
  layer: 'user' | 'project';
  description?: string;
  homeDir?: string;
  projectRoot?: string;
}

/** 创建专家骨架（F-39-15）：目录 + expert.json + agents md（团队 = 主理人 + 2 成员） */
export async function scaffoldExpert(opts: ScaffoldOptions): Promise<{ dir: string }> {
  const nameError = validateExpertName(opts.name);
  if (nameError) throw new Error(nameError);

  const layerDir = expertsLayerDir(opts.layer, opts);
  const target = path.join(layerDir, opts.name);
  const exists = await fs
    .access(target)
    .then(() => true)
    .catch(() => false);
  if (exists) throw new Error(`已存在同名包 ${opts.name}（任意层）`);

  const agentBase = `${opts.name}-agent`;
  const agents: Array<{ id: string; zh: string; prof: string }> = [{ id: agentBase, zh: opts.displayName, prof: opts.profession }];
  const members: Array<Record<string, unknown>> = [
    { id: agentBase, name: { en: opts.displayName, zh: opts.displayName }, profession: { en: opts.profession, zh: opts.profession }, role: 'lead' },
  ];
  if (opts.expertType === 'team') {
    for (const [suffix, role] of [
      ['pm', '产品'],
      ['dev', '开发'],
    ] as const) {
      const id = `${opts.name}-${suffix}`;
      agents.push({ id, zh: `${opts.displayName}·${role}`, prof: role });
      members.push({
        id,
        name: { en: role, zh: role },
        profession: { en: role, zh: role },
        role: 'member',
      });
    }
  }

  await fs.mkdir(path.join(target, 'agents'), { recursive: true });
  await fs.writeFile(
    path.join(target, 'expert.json'),
    JSON.stringify(
      {
        name: opts.name,
        version: '0.1.0',
        description: opts.description ?? `${opts.displayName}（待补充描述）`,
        author: { name: process.env.USER ?? 'local' },
        expertType: opts.expertType,
        agentName: agentBase,
        agents: agents.map((a) => `agents/${a.id}.md`),
        displayName: { en: opts.displayName, zh: opts.displayName },
        profession: { en: opts.profession, zh: opts.profession },
        ...(opts.expertType === 'team'
          ? { members, teamInfo: { leadAgent: agentBase, memberAgents: members.map((m) => m['id']) } }
          : {}),
      },
      null,
      2,
    ),
    'utf-8',
  );
  for (const a of agents) {
    const isLead = a.id === agentBase;
    await fs.writeFile(
      path.join(target, 'agents', `${a.id}.md`),
      [
        '---',
        `name: ${a.id}`,
        `description: ${a.id}`,
        `displayName_zh: ${a.zh}`,
        `profession_zh: ${a.prof}`,
        ...(isLead && opts.expertType === 'agent' ? ['tools:', '  - read_file', '  - list_dir'] : []),
        '---',
        '',
        `# ${a.zh}（待补充）`,
        '',
        '在这里写专家的系统提示词：职责边界、输出要求、不做什么。',
      ].join('\n'),
      'utf-8',
    );
  }
  await fs.writeFile(
    path.join(target, 'README.md'),
    `${opts.displayName}（${opts.expertType === 'team' ? '团队' : '单人'}专家骨架）\n编辑 expert.json 与 agents/*.md 后即可在召唤面板使用。\n`,
    'utf-8',
  );
  return { dir: target };
}
