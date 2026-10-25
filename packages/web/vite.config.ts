import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 纯本地部署形态（2026-10-22 决议）：
// - dev：vite dev server，/api 代理到 `delta serve`（127.0.0.1:7900）
// - build：产物输出 dist/，由 `delta serve` 内嵌托管（SPA fallback index.html）
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 7901,
    proxy: {
      '/api': { target: 'http://127.0.0.1:7900', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
