<script setup lang="ts">
// 用量面板（F-31 成本与用量报告）：时间范围切换 + 项目筛选 + 总览卡片 + 三分组表格（纯 CSS 占比条）
import { onMounted, ref } from 'vue';
import {
  api,
  type ProjectRow,
  type UsageRange,
  type UsageSummary,
  type UsageSessionRow,
} from '../api/client';

const RANGES: Array<{ value: UsageRange; label: string }> = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
  { value: 'all', label: '全部' },
];

const range = ref<UsageRange>('all');
const projectId = ref('');
const projects = ref<ProjectRow[]>([]);
const summary = ref<UsageSummary | null>(null);
const sessions = ref<UsageSessionRow[]>([]);
const loading = ref(false);
const error = ref('');

const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');
const fmtCost = (n: number) => `$${n.toFixed(4)}`;

/** 占比条宽度百分比（相对组内最大费用） */
function barWidth(cost: number, rows: Array<{ cost_usd: number }>): string {
  const max = Math.max(...rows.map((r) => r.cost_usd), 0);
  if (max <= 0) return '0%';
  return `${Math.max(2, Math.round((cost / max) * 100))}%`;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const pid = projectId.value || undefined;
    const [sum, list] = await Promise.all([
      api.usageSummary(range.value, pid),
      api.usageSessions(range.value, pid),
    ]);
    summary.value = sum;
    sessions.value = list.items;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function setRange(r: UsageRange) {
  range.value = r;
  void load();
}

onMounted(async () => {
  void load();
  try {
    projects.value = await api.listProjects();
  } catch {
    // 项目列表加载失败不阻塞面板（筛选下拉退化为「全部项目」）
  }
});
</script>

<template>
  <div class="page">
    <h2>用量报告</h2>
    <p class="sub">按项目 / 模型 / 会话维度的费用与 token 统计（软删除会话费用计入汇总，明细仅列活跃会话）</p>
    <p v-if="error" class="error">✘ {{ error }}</p>

    <!-- 时间范围切换 + 项目筛选 -->
    <div class="filters">
      <div class="range-group">
        <button
          v-for="r in RANGES"
          :key="r.value"
          class="btn range"
          :class="{ active: range === r.value }"
          @click="setRange(r.value)"
        >
          {{ r.label }}
        </button>
      </div>
      <select v-model="projectId" class="project-select" @change="load">
        <option value="">全部项目</option>
        <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
      </select>
      <button class="btn" @click="load">刷新</button>
      <span v-if="loading" class="meta">加载中…</span>
    </div>

    <template v-if="summary">
      <!-- 空态 -->
      <div v-if="summary.totals.turns === 0" class="card empty">
        （所选范围内暂无用量数据——跑一次任务后这里会展示费用 / token 统计）
      </div>

      <template v-else>
        <!-- 总览卡片 -->
        <div class="cards">
          <div class="stat">
            <div class="stat-label">总费用</div>
            <div class="stat-value">{{ fmtCost(summary.totals.cost_usd) }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">输入 token</div>
            <div class="stat-value">{{ fmtInt(summary.totals.input_tokens) }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">输出 token</div>
            <div class="stat-value">{{ fmtInt(summary.totals.output_tokens) }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">轮次</div>
            <div class="stat-value">{{ fmtInt(summary.totals.turns) }}</div>
          </div>
          <div class="stat">
            <div class="stat-label">会话数</div>
            <div class="stat-value">{{ fmtInt(summary.totals.sessions) }}</div>
          </div>
        </div>

        <!-- 按项目 -->
        <section class="card">
          <h3>按项目</h3>
          <div v-if="summary.by_project.length === 0" class="empty">（无数据）</div>
          <div v-for="p in summary.by_project" :key="p.project_id ?? 'unknown'" class="row">
            <span class="name">{{ p.project_name }}</span>
            <span class="bar-track"><span class="bar" :style="{ width: barWidth(p.cost_usd, summary.by_project) }" /></span>
            <span class="cost">{{ fmtCost(p.cost_usd) }}</span>
            <span class="meta">in {{ fmtInt(p.input_tokens) }} / out {{ fmtInt(p.output_tokens) }} · {{ fmtInt(p.turns) }} 轮 · {{ fmtInt(p.sessions) }} 会话</span>
          </div>
        </section>

        <!-- 按模型 -->
        <section class="card">
          <h3>按模型</h3>
          <div v-if="summary.by_model.length === 0" class="empty">（无数据）</div>
          <div v-for="m in summary.by_model" :key="m.model" class="row">
            <span class="name">{{ m.model }}</span>
            <span class="bar-track"><span class="bar" :style="{ width: barWidth(m.cost_usd, summary.by_model) }" /></span>
            <span class="cost">{{ fmtCost(m.cost_usd) }}</span>
            <span class="meta">in {{ fmtInt(m.input_tokens) }} / out {{ fmtInt(m.output_tokens) }} · {{ fmtInt(m.turns) }} 轮 · {{ fmtInt(m.sessions) }} 会话</span>
          </div>
        </section>

        <!-- 按会话（可展开显示轮次明细简化为直接展示轮次） -->
        <section class="card">
          <h3>按会话（仅活跃会话）</h3>
          <div v-if="sessions.length === 0" class="empty">（无活跃会话用量——软删除会话费用已计入上方汇总）</div>
          <div v-for="s in sessions" :key="s.session_id" class="row">
            <span class="name" :title="s.title">{{ s.title || '（未命名）' }}</span>
            <span class="bar-track"><span class="bar" :style="{ width: barWidth(s.cost_usd, sessions) }" /></span>
            <span class="cost">{{ fmtCost(s.cost_usd) }}</span>
            <span class="meta">{{ s.model || '（未知模型）' }} · {{ fmtInt(s.turns) }} 轮 · {{ s.session_id.slice(0, 8) }}</span>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>

<style scoped>
.page { color: #c9d1d9; padding: 24px 32px; }
h2 { color: #e6edf3; margin-bottom: 4px; }
h3 { color: #e6edf3; margin: 0 0 8px; font-size: 14px; }
.sub { color: #8b949e; font-size: 13px; margin-top: 0; }
.error { color: #f85149; }
.card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; margin: 16px 0; }
.empty { color: #8b949e; text-align: center; padding: 18px; }
.filters { display: flex; gap: 8px; margin: 10px 0; align-items: center; flex-wrap: wrap; }
.range-group { display: flex; gap: 0; border: 1px solid #30363d; border-radius: 6px; overflow: hidden; }
.range-group .btn { border: none; border-radius: 0; }
.range-group .btn.active { background: #1f6feb; color: #fff; }
.project-select { background: #0d1117; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 4px 8px; min-width: 160px; }
.btn { background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
.cards { display: flex; gap: 12px; flex-wrap: wrap; margin: 16px 0; }
.stat { flex: 1; min-width: 140px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 12px 16px; }
.stat-label { color: #8b949e; font-size: 12px; }
.stat-value { color: #e6edf3; font-size: 20px; font-weight: 600; margin-top: 4px; }
.row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid #21262d; flex-wrap: wrap; }
.row:last-child { border-bottom: none; }
.name { color: #c9d1d9; min-width: 180px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar-track { flex: 1; min-width: 120px; height: 10px; background: #0d1117; border-radius: 5px; overflow: hidden; }
.bar { display: block; height: 100%; background: linear-gradient(90deg, #1f6feb, #58a6ff); border-radius: 5px; }
.cost { color: #3fb950; min-width: 90px; text-align: right; }
.meta { color: #8b949e; font-size: 12px; }
</style>
