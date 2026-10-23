<script setup lang="ts">
// 定时任务面板（F-22）：清单 + 新增 + 启停/删除/立即运行 + 运行历史
// 存储与 CLI 共用 ~/.y-zero/cron.json；「立即运行」走 spawn 子进程（与 daemon 同构），
// 提交后轮询运行锁与 last_run，运行结束后自动刷新。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, type CronJobView, type CronRunRecordView } from '../api/client';
import ModalShell from './ModalShell.vue';

const emit = defineEmits<{ close: [] }>();

const jobs = ref<CronJobView[]>([]);
const warnings = ref<string[]>([]);
const loading = ref(false);
const error = ref('');
const expanded = ref<string>(''); // 展开运行历史的任务 id
const confirmingRemove = ref(''); // 二次确认删除中的任务 id
const runningIds = ref<Set<string>>(new Set());

// ── 新增表单 ──
const showAdd = ref(false);
const form = ref({ name: '', cron: '', prompt: '', cwd: '', maxCost: '' });
const addBusy = ref(false);

let pollTimer: ReturnType<typeof setInterval> | undefined;

const anyRunning = computed(() => jobs.value.some((j) => j.running_since) || runningIds.value.size > 0);

async function load() {
  try {
    const r = await api.cronList();
    jobs.value = r.jobs;
    warnings.value = r.warnings.map((w) => w.message);
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function refresh() {
  loading.value = true;
  await load();
  loading.value = false;
}

async function addJob() {
  if (!form.value.name.trim() || !form.value.cron.trim() || !form.value.prompt.trim()) {
    error.value = '名称 / 表达式 / 任务描述 均为必填';
    return;
  }
  addBusy.value = true;
  error.value = '';
  try {
    await api.cronAdd({
      name: form.value.name.trim(),
      cron: form.value.cron.trim(),
      prompt: form.value.prompt,
      cwd: form.value.cwd.trim(),
      ...(form.value.maxCost ? { max_cost_usd: Number(form.value.maxCost) } : {}),
    });
    form.value = { name: '', cron: '', prompt: '', cwd: '', maxCost: '' };
    showAdd.value = false;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    addBusy.value = false;
  }
}

async function toggleEnabled(j: CronJobView) {
  error.value = '';
  try {
    await api.cronUpdate(j.id, { enabled: !j.enabled });
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function removeJob(j: CronJobView) {
  if (confirmingRemove.value !== j.id) {
    confirmingRemove.value = j.id; // 第一次点击进入确认态
    return;
  }
  confirmingRemove.value = '';
  error.value = '';
  try {
    await api.cronRemove(j.id);
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

/** 立即运行一次：标记住运行态并轮询，结束后刷新 */
async function runNow(j: CronJobView) {
  error.value = '';
  try {
    await api.cronRun(j.id);
    runningIds.value.add(j.id);
    startPolling();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function pollRunning() {
  const ids = [...runningIds.value];
  for (const id of ids) {
    try {
      const j = await api.cronGet(id);
      if (!j.running_since) {
        runningIds.value.delete(id);
        expanded.value = id; // 运行结束自动展开历史
        await load();
      }
    } catch {
      runningIds.value.delete(id);
    }
  }
  if (runningIds.value.size === 0) stopPolling();
}

function startPolling() {
  if (!pollTimer) pollTimer = setInterval(() => void pollRunning(), 2000);
}
function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

function toggleExpand(id: string) {
  expanded.value = expanded.value === id ? '' : id;
}

/** 运行状态展示色（对齐主题语义） */
function statusClass(s: string): string {
  if (s === 'completed') return 'ok';
  if (s === 'running') return 'warn';
  return 'bad';
}

function fmtTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function describeRun(r: CronRunRecordView): string {
  const cost = r.cost_usd !== undefined ? ` · $${r.cost_usd.toFixed(4)}` : '';
  return `${r.trigger === 'manual' ? '手动' : '调度'} · ${fmtTime(r.started_at)} · ${r.duration_ms}ms${cost}${r.turns !== undefined ? ` · ${r.turns} 轮` : ''}`;
}

onMounted(() => {
  void refresh();
});
onBeforeUnmount(() => stopPolling());
</script>

<template>
  <ModalShell title="定时任务" icon="⏰" :width="720" @close="emit('close')">
    <p class="sub">按 cron 表达式定期自动运行 agent 任务（本地时区；存储 ~/.y-zero/cron.json，与 CLI <code>yzero cron</code> 共用）</p>
    <p v-if="error" class="error">✘ {{ error }}</p>
    <p v-for="w in warnings" :key="w" class="warn">⚠ {{ w }}</p>

    <div class="toolbar">
      <button class="btn primary" @click="showAdd = !showAdd">{{ showAdd ? '收起新增' : '+ 新增任务' }}</button>
      <button class="btn" @click="refresh">刷新</button>
      <span v-if="loading" class="meta">加载中…</span>
      <span v-if="anyRunning" class="meta running">● 有任务运行中…</span>
    </div>

    <form v-if="showAdd" class="add-form" @submit.prevent="addJob">
      <div class="row">
        <input v-model="form.name" placeholder="任务名称（唯一）" />
        <input v-model="form.cron" placeholder='cron 表达式，如 "30 8 * * *" 或 @daily' class="grow" />
      </div>
      <textarea v-model="form.prompt" placeholder="任务描述（等价 yzero run -p）" rows="2" />
      <div class="row">
        <input v-model="form.cwd" placeholder="运行目录（缺省：serve 启动目录）" class="grow" />
        <input v-model="form.maxCost" placeholder="单次费用上限 USD（可选）" class="cost-input" />
        <button class="btn primary" type="submit" :disabled="addBusy">{{ addBusy ? '添加中…' : '添加' }}</button>
      </div>
    </form>

    <div v-if="jobs.length === 0" class="empty">（暂无定时任务——点「新增任务」创建，或用 CLI <code>yzero cron add</code>）</div>

    <div v-for="j in jobs" :key="j.id" class="job" :class="{ disabled: !j.enabled }">
      <div class="head">
        <span class="dot" :class="j.running_since ? 'warn' : j.enabled ? 'ok' : 'off'" :title="j.running_since ? '运行中' : j.enabled ? '已启用' : '已停用'" />
        <span class="name" :title="j.id">{{ j.name }}</span>
        <code class="cron">{{ j.cron }}</code>
        <span class="grow" />
        <button class="op" :disabled="!!j.running_since || runningIds.has(j.id)" @click="runNow(j)">
          {{ j.running_since || runningIds.has(j.id) ? '运行中…' : '▶ 立即运行' }}
        </button>
        <button class="op" @click="toggleEnabled(j)">{{ j.enabled ? '停用' : '启用' }}</button>
        <button class="op danger" @click="removeJob(j)">{{ confirmingRemove === j.id ? '确认删除？' : '删除' }}</button>
        <button class="op" @click="toggleExpand(j.id)">{{ expanded === j.id ? '收起' : `历史(${j.runs.length})` }}</button>
      </div>
      <div class="meta-line">
        下次运行：{{ fmtTime(j.next_run_at) }}
        <template v-if="j.max_cost_usd !== undefined"> · 单次上限 ${{ j.max_cost_usd }}</template>
        <template v-if="j.last_run"> · 上次：<span :class="statusClass(j.last_run.status)">{{ j.last_run.status }}</span></template>
      </div>
      <div class="prompt" :title="j.cwd">{{ j.prompt }}</div>
      <div class="cwd">{{ j.cwd }}</div>
      <div v-if="expanded === j.id" class="history">
        <div v-if="j.runs.length === 0" class="empty">（还没有运行记录）</div>
        <div v-for="(r, i) in [...j.runs].reverse()" :key="i" class="run" :class="statusClass(r.status)">
          <span class="st">{{ r.status }}</span>
          <span class="meta">{{ describeRun(r) }}</span>
          <span v-if="r.error" class="err" :title="r.error">✘ {{ r.error.slice(0, 120) }}</span>
          <div v-else-if="r.result_preview" class="preview">{{ r.result_preview.slice(0, 200) }}</div>
        </div>
      </div>
    </div>
  </ModalShell>
</template>

<style scoped>
.sub { color: var(--text-dim); font-size: 12px; margin-bottom: 10px; }
.sub code { font-family: var(--mono); font-size: 11px; background: var(--bg-panel); padding: 1px 5px; border-radius: 4px; }
.error { color: var(--red); font-size: 13px; }
.warn { color: #d29922; font-size: 12px; }
.toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
.meta { color: var(--text-faint); font-size: 11.5px; }
.meta.running { color: #d29922; }
.add-form { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px; margin-bottom: 12px; display: flex; flex-direction: column; gap: 8px; }
.add-form .row { display: flex; gap: 8px; }
.add-form input, .add-form textarea { padding: 6px 9px; font-size: 12.5px; }
.add-form .grow { flex: 1; }
.cost-input { max-width: 180px; }
.empty { color: var(--text-faint); text-align: center; padding: 14px; font-size: 12.5px; }
.job { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
.job.disabled { opacity: 0.55; }
.head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dot.ok { background: var(--green); }
.dot.warn { background: #d29922; }
.dot.off { background: var(--text-faint); }
.name { font-size: 13px; font-weight: 600; color: var(--text); }
.cron { font-family: var(--mono); font-size: 11.5px; color: #58a6ff; background: var(--bg); padding: 1px 6px; border-radius: 4px; }
.grow { flex: 1; }
.op { border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text-dim); font-size: 11.5px; padding: 3px 9px; cursor: pointer; }
.op:hover:not(:disabled) { color: var(--text); border-color: var(--text-faint); }
.op:disabled { opacity: 0.5; cursor: default; }
.op.danger { color: var(--red); }
.meta-line { color: var(--text-faint); font-size: 11.5px; margin-top: 6px; }
.st.ok { color: var(--green); }
.st.warn { color: #d29922; }
.st.bad { color: var(--red); }
.meta-line .ok { color: var(--green); }
.meta-line .warn { color: #d29922; }
.meta-line .bad { color: var(--red); }
.prompt { color: var(--text); font-size: 12.5px; margin-top: 4px; }
.cwd { color: var(--text-faint); font-size: 11px; font-family: var(--mono); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history { border-top: 1px dashed var(--border); margin-top: 8px; padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.run { font-size: 11.5px; display: flex; flex-direction: column; gap: 2px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
.run:last-child { border-bottom: none; padding-bottom: 0; }
.run .st { font-weight: 600; }
.run .err { color: var(--red); }
.run .preview { color: var(--text-dim); font-family: var(--mono); font-size: 10.5px; white-space: pre-wrap; word-break: break-all; }
</style>
