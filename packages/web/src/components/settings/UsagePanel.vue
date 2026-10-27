<script setup lang="ts">
// 设置页·用量面板（F-31 内容区）：预算设置 + 时间范围 + 项目筛选 + 总览卡片 + 项目/模型/会话三维度占比条
// 从 UsageModal 抽取主体内容，弹窗壳保留在 UsageModal.vue 中复用
import { onMounted, ref } from 'vue';
import {
  api,
  type ProjectRow,
  type UsageRange,
  type UsageSummary,
  type UsageSessionRow,
} from '../../api/client';

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

// ── 预算设置（settings.json 的 budget 键；累计口径，改后下一轮运行生效）──
const budgetMaxTokens = ref('');
const budgetMaxCost = ref('');
const budgetDefaults = ref<{ maxTokens: number; maxCostUsd: number } | null>(null);
const budgetSaving = ref(false);
const budgetMsg = ref('');

async function loadBudget() {
  try {
    const b = await api.getBudgetSetting();
    budgetMaxTokens.value = b.maxTokens != null ? String(b.maxTokens) : '';
    budgetMaxCost.value = b.maxCostUsd != null ? String(b.maxCostUsd) : '';
    budgetDefaults.value = b.defaults;
  } catch {
    // 旧服务端无此端点 → 静默隐藏编辑能力
    budgetDefaults.value = null;
  }
}

async function saveBudget() {
  budgetSaving.value = true;
  budgetMsg.value = '';
  try {
    const t = budgetMaxTokens.value.trim();
    const c = budgetMaxCost.value.trim();
    await api.updateBudgetSetting({
      maxTokens: t === '' ? null : Number(t),
      maxCostUsd: c === '' ? null : Number(c),
    });
    budgetMsg.value = '✔ 已保存（下一轮运行生效）';
    await loadBudget();
  } catch (e) {
    budgetMsg.value = `✘ ${(e as Error).message}`;
  } finally {
    budgetSaving.value = false;
  }
}

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
  void loadBudget();
  try {
    projects.value = await api.listProjects();
  } catch {
    // 项目列表加载失败不阻塞面板（筛选下拉退化为「全部项目」）
  }
});
</script>

