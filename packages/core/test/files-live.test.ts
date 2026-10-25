/**
 * F-38 真实仓库验证（人工证据用，默认跳过）
 *
 * 为什么单独一份：本机 `git init` 被安全守卫拦截（无法 unlink `.git/HEAD.lock`），
 * 所有「临时 git 仓库」类用例都跑不了。唯一能证明 git 逻辑（show-prefix 剥前缀、
 * numstat 合并、unified diff 行号）正确的是**真实仓库**。
 *
 * 运行方式：
 *   YZ_LIVE_REPO=/path/to/repo yarn/npx vitest run test/files-live.test.ts
 *   （可选 YZ_LIVE_SUBDIR=packages/core 指定子目录作为根，默认 packages/core）
 *
 * 默认 `describe.skipIf(!REPO)` → CI 无该环境变量时整组跳过，不污染回归。
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { listWorkspaceChanges, readFileDiff } from '../src/files/changes.js';
import { handleBrowseRoute, type BrowseRouteOutcome } from '../src/server/browse-routes.js';
import type { SessionService } from '../src/session/service.js';
import type { ProjectRow } from '../src/session/store.js';

const REPO = process.env.YZ_LIVE_REPO ?? '';
const SUBDIR = process.env.YZ_LIVE_SUBDIR ?? 'packages/core';
/** 本次改动文件（工程师未提交改动，必然出现在 status 中） */
const CHANGED_FILE = 'packages/web/src/views/WorkbenchView.vue';
/** 本次改动且增删都非空的文件（用于 diff 行号断言） */
const DIFF_FILE = 'packages/core/src/server/http.ts';

