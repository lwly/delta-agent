<script setup lang="ts">
import { useRouter } from 'vue-router';

const router = useRouter();
const nav = [
  { path: '/projects', label: '项目与对话' },
  { path: '/settings', label: '设置中心' },
  { path: '/memory', label: '记忆面板' },
];</script>

<template>
  <div class="app">
    <header class="nav">
      <span class="brand">yzero 控制台</span>
      <nav>
        <button
          v-for="n in nav"
          :key="n.path"
          :class="{ active: router.currentRoute.value.path.startsWith(n.path) }"
          @click="router.push(n.path)"
        >
          {{ n.label }}
        </button>
      </nav>
    </header>
    <main class="main">
      <router-view />
    </main>
  </div>
</template>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, 'PingFang SC', sans-serif; color: #1f2328; background: #f6f8fa; }
.app { display: flex; flex-direction: column; height: 100vh; }
.nav {
  display: flex; align-items: center; gap: 16px; padding: 8px 20px;
  background: #24292f; color: #fff;
}
.nav .brand { font-weight: 600; margin-right: 12px; }
.nav button {
  background: transparent; color: #c9d1d9; border: none; padding: 6px 12px;
  border-radius: 6px; cursor: pointer; font-size: 14px;
}
.nav button.active, .nav button:hover { background: #30363d; color: #fff; }
.main { flex: 1; overflow: auto; padding: 20px; }
button { font-family: inherit; }
</style>
