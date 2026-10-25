import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { AgentError } from '@delta/shared';
import { ok, fail, type AgentTool } from '../types.js';
import { resolveInSandbox } from '../sandbox.js';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.turbo',
  '__pycache__', '.venv', 'venv', '.next', '.cache',
]);

// ── read_file ──────────────────────────────────────────────────────────────

export const readFileTool: AgentTool = {
  name: 'read_file',
  description: 'Read a text file from the project, optionally by line range (1-based, inclusive).',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'file path relative to project root' },
      offset: { type: 'number', description: 'start line (1-based)' },
      limit: { type: 'number', description: 'max lines to read' },
    },
    required: ['path'],
  },
  danger: 'safe',
  async execute(args, ctx) {
    try {
      const p = await resolveInSandbox(ctx.projectRoot, String(args.path));
      const stat = await fs.stat(p);
      if (stat.isDirectory()) return fail(`${args.path} is a directory`);
      if (stat.size > 2 * 1024 * 1024) return fail('file too large (>2MB)');
      const raw = await fs.readFile(p, 'utf8');
      const lines = raw.split('\n');
      const offset = Math.max(1, Number(args.offset ?? 1));
      const limit = Number(args.limit ?? 400);
      const slice = lines.slice(offset - 1, offset - 1 + limit);
      const body = slice.map((l, i) => `${offset + i}\t${l}`).join('\n');
      return ok(body || '(empty file)');
    } catch (e) {
      return fail(String((e as Error).message));
    }
  },
};

// ── write_file ─────────────────────────────────────────────────────────────

export const writeFileTool: AgentTool = {
  name: 'write_file',
  description: 'Create or overwrite a file inside the project with the given content.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['path', 'content'],
  },
  danger: 'confirm',
  async execute(args, ctx) {
    try {
      const p = await resolveInSandbox(ctx.projectRoot, String(args.path));
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, String(args.content), 'utf8');
      return ok(`wrote ${args.path} (${String(args.content).length} chars)`);
    } catch (e) {
      return fail(String((e as Error).message));
    }
  },
};

// ── edit_file ──────────────────────────────────────────────────────────────

export const editFileTool: AgentTool = {
  name: 'edit_file',
  description: 'Replace an exact string occurrence in a file. old_string must match uniquely.',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  danger: 'confirm',
  async execute(args, ctx) {
    try {
      const p = await resolveInSandbox(ctx.projectRoot, String(args.path));
      const raw = await fs.readFile(p, 'utf8');
      const oldStr = String(args.old_string);
      const count = raw.split(oldStr).length - 1;
      if (count === 0) return fail('old_string not found in file');
      if (count > 1) return fail(`old_string matches ${count} times; provide a longer unique string`);
      const next = raw.replace(oldStr, String(args.new_string));
      await fs.writeFile(p, next, 'utf8');
      return ok(`edited ${args.path}`);
    } catch (e) {
      return fail(String((e as Error).message));
    }
  },
};

// ── list_dir ───────────────────────────────────────────────────────────────

export const listDirTool: AgentTool = {
  name: 'list_dir',
  description: 'List a directory tree up to the given depth (default 2).',
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'directory relative to project root (default ".")' },
      depth: { type: 'number' },
    },
  },
  danger: 'safe',
  async execute(args, ctx) {
    const root = await resolveInSandbox(ctx.projectRoot, String(args.path ?? '.'));
    const depth = Math.min(6, Math.max(1, Number(args.depth ?? 2)));
    const lines: string[] = [];
    const walk = async (dir: string, prefix: string, d: number): Promise<void> => {
      if (d > depth || lines.length > 600) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
        if (e.name === '.' || e.name === '..') continue;
        if (e.isDirectory() && IGNORED_DIRS.has(e.name)) {
          lines.push(`${prefix}${e.name}/`);
          continue;
        }
        if (e.isDirectory()) {
          lines.push(`${prefix}${e.name}/`);
          await walk(path.join(dir, e.name), prefix + '  ', d + 1);
        } else {
          lines.push(`${prefix}${e.name}`);
        }
      }
    };
    try {
      await walk(root, '', 1);
      return ok(lines.join('\n') || '(empty directory)');
    } catch (e) {
      return fail(String((e as Error).message));
    }
  },
};

// ── glob_search ────────────────────────────────────────────────────────────

/** Minimal glob: ** / * / ? via regex translation. */
function globToRegex(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i++;
        if (pattern[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const globSearchTool: AgentTool = {
  name: 'glob_search',
  description: 'Find files matching a glob pattern (supports ** and *), rooted at project root.',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'e.g. "src/**/*.ts"' },
      path: { type: 'string', description: 'root for the search (default ".")' },
    },
    required: ['pattern'],
  },
  danger: 'safe',
  async execute(args, ctx) {
    const base = await resolveInSandbox(ctx.projectRoot, String(args.path ?? '.'));
    const re = globToRegex(String(args.pattern));
    const results: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      if (results.length >= 300) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && IGNORED_DIRS.has(e.name)) continue;
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (re.test(relPath)) results.push(relPath);
        if (e.isDirectory()) await walk(path.join(dir, e.name), relPath);
      }
    };
    try {
      await walk(base, '');
      return ok(results.length ? results.join('\n') : '(no matches)');
    } catch (e) {
      return fail(String((e as Error).message));
    }
  },
};

// ── grep_search ────────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 512 * 1024;
const TEXT_EXT_SKIP = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip',
  '.gz', '.tar', '.mp4', '.mp3', '.woff', '.woff2', '.ttf', '.eot',
]);

export const grepSearchTool: AgentTool = {
  name: 'grep_search',
  description: 'Search file contents with a JavaScript regular expression. Returns "path:line: text" matches.',
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'root for the search (default ".")' },
      glob: { type: 'string', description: 'optional filename glob filter, e.g. "*.ts"' },
    },
    required: ['pattern'],
  },
  danger: 'safe',
  async execute(args, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(String(args.pattern));
    } catch (e) {
      return fail(`invalid regex: ${(e as Error).message}`);
    }
    const fileRe = args.glob ? globToRegex(String(args.glob)) : undefined;
    const base = await resolveInSandbox(ctx.projectRoot, String(args.path ?? '.'));
    const out: string[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      if (out.length >= 200) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (out.length >= 200) return;
        if (e.isDirectory()) {
          if (IGNORED_DIRS.has(e.name)) continue;
          await walk(path.join(dir, e.name), rel ? `${rel}/${e.name}` : e.name);
          continue;
        }
        const relPath = rel ? `${rel}/${e.name}` : e.name;
        if (fileRe && !fileRe.test(e.name)) continue;
        if (TEXT_EXT_SKIP.has(path.extname(e.name))) continue;
        try {
          const stat = await fs.stat(path.join(dir, e.name));
          if (stat.size > MAX_FILE_BYTES) continue;
          const buf = await fs.readFile(path.join(dir, e.name), 'utf8');
          const lines = buf.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i]!)) {
              out.push(`${relPath}:${i + 1}: ${lines[i]!.slice(0, 300)}`);
              if (out.length >= 200) break;
            }
          }
        } catch {
          /* unreadable file — skip */
        }
      }
    };
    try {
      await walk(base, '');
      return ok(out.length ? out.join('\n') : '(no matches)');
    } catch (e) {
      return fail(String((e as Error).message));
    }
  },
};