<template>
  <p class="sub">按项目 / 模型 / 会话维度的费用与 token 统计（软删除会话费用计入汇总，明细仅列活跃会话）</p>
  <p v-if="error" class="error">✘ {{ error }}</p>

  <!-- 预算设置：单轮任务的累计上限（input+output 按轮累加，非上下文占用） -->
  <section v-if="budgetDefaults" class="block budget">
    <h4>会话预算（单轮任务累计上限）</h4>
    <div class="budget-row">
      <label class="bfield">
        <span class="blabel">Token 上限</span>
        <input v-model="budgetMaxTokens" class="binput" inputmode="numeric" :placeholder="`默认 ${fmtInt(budgetDefaults.maxTokens)}`" />
      </label>
      <label class="bfield">
        <span class="blabel">费用上限（USD）</span>
        <input v-model="budgetMaxCost" class="binput" inputmode="decimal" :placeholder="`默认 ${budgetDefaults.maxCostUsd}`" />
      </label>
      <button class="btn primary" :disabled="budgetSaving" @click="saveBudget">{{ budgetSaving ? '保存中…' : '保存' }}</button>
      <span class="meta">{{ budgetMsg }}</span>
    </div>
    <p class="meta">口径：单轮任务所有 LLM 调用的 token/费用累计（含子代理），超出即安全停止并让模型总结收尾。留空 = 使用默认值。</p>
  </section>

  <div class="filters">
    <div class="range-group">
      <button v-for="r in RANGES" :key="r.value" class="rb" :class="{ active: range === r.value }" @click="setRange(r.value)">
        {{ r.label }}
      </button>
    </div>
    <select v-model="projectId" class="grow" @change="load">
      <option value="">全部项目</option>
      <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
    </select>
    <button class="btn" @click="load">刷新</button>
    <span v-if="loading" class="meta">加载中…</span>
  </div>

  <template v-if="summary">
    <div v-if="summary.totals.turns === 0" class="empty">（所选范围内暂无用量数据——跑一次任务后这里会展示费用 / token 统计）</div>

    <template v-else>
      <div class="cards">
        <div class="stat">
          <div class="label">总费用</div>
          <div class="value green">{{ fmtCost(summary.totals.cost_usd) }}</div>
        </div>
        <div class="stat">
          <div class="label">输入 token</div>
          <div class="value">{{ fmtInt(summary.totals.input_tokens) }}</div>
        </div>
        <div class="stat">
          <div class="label">输出 token</div>
          <div class="value">{{ fmtInt(summary.totals.output_tokens) }}</div>
        </div>
        <div class="stat">
          <div class="label">轮次</div>
          <div class="value">{{ fmtInt(summary.totals.turns) }}</div>
        </div>
        <div class="stat">
          <div class="label">会话数</div>
          <div class="value">{{ fmtInt(summary.totals.sessions) }}</div>
        </div>
      </div>

      <section class="block">
        <h4>按项目</h4>
        <div v-if="summary.by_project.length === 0" class="empty">（无数据）</div>
        <div v-for="p in summary.by_project" :key="p.project_id ?? 'unknown'" class="brow">
          <span class="name">{{ p.project_name }}</span>
          <span class="track"><span class="fill" :style="{ width: barWidth(p.cost_usd, summary.by_project) }" /></span>
          <span class="cost">{{ fmtCost(p.cost_usd) }}</span>
          <span class="meta">in {{ fmtInt(p.input_tokens) }} / out {{ fmtInt(p.output_tokens) }} · {{ fmtInt(p.turns) }} 轮 · {{ fmtInt(p.sessions) }} 会话</span>
        </div>
      </section>

      <section class="block">
        <h4>按模型</h4>
        <div v-if="summary.by_model.length === 0" class="empty">（无数据）</div>
        <div v-for="m in summary.by_model" :key="m.model" class="brow">
          <span class="name mono">{{ m.model }}</span>
          <span class="track"><span class="fill" :style="{ width: barWidth(m.cost_usd, summary.by_model) }" /></span>
          <span class="cost">{{ fmtCost(m.cost_usd) }}</span>
          <span class="meta">in {{ fmtInt(m.input_tokens) }} / out {{ fmtInt(m.output_tokens) }} · {{ fmtInt(m.turns) }} 轮 · {{ fmtInt(m.sessions) }} 会话</span>
        </div>
      </section>

      <section class="block">
        <h4>按会话（仅活跃会话）</h4>
        <div v-if="sessions.length === 0" class="empty">（无活跃会话用量——软删除会话费用已计入上方汇总）</div>
        <div v-for="s in sessions" :key="s.session_id" class="brow">
          <span class="name" :title="s.title">{{ s.title || '（未命名）' }}</span>
          <span class="track"><span class="fill" :style="{ width: barWidth(s.cost_usd, sessions) }" /></span>
          <span class="cost">{{ fmtCost(s.cost_usd) }}</span>
          <span class="meta">{{ s.model || '（未知模型）' }} · {{ fmtInt(s.turns) }} 轮 · {{ s.session_id.slice(0, 8) }}</span>
        </div>
      </section>
    </template>
  </template>
</template>

<style scoped>
.sub { color: var(--text-dim); font-size: 12px; margin-bottom: 10px; }
.error { color: var(--red); font-size: 13px; }
.filters { display: flex; gap: 8px; margin: 8px 0 14px; align-items: center; flex-wrap: wrap; }
.filters select { min-width: 150px; padding: 6px 9px; }
.grow { flex: 1; }
.range-group { display: flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.rb { border: none; border-radius: 0; background: transparent; color: var(--text-dim); padding: 6px 12px; font-size: 12px; cursor: pointer; }
.rb.active { background: #1f6feb; color: #fff; }
.meta { color: var(--text-faint); font-size: 11.5px; }
.cards { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.stat { flex: 1; min-width: 110px; background: var(--bg-panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; }
.label { color: var(--text-faint); font-size: 11.5px; }
.value { color: var(--text); font-size: 18px; font-weight: 600; margin-top: 3px; font-family: var(--mono); }
.value.green { color: var(--green); }
.block { margin-bottom: 14px; }
h4 { font-size: 13px; color: var(--text); margin-bottom: 8px; }
.brow { display: flex; align-items: center; gap: 10px; padding: 5px 0; border-bottom: 1px solid #21262d; flex-wrap: wrap; }
.brow:last-child { border-bottom: none; }
.name { min-width: 150px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
.name.mono { font-family: var(--mono); }
.track { flex: 1; min-width: 100px; height: 9px; background: var(--bg); border-radius: 5px; overflow: hidden; }
.fill { display: block; height: 100%; background: var(--accent); border-radius: 5px; }
.cost { color: var(--green); min-width: 80px; text-align: right; font-family: var(--mono); font-size: 12.5px; }
.empty { color: var(--text-faint); text-align: center; padding: 14px; font-size: 12.5px; }
/* 预算设置区 */
.budget { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; }
.budget-row { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 6px; }
.bfield { display: flex; flex-direction: column; gap: 4px; }
.blabel { color: var(--text-faint); font-size: 11.5px; }
.binput { width: 160px; padding: 6px 9px; font-family: var(--mono); }
</style>
