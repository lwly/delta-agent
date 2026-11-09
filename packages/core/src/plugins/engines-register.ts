/**
 * P2 内置四路引擎登记（单一模块，避免 vitest / 宿主双 Map）。
 */
import { runReAct } from '../engine/react.js';
import { runPlanExecute } from '../engine/plan-execute.js';
import { runMultiAgent } from '../engine/orchestrator.js';
import { runExternalAgent } from '../engine/external.js';
import { registerEngine } from './host.js';

registerEngine('react', runReAct);
registerEngine('plan-execute', runPlanExecute);
registerEngine('multi-agent', runMultiAgent);
registerEngine('external', runExternalAgent);
