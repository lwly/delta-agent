import { defineConfig } from 'vitest/config';

export default defineConfig({
  // keep vite-node cache inside the repo: sandboxed/ephemeral TMPDIRs can be
  // cleaned mid-run and break module loading (ENOENT on ssr/<hash>)
  cacheDir: 'node_modules/.vitest',
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Inline the MCP SDK so vite-node transforms it in-process instead of
    // routing through its cross-process ssr file-cache under TMPDIR, which
    // races → random ENOENT on module load.
    // Inline the MCP SDK + load test files sequentially: vite-node's
    // cross-process ssr file-cache races under parallel forks → random
    // ENOENT on module load. Whole suite is <1s, so this costs nothing.
    // Sandbox note: this environment isolates /tmp per process, which breaks
    // vite-node's cross-process ssr file cache (random ENOENT). threads pool
    // keeps module loading inside one process; sequential file loading avoids
    // the same cache racing between threads. Suite is <1s, so no real cost.
    pool: 'threads',
    fileParallelism: false,
    server: {
      deps: {
        inline: [/@modelcontextprotocol/, /@delta/],
      },
    },
  },
});
