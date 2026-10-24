<script setup lang="ts">
// 定时任务页（自 CronModal 迁移为独立页面，路由 /cron）：Tab 筛选（全部/已启用/已暂停，带计数）+
// 任务卡片列表 + 批量管理（多选 + 浮动操作栏）+ 新建/编辑弹窗（CronJobForm，保持弹窗形态）。
// 存储 ~/.y-zero/cron.json 与 CLI 共用；「立即运行」走 spawn 子进程（与 daemon 同构），
// 提交后轮询运行锁与 last_run；倒计时 30s 刷新（nowTick 注入卡片）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, type CronJobView } from '../api/client';
import CronJobCard from '../components/CronJobCard.vue';
import CronJobForm from '../components/CronJobForm.vue';

type Tab = 'all' | 'enabled' | 'paused';

const jobs = ref<CronJobView[]>([]);
const workspaces = ref<string[]>([]);
const warnings = ref<string[]>([]);
const loading = ref(false);
const error = ref('');
const toast = ref('');

const tab = ref<Tab>('all');
const expanded = ref('');
const batchMode = ref(false);
const selected = ref<Set<string>>(new Set());
const batchRemoveArmed = ref(false); // 批量删除两步确认态：true = 已点过一次，等待再次确认
const runningIds = ref<Set<string>>(new Set());

// ── 表单弹窗 ──
const showForm = ref(false);
const editingJob = ref<CronJobView | null>(null);

// 倒计时刷新（30s）；组件卸载清理
const now = ref(new Date());
let nowTimer: ReturnType<typeof setInterval> | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const anyRunning = computed(() => jobs.value.some((j) => j.running_since) || runningIds.value.size > 0);

const counts = computed(() => ({
  all: jobs.value.length,
  enabled: jobs.value.filter((j) => j.enabled).length,
  paused: jobs.value.filter((j) => !j.enabled).length,
}));

const filteredJobs = computed(() => {
  if (tab.value === 'enabled') return jobs.value.filter((j) => j.enabled);
  if (tab.value === 'paused') return jobs.value.filter((j) => !j.enabled);
  return jobs.value;
});

function showToast(msg: string): void {
  toast.value = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), 3000);
}

async function load(): Promise<void> {
  try {
    const r = await api.cronList();
    jobs.value = r.jobs;
    workspaces.value = r.workspaces ?? [];
    warnings.value = r.warnings.map((w) => w.message);
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function refresh(): Promise<void> {
  loading.value = true;
  await load();
  loading.value = false;
}

// ── 启停 toggle（乐观更新，失败回滚 + toast）──
async function toggleEnabled(j: CronJobView): Promise<void> {
  const prev = j.enabled;
  j.enabled = !prev;
  try {
    await api.cronUpdate(j.id, { enabled: !prev });
    await load();
  } catch (e) {
    j.enabled = prev; // 回滚 UI
    showToast((e as Error).message);
  }
}

async function removeJob(j: CronJobView): Promise<void> {
  error.value = '';
  try {
    await api.cronRemove(j.id);
    selected.value.delete(j.id);
    // 边缘加固：批量删除已 armed、经卡片单删恰好删掉唯一选中项时，复位确认态避免残留
    if (selected.value.size === 0) batchRemoveArmed.value = false;
    await load();
  } catch (e) {
    showToast((e as Error).message);
  }
}

/** 立即运行一次：标记住运行态并轮询，结束后刷新 */
async function runNow(j: CronJobView): Promise<void> {
  error.value = '';
  try {
    await api.cronRun(j.id);
    runningIds.value.add(j.id);
    startPolling();
  } catch (e) {
    showToast((e as Error).message);
  }
}

async function pollRunning(): Promise<void> {
  for (const id of [...runningIds.value]) {
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

function startPolling(): void {
  if (!pollTimer) pollTimer = setInterval(() => void pollRunning(), 2000);
}
function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
  }
}

// ── 批量管理：循环调既有 PATCH/DELETE（暂不新增批量端点）──
async function batchSetEnabled(enabled: boolean): Promise<void> {
  batchRemoveArmed.value = false; // 切换到其它批量操作时撤销删除确认态
  error.value = '';
  const ids = [...selected.value];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await api.cronUpdate(id, { enabled });
    } catch {
      failed.push(id);
    }
  }
  if (failed.length > 0) showToast(`${failed.length} 个任务操作失败`);
  await load();
}

