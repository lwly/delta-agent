/** WorkBuddy 等注入的 NODE_OPTIONS shim 会导致 vitest SIGSEGV（见 design-f31 §9） */
delete process.env.NODE_OPTIONS;

import '../src/plugins/builtins.js';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const req = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../package.json'));

/** better-sqlite3 原生绑定与当前 Node ABI 一致时为 true */
export const sqliteNativeOk = (() => {
  try {
    const Database = req('better-sqlite3') as new (p: string) => { close(): void };
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
})();