describe.skipIf(!REPO || !existsSync(REPO))('C 真实仓库：git 变更统计与 diff', () => {
  it('C1 listWorkspaceChanges(仓库根) → is_repo:true，含本次改动文件，totals 为各行之和', async () => {
    const result = await listWorkspaceChanges(REPO);

    expect(result.is_repo).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.total_files).toBeGreaterThanOrEqual(result.files.length);

    const target = result.files.find((f) => f.path === CHANGED_FILE);
    expect(target, `未在变更清单里找到 ${CHANGED_FILE}`).toBeDefined();
    expect(target!.added).toBeGreaterThan(0);
    expect(target!.status).toBe('modified');

    // totals = 全量合计；未截断时必须等于各行之和
    if (!result.truncated) {
      const sum = result.files.reduce(
        (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
        { added: 0, removed: 0 },
      );
      expect(result.totals).toEqual(sum);
    } else {
      const sumAdded = result.files.reduce((a, f) => a + f.added, 0);
      expect(result.totals.added).toBeGreaterThanOrEqual(sumAdded);
    }

    // 清单里不应出现任何绝对路径（PRD §6）
    for (const f of result.files) {
      expect(path.isAbsolute(f.path)).toBe(false);
      expect(f.path).not.toContain('\\');
    }
  });

  it(`C2 子目录作为根（${SUBDIR}）→ 路径已剥前缀，不含兄弟包`, async () => {
    const subRoot = path.join(REPO, SUBDIR);
    const result = await listWorkspaceChanges(subRoot);

    expect(result.is_repo).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.files.length).toBeGreaterThan(0);

    const prefix = `${SUBDIR}/`;
    for (const f of result.files) {
      // 剥前缀生效：不应残留仓库根相对的 packages/core/ 前缀
      expect(f.path.startsWith(prefix), `未剥前缀: ${f.path}`).toBe(false);
      // 根外改动必须被丢弃
      expect(f.path.startsWith('packages/web/'), `根外改动泄漏: ${f.path}`).toBe(false);
      expect(f.path.startsWith('packages/'), `根外改动泄漏: ${f.path}`).toBe(false);
    }

    // 本次改动都在 packages/core 下，必须能找到（证明不是空集）
    expect(result.files.some((f) => f.path === 'src/server/http.ts')).toBe(true);
    // 反证：在仓库根口径下同一个文件是带前缀的
    const fromRoot = await listWorkspaceChanges(REPO);
    expect(fromRoot.files.some((f) => f.path === 'packages/core/src/server/http.ts')).toBe(true);
  });

  it(`C3 readFileDiff（${DIFF_FILE}）→ rows 含 hunk/add/del，行号非空且连续`, async () => {
    const diff = await readFileDiff(REPO, DIFF_FILE);

    expect(diff.ok).toBe(true);
    expect(diff.status).toBe('modified');
    expect(diff.binary).toBe(false);
    expect(diff.added).toBeGreaterThan(0);
    expect(diff.removed).toBeGreaterThan(0);
    expect(diff.rows.length).toBeGreaterThan(0);

    const hunks = diff.rows.filter((r) => r.type === 'hunk');
    const adds = diff.rows.filter((r) => r.type === 'add');
    const dels = diff.rows.filter((r) => r.type === 'del');
    const ctxs = diff.rows.filter((r) => r.type === 'ctx');

    expect(hunks.length).toBeGreaterThan(0);
    expect(adds.length).toBeGreaterThan(0);
    expect(dels.length).toBeGreaterThan(0);
    expect(hunks[0]!.text).toMatch(/^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/);

    // hunk 行不带行号；add 只有 new_no；del 只有 old_no；ctx 两者都有
    for (const r of hunks) {
      expect(r.old_no).toBeNull();
      expect(r.new_no).toBeNull();
    }
    for (const r of adds) {
      expect(r.old_no).toBeNull();
      expect(typeof r.new_no).toBe('number');
    }
    for (const r of dels) {
      expect(typeof r.old_no).toBe('number');
      expect(r.new_no).toBeNull();
    }
    for (const r of ctxs) {
      expect(typeof r.old_no).toBe('number');
      expect(typeof r.new_no).toBe('number');
    }

    // 第一个 hunk 内：old_no / new_no 各自连续递增（1,2,3…，允许起点非 1）
    const firstHunkEnd = diff.rows.findIndex((r, i) => i > 0 && r.type === 'hunk');
    const block = diff.rows.slice(
      0,
      firstHunkEnd === -1 ? diff.rows.length : firstHunkEnd,
    );
    const oldSeq = block.map((r) => r.old_no).filter((n): n is number => n !== null);
    const newSeq = block.map((r) => r.new_no).filter((n): n is number => n !== null);
    for (let i = 1; i < oldSeq.length; i += 1) expect(oldSeq[i]).toBe(oldSeq[i - 1]! + 1);
    for (let i = 1; i < newSeq.length; i += 1) expect(newSeq[i]).toBe(newSeq[i - 1]! + 1);

    // added/removed 与 rows 内的行数一致（未截断时）
    if (!diff.truncated) {
      expect(diff.added).toBe(adds.length);
      expect(diff.removed).toBe(dels.length);
    }
  });

  it('C5 路由层：project 作用域 changes/diff 直连真实仓库 → 200 + 真实 rows（HTTP 契约闭环）', async () => {
    const project: ProjectRow = {
      id: 'live-proj',
      name: path.basename(REPO),
      root_path: REPO,
      created_at: '2026-10-24T00:00:00.000Z',
      session_count: 0,
    };
    const service = {
      getSession: () => null,
      getProject: (id: string) => (id === project.id ? project : null),
    } as unknown as SessionService;

    const callRoute = (action: string, query: Record<string, string> = {}) => {
      const parts = ['api', 'projects', project.id, 'browse', action];
      const search = new URLSearchParams(query).toString();
      return handleBrowseRoute({
        method: 'GET',
        parts,
        url: new URL(`http://localhost/${parts.join('/')}${search ? `?${search}` : ''}`),
        req: Readable.from([]) as never,
        service,
        browseDeps: {},
      });
    };

    const changes = (await callRoute('changes')) as BrowseRouteOutcome;
    expect(changes.status).toBe(200);
    const changesBody = changes.body as { is_repo: boolean; files: Array<{ path: string }>; root_name: string };
    expect(changesBody.is_repo).toBe(true);
    expect(changesBody.root_name).toBe(path.basename(REPO));
    expect(changesBody.files.some((f) => f.path === CHANGED_FILE)).toBe(true);

    const diff = (await callRoute('diff', { path: DIFF_FILE })) as BrowseRouteOutcome;
    expect(diff.status).toBe(200);
    const diffBody = diff.body as {
      ok: boolean;
      rows: Array<{ type: string; old_no: number | null; new_no: number | null }>;
      added: number;
      removed: number;
    };
    expect(diffBody.ok).toBe(true);
    expect(diffBody.added).toBeGreaterThan(0);
    expect(diffBody.removed).toBeGreaterThan(0);
    const addRows = diffBody.rows.filter((r) => r.type === 'add');
    const delRows = diffBody.rows.filter((r) => r.type === 'del');
    expect(addRows.length).toBeGreaterThan(0);
    expect(delRows.length).toBeGreaterThan(0);
    expect(addRows.every((r) => r.new_no !== null && r.old_no === null)).toBe(true);
    expect(delRows.every((r) => r.old_no !== null && r.new_no === null)).toBe(true);
  });

  it('C4 改名记录：若真实仓库存在则校验 orig_path，否则注明跳过', async () => {    const result = await listWorkspaceChanges(REPO);
    const renamed = result.files.filter((f) => f.status === 'renamed');
    if (renamed.length === 0) {
      // 真实仓库当前没有改名改动 → 此项无现场证据，明确标注（不算通过也不算失败）
      console.warn('[C4] 真实仓库当前无 renamed 改动，orig_path 语义未取得现场证据（跳过）');
      expect(renamed).toEqual([]);
      return;
    }
    for (const f of renamed) {
      expect(f.path.startsWith('packages/')).toBe(true);
      expect(f.orig_path).toBeTypeOf('string');
      expect(f.orig_path).not.toBe(f.path);
      // 改名按**新路径**归并：其它条目不重复出现旧路径
      expect(result.files.some((o) => o !== f && o.path === f.orig_path)).toBe(false);
    }
  });
});
