import { describe, expect, it } from 'vitest';
import { runReAct } from '../src/engine/react.js';
import { runPlanExecute } from '../src/engine/plan-execute.js';
import { runMultiAgent } from '../src/engine/orchestrator.js';
import { runExternalAgent } from '../src/engine/external.js';
import { registerEngine, registeredEngineIds, resolveEngine } from '../src/plugins/host.js';
import '../src/plugins/builtins.js';

describe('P2 builtin engine plugins', () => {
  it('四路引擎经登记表生效', () => {
    expect(new Set(registeredEngineIds())).toEqual(
      new Set(['react', 'plan-execute', 'multi-agent', 'external']),
    );
  });

  it('mode 命中内置引擎', () => {
    expect(resolveEngine('react')).toBe(runReAct);
    expect(resolveEngine('plan-execute')).toBe(runPlanExecute);
    expect(resolveEngine('multi-agent')).toBe(runMultiAgent);
  });

  it('未知 mode 落 react', () => {
    expect(resolveEngine('nope')).toBe(runReAct);
    expect(resolveEngine('')).toBe(runReAct);
  });

  it('外部模型前缀优先于 mode', () => {
    expect(resolveEngine('plan-execute', 'cli:claude')).toBe(runExternalAgent);
    expect(resolveEngine('react', 'acp:opencode')).toBe(runExternalAgent);
    expect(resolveEngine('plan-execute', 'claude-sonnet')).toBe(runPlanExecute);
  });

  it('重复 id 抛错', () => {
    expect(() => registerEngine('react', runReAct)).toThrow(/already registered: react/);
  });
});
