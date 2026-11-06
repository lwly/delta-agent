/**
 * F-58 Router–Worker 调度层（packages/core/src/router/）。
 * 本目录与 engine/、external/ 平级，互不 import server/（依赖方向红线，设计稿 §12）。
 */
export * from './types.js';
export * from './store.js';
export * from './prompt.js';
export * from './dispatcher.js';
export * from './preflight.js';
export * from './watchdog.js';
