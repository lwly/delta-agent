/**
 * P2：hub / headless 壳层用的引擎契约（类型与 mode 分段），不 import 引擎实现。
 */
export type { RunContext, PlanOptions } from '../engine/react.js';
export { modeSegment, type EngineMode } from '../engine/mode-prompt.js';
