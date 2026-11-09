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
import MarketPanel from '../components/settings/MarketPanel.vue';
import McpPanel from '../components/settings/McpPanel.vue';
import ExternalAgentsPanel from '../components/settings/ExternalAgentsPanel.vue';
import ExpertsPanel from '../components/settings/ExpertsPanel.vue';
import ToolsPanel from '../components/settings/ToolsPanel.vue';
import RoutingPanel from '../components/settings/RoutingPanel.vue';

const route = useRoute();
const router = useRouter();

/** 设置分区枚举：key 为路由 query.tab 值 */
const SECTIONS = [
  { key: 'memory', ico: '🧠', label: '记忆' },
  { key: 'providers', ico: '⚙️', label: '配置' },
  { key: 'routing', ico: '🧭', label: '路由' },
  { key: 'skills', ico: '🧩', label: 'Skills' },
  { key: 'market', ico: '🛒', label: '市场' },
  { key: 'mcp', ico: '🔌', label: 'MCP' },
  { key: 'external', ico: '🤖', label: '外部 Agent' },
  { key: 'tools', ico: '🛠️', label: '功能' },
  { key: 'experts', ico: '🧑‍💼', label: '专家' },
  { key: 'usage', ico: '📊', label: '用量' },
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

/** 当前选中分区（query.tab 非法值回退为 memory；旧 ?tab=hub 映射到 market） */
const activeTab = computed<SectionKey>(() => {
  const t = route.query.tab;
  if (t === 'hub') return 'market';
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
        >{{ s.label }}</button>
      </nav>

      <!-- 右侧内容区：面板自身滚动 -->
      <main class="content">
        <MemoryPanel v-if="activeTab === 'memory'" />
        <ProvidersPanel v-else-if="activeTab === 'providers'" />
        <RoutingPanel v-else-if="activeTab === 'routing'" />
        <SkillsPanel v-else-if="activeTab === 'skills'" />
        <MarketPanel v-else-if="activeTab === 'market'" />
        <McpPanel v-else-if="activeTab === 'mcp'" />
        <ExternalAgentsPanel v-else-if="activeTab === 'external'" />
        <ToolsPanel v-else-if="activeTab === 'tools'" />
        <ExpertsPanel v-else-if="activeTab === 'experts'" />
        <UsagePanel v-else-if="activeTab === 'usage'" />
      </main>
    </div>
  </div>
</template>

<style scoped>
.settings { display: flex; flex-direction: column; height: 100vh; }

/* 顶栏：chrome 底色与工作台标签栏同层 */
.head {
  display: flex; align-items: center; gap: 14px;
  padding: 0 16px; height: 40px; min-height: 40px; border-bottom: 1px solid var(--border); background: var(--bg-chrome);
}
/* 返回：静默描边小钮 */
.back {
  height: 28px; display: inline-flex; align-items: center;
  padding: 0 10px; border-radius: var(--radius-sm); border: 1px solid var(--border);
  background: var(--bg-elevated); color: var(--text-dim); font-size: 12px;
  text-decoration: none; transition: all 0.12s ease-out;
}
.back:hover { background: var(--bg-elevated-2); color: var(--text); border-color: var(--border-strong); }
.title { font-size: 13px; font-weight: 600; margin: 0; }

/* 左右布局主体 */
.body { flex: 1; display: flex; min-height: 0; }

/* 左侧设置导航（bg-base 与工作台侧栏同层；激活项左侧 2px 蓝条，不填充强调色底） */
.side-nav {
  width: 220px; min-width: 220px;
  padding: 12px 10px; border-right: 1px solid var(--border);
  background: var(--bg-panel);
  display: flex; flex-direction: column; gap: 2px;
}
.nav-item {
  position: relative;
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 7px 12px; border: none; border-radius: var(--radius-md);
  background: transparent; color: var(--text-dim); font-size: 13px;
  cursor: pointer; text-align: left;
  transition: background 0.12s ease-out, color 0.12s ease-out;
}
.nav-item:hover { background: var(--bg-hover); color: var(--text); }
.nav-item.on { background: var(--bg-active); color: var(--text); font-weight: 600; }
.nav-item.on::before {
  content: ''; position: absolute; left: 0; top: 7px; bottom: 7px;
  width: 2px; border-radius: 1px; background: var(--accent);
}

/* 右侧内容区：宽度自适应，滚动发生在内容区（原弹窗 body 的 overflow-y:auto 职责转移至此） */
.content {
  flex: 1; min-width: 0; overflow-y: auto;
  padding: 18px 24px 28px;
}
</style>
