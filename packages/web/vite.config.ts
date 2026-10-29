import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

// 纯本地部署形态（2026-10-22 决议）：
// - dev：vite dev server，/api 代理到 `delta serve`（127.0.0.1:7900）
// - build：产物输出 dist/，由 `delta serve` 内嵌托管（SPA fallback index.html）

/**
 * F-53（AC-53-5）静态资源预压缩：构建期对 ≥1KB 的文本类产物生成 .gz 副本（gzip -9）。
 * `delta serve` 静态托管按 Accept-Encoding 优先回 .gz，无 .gz 回退原文件——
 * 压缩只在构建期做一次，运行时零开销。不引入第三方依赖（node:zlib 直用）。
 */
function precompressAssets(): Plugin {
  const TEXT_EXTS = new Set(['.html', '.js', '.css', '.json', '.svg', '.txt', '.map']);
  const MIN_BYTES = 1024; // 更小的文件压缩收益低于一条 TCP 帧的噪声
  return {
    name: 'f53-precompress-assets',
    apply: 'build',
    async closeBundle() {
      const dist = path.resolve(__dirname, 'dist');
      let count = 0;
      let saved = 0;
      const walk = async (dir: string): Promise<string[]> => {
        const out: string[] = [];
        for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) out.push(...(await walk(p)));
          else if (e.isFile()) out.push(p);
        }
        return out;
      };
      for (const file of await walk(dist)) {
        if (!TEXT_EXTS.has(path.extname(file)) || file.endsWith('.gz')) continue;
        const raw = await fsp.readFile(file);
        if (raw.length < MIN_BYTES) continue;
        const gz = await new Promise<Buffer>((resolve, reject) =>
          zlib.gzip(raw, { level: 9 }, (err, buf) => (err ? reject(err) : resolve(buf))),
        );
        if (gz.length >= raw.length) continue; // 压了不省就跳过
        await fsp.writeFile(`${file}.gz`, gz);
        count += 1;
        saved += raw.length - gz.length;
      }
      // eslint-disable-next-line no-console
      console.log(`[f53-precompress] ${count} 个文件预压缩完成，共节省 ${saved} 字节`);
    },
  };
}

export default defineConfig({
  plugins: [vue(), precompressAssets()],
  server: {
    port: 7901,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7900', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // F-53（AC-53-5）：路由级 splitting 早已到位（router.ts 全 dynamic import），
        // 这里把重依赖再切共享 chunk：markdown/highlight 只被消息流用到，
        // vendor（vue 全家桶）独立缓存，业务代码改动不使其缓存失效
        manualChunks: {
          vendor: ['vue', 'vue-router', 'pinia'],
          markdown: ['markdown-it', 'highlight.js'],
        },
      },
    },
  },
});
