import { describe, expect, it, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import type { LLMProvider, StreamEvent } from '@y-zero/shared';
import {
  scanProjectLayout,
  runOnboardingScan,
  autoOnboardProject,
  confirmOnboarding,
  skipOnboarding,
  loadOnboardingState,
  saveOnboardingState,
  shouldAutoOnboard,
  agentMdDraftPath,
  memoryMdDraftPath,
  agentMdTargetPath,
  memoryMdTargetPath,
} from '../src/onboarding/index.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'yz-onboard-'));
});

/** 伪 provider：只回一条 text_delta（仿 memory.test.ts 的 mock 模式） */
function fakeProvider(reply: string): LLMProvider {
  return {
    id: 'fake',
    estimateTokens: () => 0,
    async *chat(): AsyncIterable<StreamEvent> {
      yield { type: 'text_delta', text: reply };
    },
  };
}

const GOOD_REPLY = `===SUMMARY===
一个 pnpm monorepo 的 CLI 工具
===AGENT_MD===
## 项目摘要

一个 pnpm monorepo 的 CLI 工具

## 目录结构

- src/

## 工作约定

- （待确认）
===MEMORY_MD===
- 技术栈：TypeScript + Node >= 20
- 包管理：pnpm`;

describe('scanProjectLayout', () => {
  it('collects tree / manifests / readme and skips noise dirs', () => {
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n');
    fs.writeFileSync(path.join(root, 'node_modules', 'foo', 'x.js'), '');
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo","scripts":{"test":"vitest"}}');
    fs.writeFileSync(path.join(root, 'README.md'), '# Demo\n\n示例项目');

    const scan = scanProjectLayout(root);
    expect(scan.tree).toContain('src/');
    expect(scan.tree).toContain('index.ts');
    expect(scan.tree).toContain('package.json');
    expect(scan.tree).not.toContain('node_modules');
    expect(scan.readme).toContain('# Demo');
    expect(scan.manifests.map((m) => m.name)).toEqual(['package.json']);
    expect(scan.text).toContain('<project_root>');
    expect(scan.text).toContain('<directory_tree');
    expect(scan.text).toContain('<manifest name="package.json">');
  });

  it('returns empty tree for missing dir', () => {
    const scan = scanProjectLayout(path.join(root, 'nope'));
    expect(scan.tree).toBe('');
  });
});

describe('runOnboardingScan', () => {
  it('writes drafts and updates state to draft', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo"}');
    const r = await runOnboardingScan({
      projectRoot: root,
      provider: fakeProvider(GOOD_REPLY),
      model: 'fake-model',
    });
    expect(r.skipped).toBe(false);
    expect(r.summary).toContain('pnpm monorepo');
    expect(fs.readFileSync(agentMdDraftPath(root), 'utf8')).toContain('## 项目摘要');
    expect(fs.readFileSync(memoryMdDraftPath(root), 'utf8')).toContain('- 技术栈');
    const state = loadOnboardingState(root);
    expect(state.status).toBe('draft');
    expect(state.model).toBe('fake-model');
  });

  it('falls back to fenced json when markers missing', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo"}');
    const fenced = '```json\n' + JSON.stringify({
      summary: '一个 pnpm monorepo 的 CLI 工具',
      agentMd: '## 项目摘要',
      memoryMd: '- 技术栈：TypeScript',
    }) + '\n```';
    const r = await runOnboardingScan({ projectRoot: root, provider: fakeProvider(fenced), model: 'm' });
    expect(r.skipped).toBe(false);
    expect(r.summary).toContain('pnpm monorepo');
  });

  it('skips when status is not pending unless forced', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo"}');
    saveOnboardingState(root, { status: 'confirmed' });
    const r1 = await runOnboardingScan({
      projectRoot: root,
      provider: fakeProvider(GOOD_REPLY),
      model: 'm',
    });
    expect(r1.skipped).toBe(true);
    const r2 = await runOnboardingScan({
      projectRoot: root,
      provider: fakeProvider(GOOD_REPLY),
      model: 'm',
      force: true,
    });
    expect(r2.skipped).toBe(false);
  });

  it('skips empty directory', async () => {
    const r = await runOnboardingScan({ projectRoot: root, provider: fakeProvider(GOOD_REPLY), model: 'm' });
    expect(r.skipped).toBe(true);
    expect(loadOnboardingState(root).status).toBe('pending'); // 状态不变
  });

  it('keeps state pending when llm output is unparsable', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo"}');
    await expect(
      runOnboardingScan({ projectRoot: root, provider: fakeProvider('不是 JSON'), model: 'm' }),
    ).rejects.toThrow();
    expect(loadOnboardingState(root).status).toBe('pending');
  });
});

describe('confirmOnboarding', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(root, '.y-zero'), { recursive: true });
    fs.writeFileSync(agentMdDraftPath(root), 'draft-agent\n');
    fs.writeFileSync(memoryMdDraftPath(root), 'draft-memory\n');
    saveOnboardingState(root, { status: 'draft' });
  });

  it('renames drafts into place and marks confirmed', () => {
    const r = confirmOnboarding(root);
    expect(r.applied).toEqual([agentMdTargetPath(root), memoryMdTargetPath(root)]);
    expect(fs.readFileSync(agentMdTargetPath(root), 'utf8')).toBe('draft-agent\n');
    expect(fs.readFileSync(memoryMdTargetPath(root), 'utf8')).toBe('draft-memory\n');
    expect(fs.existsSync(agentMdDraftPath(root))).toBe(false);
    expect(loadOnboardingState(root).status).toBe('confirmed');
  });

  it('never overwrites existing targets (manual merge required)', () => {
    fs.writeFileSync(agentMdTargetPath(root), 'user-maintained\n');
    const r = confirmOnboarding(root);
    expect(r.applied).toEqual([memoryMdTargetPath(root)]);
    expect(r.skipped).toEqual([{ draft: agentMdDraftPath(root), target: agentMdTargetPath(root) }]);
    expect(fs.readFileSync(agentMdTargetPath(root), 'utf8')).toBe('user-maintained\n');
    expect(fs.existsSync(agentMdDraftPath(root))).toBe(true); // 草案保留待手工合并
  });
});

describe('skipOnboarding / auto', () => {
  it('skip marks skipped and disables auto trigger', async () => {
    skipOnboarding(root);
    expect(loadOnboardingState(root).status).toBe('skipped');
    expect(shouldAutoOnboard(root)).toBe(false);
    const r = await autoOnboardProject({ projectRoot: root, provider: fakeProvider(GOOD_REPLY), model: 'm' });
    expect(r).toBeUndefined();
  });

  it('auto:false in state blocks auto trigger', async () => {
    saveOnboardingState(root, { status: 'pending', auto: false });
    expect(shouldAutoOnboard(root)).toBe(false);
    const r = await autoOnboardProject({ projectRoot: root, provider: fakeProvider(GOOD_REPLY), model: 'm' });
    expect(r).toBeUndefined();
  });

  it('auto runs when pending (auto defaults on)', async () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"demo"}');
    expect(shouldAutoOnboard(root)).toBe(true);
    const r = await autoOnboardProject({ projectRoot: root, provider: fakeProvider(GOOD_REPLY), model: 'm' });
    expect(r && !r.skipped).toBe(true);
  });

  it('bad state json degrades to pending (never throws)', () => {
    fs.mkdirSync(path.join(root, '.y-zero'), { recursive: true });
    fs.writeFileSync(path.join(root, '.y-zero', 'onboarding.json'), '{broken');
    expect(loadOnboardingState(root).status).toBe('pending');
    expect(shouldAutoOnboard(root)).toBe(true);
  });
});
