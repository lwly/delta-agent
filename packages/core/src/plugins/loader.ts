/**
 * P6 用户插件目录。发现 + 信任清单 + activate 六槽（见 plugin-chain.test）。
 * 未信任不 import。单个插件抛错记入 error，不中断其余插件。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { invokePluginActivate, type PluginHost } from './activate.js';

export type PluginLayer = 'user' | 'project';
export type PluginStatus = 'loaded' | 'untrusted' | 'content' | 'error';

export interface LoadedPlugin {
  id: string;
  dir: string;
  layer: PluginLayer;
  status: PluginStatus;
  error?: string;
}

export interface LoadPluginsOptions {
  userDir?: string;
  projectDir?: string;
  trustFile: string;
}

export async function loadPlugins(
  opts: LoadPluginsOptions,
  activation?: { host: PluginHost },
): Promise<LoadedPlugin[]> {
  const trusted = await readTrusted(opts.trustFile);
  const found = [
    ...(await scan(opts.userDir, 'user')),
    ...(await scan(opts.projectDir, 'project')),
  ];
  const byId = new Map<string, Found>();
  const duplicates: LoadedPlugin[] = [];
  for (const item of found) {
    if (item.layer === 'user' && byId.has(item.id)) {
      duplicates.push({ id: item.id, dir: item.dir, layer: item.layer, status: 'error', error: `plugin id 重复: ${item.id}` });
      continue;
    }
    if (item.layer === 'project' && byId.has(item.id) && byId.get(item.id)!.layer === 'project') {
      duplicates.push({ id: item.id, dir: item.dir, layer: item.layer, status: 'error', error: `plugin id 重复: ${item.id}` });
      continue;
    }
    byId.set(item.id, item);
  }

  const loaded: LoadedPlugin[] = [];
  for (const item of byId.values()) {
    if (item.error) {
      loaded.push({ id: item.id, dir: item.dir, layer: item.layer, status: 'error', error: item.error });
      continue;
    }
    if (!item.main) {
      loaded.push({ id: item.id, dir: item.dir, layer: item.layer, status: 'content' });
      continue;
    }
    if (!trusted.has(item.id)) {
      loaded.push({ id: item.id, dir: item.dir, layer: item.layer, status: 'untrusted' });
      continue;
    }
    try {
      const mainHref = pathToFileURL(item.main).href;
      if (activation?.host) await invokePluginActivate(mainHref, activation.host);
      else await import(mainHref);
      loaded.push({ id: item.id, dir: item.dir, layer: item.layer, status: 'loaded' });
    } catch (e) {
      loaded.push({
        id: item.id,
        dir: item.dir,
        layer: item.layer,
        status: 'error',
        error: (e as Error).message,
      });
    }
  }
  return [...loaded, ...duplicates];
}

interface Found {
  id: string;
  dir: string;
  layer: PluginLayer;
  main?: string;
  error?: string;
}

async function scan(dir: string | undefined, layer: PluginLayer): Promise<Found[]> {
  if (!dir) return [];
  let names: string[];
  try {
    names = (await fs.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const out: Found[] = [];
  for (const name of names) {
    const pluginDir = path.join(dir, name);
    out.push(await readManifest(pluginDir, layer));
  }
  return out;
}

async function readManifest(dir: string, layer: PluginLayer): Promise<Found> {
  const file = path.join(dir, 'delta.plugin.json');
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { id?: unknown; main?: unknown };
    if (typeof raw.id !== 'string' || raw.id === '' || raw.id.includes('/') || raw.id.includes('..')) {
      return { id: path.basename(dir), dir, layer, error: 'manifest id 无效' };
    }
    if (raw.main == null || raw.main === '') return { id: raw.id, dir, layer };
    if (typeof raw.main !== 'string') return { id: raw.id, dir, layer, error: 'manifest main 无效' };
    const main = path.resolve(dir, raw.main);
    const rel = path.relative(dir, main);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { id: raw.id, dir, layer, error: 'main 超出插件目录' };
    return { id: raw.id, dir, layer, main };
  } catch (e) {
    return { id: path.basename(dir), dir, layer, error: (e as Error).message };
  }
}

async function readTrusted(file: string): Promise<Set<string>> {
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as { trusted?: unknown };
    const list = Array.isArray(raw.trusted) ? raw.trusted.filter((x): x is string => typeof x === 'string') : [];
    return new Set(list);
  } catch {
    return new Set();
  }
}