async function batchRemove(): Promise<void> {
  // 两步确认（对齐 PRD 验收 9 / 设计 §3.1，同 CronJobCard 单删模式）：
  // 首次点击进入「确认删除 N 项？」确认态，再次点击才执行
  if (!batchRemoveArmed.value) {
    batchRemoveArmed.value = true;
    return;
  }
  batchRemoveArmed.value = false;
  error.value = '';
  const ids = [...selected.value];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await api.cronRemove(id);
    } catch {
      failed.push(id);
    }
  }
  selected.value = new Set();
  if (failed.length > 0) showToast(`${failed.length} 个任务删除失败`);
  await load();
}

function toggleBatchMode(): void {
  batchMode.value = !batchMode.value;
  selected.value = new Set();
  batchRemoveArmed.value = false; // 退出批量管理重置确认态
}

function toggleSelect(id: string, checked: boolean): void {
  const next = new Set(selected.value);
  if (checked) next.add(id);
  else next.delete(id);
  if (next.size === 0) batchRemoveArmed.value = false; // 取消全部勾选重置确认态
  selected.value = next;
}

function openCreate(): void {
  editingJob.value = null;
  showForm.value = true;
}

function openEdit(j: CronJobView): void {
  editingJob.value = j;
  showForm.value = true;
}

function onFormSaved(): void {
  showForm.value = false;
  editingJob.value = null;
  void load();
}

function onFormClosed(): void {
  showForm.value = false;
  editingJob.value = null;
}

onMounted(() => {
  void refresh();
  nowTimer = setInterval(() => (now.value = new Date()), 30_000);
});
onBeforeUnmount(() => {
  stopPolling();
  if (nowTimer) clearInterval(nowTimer);
  if (toastTimer) clearTimeout(toastTimer);
});
</script>

<template>
  <div class="page">
    <div class="head">
      <h2>⏰ 定时任务</h2>
    </div>
    <p class="sub">
      按 cron 规则定期自动运行 agent 任务（本地时区；存储 ~/.y-zero/cron.json，与 CLI <code>yzero cron</code> 共用）
    </p>
    <p v-if="error" class="error">✘ {{ error }}</p>
    <p v-if="toast" class="toast">⚠ {{ toast }}</p>
    <p v-for="w in warnings" :key="w" class="warn">⚠ {{ w }}</p>

    <div class="tabs">
      <button class="tab" :class="{ active: tab === 'all' }" @click="tab = 'all'">全部 {{ counts.all }}</button>
      <button class="tab" :class="{ active: tab === 'enabled' }" @click="tab = 'enabled'">已启用 {{ counts.enabled }}</button>
      <button class="tab" :class="{ active: tab === 'paused' }" @click="tab = 'paused'">已暂停 {{ counts.paused }}</button>
      <span class="grow" />
      <button class="btn" :class="{ primary: !batchMode }" @click="batchMode ? toggleBatchMode() : openCreate()">
        {{ batchMode ? '退出批量' : '+ 新建' }}
      </button>
      <button v-if="!batchMode" class="btn" @click="toggleBatchMode">批量管理</button>
      <button class="btn" @click="refresh">刷新</button>
      <span v-if="loading" class="meta">加载中…</span>
      <span v-if="anyRunning" class="meta running">● 有任务运行中…</span>
    </div>

    <div v-if="filteredJobs.length === 0" class="empty">
      （{{ tab === 'all' ? '暂无定时任务——点「+ 新建」创建，或用 CLI yzero cron add' : '该分组下暂无任务' }}）
    </div>

    <CronJobCard
      v-for="j in filteredJobs"
      :key="j.id"
      :job="j"
      :batch-mode="batchMode"
      :selected="selected.has(j.id)"
      :running="!!j.running_since || runningIds.has(j.id)"
      :expanded="expanded === j.id"
      :now="now"
      @toggle="toggleEnabled(j)"
      @edit="openEdit(j)"
      @run="runNow(j)"
      @remove="removeJob(j)"
      @expand="expanded = expanded === j.id ? '' : j.id"
      @select="(checked: boolean) => toggleSelect(j.id, checked)"
    />

    <!-- 批量浮动操作栏 -->
    <div v-if="batchMode && selected.size > 0" class="batch-bar">
      <span class="meta">已选 {{ selected.size }} 项</span>
      <span class="grow" />
      <button class="btn" @click="batchSetEnabled(true)">启用</button>
      <button class="btn" @click="batchSetEnabled(false)">停用</button>
      <button class="btn danger" :class="{ armed: batchRemoveArmed }" @click="batchRemove">
        {{ batchRemoveArmed ? `确认删除 ${selected.size} 项？` : '删除' }}
      </button>
    </div>

    <CronJobForm v-if="showForm" :job="editingJob" :workspaces="workspaces" @saved="onFormSaved" @close="onFormClosed" />
  </div>
