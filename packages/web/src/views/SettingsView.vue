<script setup lang="ts">
// 设置页：记忆 / 模型配置 / 用量 三大块从侧边栏弹窗迁移而来
// 左侧为设置导航（复用工作台 .nav-item 视觉风格），右侧为内容面板；
// 当前 tab 记在路由 query（/settings?tab=memory），刷新后保持。
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import MemoryPanel from '../components/settings/MemoryPanel.vue';
import ProvidersPanel from '../components/settings/ProvidersPanel.vue';
import UsagePanel from '../components/settings/UsagePanel.vue';
import SkillsPanel from '../components/settings/SkillsPanel.vue';
import SkillHubPanel from '../components/settings/SkillHubPanel.vue';
import McpPanel from '../components/settings/McpPanel.vue';
import ExpertsPanel from '../components/settings/ExpertsPanel.vue';
import ToolsPanel from '../components/settings/ToolsPanel.vue';

const route = useRoute();
const router = useRouter();

/** 设置分区枚举：key 为路由 query.tab 值 */
const SECTIONS = [
  { key: 'memory', ico: '🧠', label: '记忆' },
  { key: 'providers', ico: '⚙️', label: '配置' },
  { key: 'skills', ico: '🧩', label: 'Skills' },
  { key: 'hub', ico: '🛒', label: 'Skill Hub' },
  { key: 'mcp', ico: '🔌', label: 'MCP' },
  { key: 'tools', ico: '🛠️', label: '功能' },
  { key: 'experts', ico: '🧑‍💼', label: '专家' },
  { key: 'usage', ico: '📊', label: '用量' },
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

/** 当前选中分区（query.tab 非法值回退为 memory） */
const activeTab = computed<SectionKey>(() => {
  const t = route.query.tab;
  if (typeof t === 'string' && SECTIONS.some((s) => s.key === t)) return t as SectionKey;
  return 'memory';
});

/** 切换分区：写回路由 query（replace 避免设置页内部切换堆积历史记录） */
function switchTab(key: SectionKey) {
  void router.replace({ path: '/settings', query: { tab: key } });
}

// activeTab 为 computed，直接依赖 route.query.tab，路由变化（含 /memory /usage 重定向）自动生效
</script>

<template>
  <div class="settings">
    <!-- 顶栏：返回工作台 + 标题 -->
    <header class="head">
      <router-link class="back" to="/">← 返回工作台</router-link>
      <h1 class="title">设置</h1>
    </header>

    <div class="body">
      <!-- 左侧设置导航 -->
      <nav class="side-nav">
        <button
          v-for="s in SECTIONS"
          :key="s.key"
          class="nav-item"
          :class="{ on: activeTab === s.key }"
          @click="switchTab(s.key)"
        >
          <span class="ni-ico">{{ s.ico }}</span>{{ s.label }}
        </button>
      </nav>

      <!-- 右侧内容区：面板自身滚动 -->
      <main class="content">
        <MemoryPanel v-if="activeTab === 'memory'" />
        <ProvidersPanel v-else-if="activeTab === 'providers'" />
        <SkillsPanel v-else-if="activeTab === 'skills'" />
        <SkillHubPanel v-else-if="activeTab === 'hub'" />
        <McpPanel v-else-if="activeTab === 'mcp'" />
        <ToolsPanel v-else-if="activeTab === 'tools'" />
        <ExpertsPanel v-else-if="activeTab === 'experts'" />
        <UsagePanel v-else-if="activeTab === 'usage'" />
      </main>
    </div>
  </div>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; height: 100vh; }

/* 顶栏 */
.head {
  display: flex; align-items: center; gap: 14px;
  padding: 12px 20px; border-bottom: 1px solid var(--border); background: var(--bg-panel);
}
.back {
  padding: 6px 12px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--bg-elevated); color: var(--text-dim); font-size: 12.5px;
  text-decoration: none; transition: all 0.12s;
}
.back:hover { background: var(--bg-hover); color: var(--text); }
.title { font-size: 15px; font-weight: 600; }

/* 左右布局主体 */
.body { flex: 1; display: flex; min-height: 0; }

/* 左侧设置导航（视觉对齐 WorkbenchView 侧栏 .nav-item） */
.side-nav {
  width: 220px; min-width: 220px;
  padding: 12px 10px; border-right: 1px solid var(--border);
  background: var(--bg-panel);
  display: flex; flex-direction: column; gap: 2px;
}
.nav-item {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 8px 12px; border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--text-dim); font-size: 13px;
  cursor: pointer; text-align: left;
  transition: background 0.12s, color 0.12s;
}
.nav-item:hover { background: var(--bg-hover); color: var(--text); }
.nav-item.on {
  background: var(--accent-soft); border-color: rgba(88, 166, 255, 0.35);
  color: var(--accent); font-weight: 600;
}
.ni-ico { width: 20px; flex: none; text-align: center; font-size: 14px; }

/* 右侧内容区：宽度自适应，滚动发生在内容区（原弹窗 body 的 overflow-y:auto 职责转移至此） */
.content {
  flex: 1; min-width: 0; overflow-y: auto;
  padding: 18px 24px 28px;
}
</style>
