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