</template>

<style scoped>
/* 页面骨架：作为工作台（WorkbenchView）的子路由渲染在 .main（flex column、flex:1、无 padding）内，
   用 flex:1 + min-height:0 撑满主区并内部滚动（.main 高度由 .app 100vh 约束），避免双滚动条；
   sticky 批量栏相对本滚动容器贴底。原「返回工作台」链接已移除——侧栏常驻后冗余。 */
.page { color: var(--text); padding: 20px 28px 40px; max-width: 900px; margin: 0 auto; flex: 1; min-height: 0; overflow-y: auto; }
.head { display: flex; align-items: baseline; gap: 12px; }
h2 { margin: 0; font-size: 18px; }
.sub { color: var(--text-dim); font-size: 12px; margin-bottom: 10px; }
.sub code { font-family: var(--mono); font-size: 11px; background: var(--bg-panel); padding: 1px 5px; border-radius: 4px; }
.error { color: var(--red); font-size: 13px; }
.toast { color: #d29922; font-size: 12.5px; }
.warn { color: #d29922; font-size: 12px; }
.tabs { display: flex; gap: 6px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.tab {
  border: 1px solid var(--border); border-radius: 16px; background: transparent;
  color: var(--text-dim); font-size: 12.5px; padding: 4px 14px; cursor: pointer;
}
.tab:hover { color: var(--text); }
.tab.active { color: var(--text); border-color: #58a6ff; background: rgba(88, 166, 255, 0.12); }
.grow { flex: 1; }
.meta { color: var(--text-faint); font-size: 11.5px; }
.meta.running { color: #d29922; }
.btn {
  border: 1px solid var(--border); border-radius: 8px; background: transparent;
  color: var(--text-dim); font-size: 12px; padding: 4px 12px; cursor: pointer; white-space: nowrap;
}
.btn:hover:not(:disabled) { color: var(--text); border-color: var(--text-faint); }
.btn.primary { background: #238636; border-color: #2ea043; color: #fff; }
.btn.danger { color: var(--red); }
.btn.danger:hover { border-color: var(--red); }
.btn.danger.armed { background: var(--red); border-color: var(--red); color: #fff; }
.empty { color: var(--text-faint); text-align: center; padding: 16px; font-size: 12.5px; }
.batch-bar {
  position: sticky; bottom: 12px; display: flex; align-items: center; gap: 8px;
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 10px;
  padding: 8px 12px; margin-top: 8px; box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.4);
}
</style>
