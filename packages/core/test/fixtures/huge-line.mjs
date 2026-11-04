// fixture：一行 2MiB 超限输出 + 一行正常输出（验证截断不丢后续行）
import fs from 'node:fs';
fs.writeSync(1, 'x'.repeat(2 * 1024 * 1024) + '\n');
fs.writeSync(1, 'after-huge\n');
