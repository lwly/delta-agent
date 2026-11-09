<script setup lang="ts">
// 定时任务页（自 CronModal 迁移为独立页面，路由 /cron）：Tab 筛选（全部/已启用/已暂停，带计数）+
// 任务卡片列表 + 批量管理（多选 + 浮动操作栏）+ 新建/编辑弹窗（CronJobForm，保持弹窗形态）。
// 存储 ~/.delta/cron.json 与 CLI 共用；「立即运行」走 spawn 子进程（与 daemon 同构），
// 提交后轮询运行锁与 last_run；倒计时 30s 刷新（nowTick 注入卡片）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api, type CronJobView } from '../api/client';
import CronJobCard from '../components/CronJobCard.vue';
import CronJobForm from '../components/CronJobForm.vue';
import { useWorkspaceStore } from '../stores/workspace';
import { cwdInRoot } from '../utils/scope';

type Tab = 'all' | 'enabled' | 'paused';

// ── F-59 项目作用域：默认只显示 cwd 落在当前项目根内（含子目录）的任务，可切「全部项目」──
const ws = useWorkspaceStore();
const projectScoped = ref(true);
const activeProjectName = computed(() => ws.projects.find((p) => p.id === ws.activeProjectId)?.name ?? '');
const activeRoot = computed(() => ws.projects.find((p) => p.id === ws.activeProjectId)?.root_path ?? '');

const jobs = ref<CronJobView[]>([]);
const workspaces = ref<string[]>([]);
const warnings = ref<string[]>([]);
const loading = ref(false);
const error = ref('');
const toast = ref('');

// ── F-22 收口（D3 裁决）：调度器运行状态（GET /api/status）──
// running=false 时显示「调度器未运行」提示：定时任务不会自动触发。
// 端点缺失（旧 server）时静默按运行中处理，不阻塞任务列表。
const schedulerRunning = ref(true);
const schedulerMode = ref<'auto' | 'off'>('auto');

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

/** 项目作用域后的任务集（Tab 计数与列表同源，数字与所见一致） */
const scopedJobs = computed(() => {
  if (!projectScoped.value || !activeRoot.value) return jobs.value;
  const root = activeRoot.value;
  return jobs.value.filter((j) => cwdInRoot(j.cwd, root));
});

const counts = computed(() => ({
  all: scopedJobs.value.length,
  enabled: scopedJobs.value.filter((j) => j.enabled).length,
  paused: scopedJobs.value.filter((j) => !j.enabled).length,
}));

const filteredJobs = computed(() => {
  if (tab.value === 'enabled') return scopedJobs.value.filter((j) => j.enabled);
  if (tab.value === 'paused') return scopedJobs.value.filter((j) => !j.enabled);
  return scopedJobs.value;
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
  try {
    const st = await api.status();
    schedulerRunning.value = st.cron.running;
    schedulerMode.value = st.cron.mode;
  } catch {
    schedulerRunning.value = true; // /api/status 不可用（旧 server）：不误报
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
      <h2>定时任务</h2>
      <span class="grow" />
      <router-link class="btn" to="/">← 工作台</router-link>
    </div>
    <p class="sub">
      按 cron 规则定期自动运行 agent 任务（本地时区；存储 ~/.delta/cron.json，与 CLI <code>delta cron</code> 共用）
    </p>
    <p v-if="error" class="error">✘ {{ error }}</p>
    <p v-if="toast" class="toast">⚠ {{ toast }}</p>
    <p v-for="w in warnings" :key="w" class="warn">⚠ {{ w }}</p>
    <!-- 调度器未运行提示（F-22 收口 T1 / D3）：任务仍可手动「立即运行」，只是不会自动触发 -->
    <p v-if="!schedulerRunning" class="warn">
      ⚠ 调度器未运行（mode={{ schedulerMode }}）：定时任务不会自动触发。
      请在宿主机保持 <code>delta serve</code> 运行（内置调度），或自行运行 <code>delta cron daemon</code>。
    </p>

    <div class="tabs">
      <!-- F-59 项目作用域开关：跟随左侧选中的项目（cwd 归属过滤），可切「全部项目」 -->
      <button
        v-if="activeRoot"
        class="tab scope"
        :class="{ active: projectScoped }"
        :title="projectScoped ? `只显示 ${activeProjectName}（${activeRoot}）内的任务，点击查看全部项目` : '显示全部项目的定时任务，点击回到当前项目'"
        @click="projectScoped = !projectScoped"
      >{{ projectScoped ? `📁 ${activeProjectName}` : '全部项目' }}</button>
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
      （{{ projectScoped && activeRoot && jobs.length > 0
        ? '当前项目暂无定时任务——点「全部项目」查看其它项目的任务'
        : tab === 'all' ? '暂无定时任务——点「+ 新建」创建，或用 CLI delta cron add' : '该分组下暂无任务' }}）
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
   sticky 批量栏相对本滚动容器贴底。头部「← 工作台」返回链接保留（rail 亦有工作台入口，双保险）。
   视觉规范：与深色极简工作台一致（13px/600 标题、elevated 卡片、6px 控件圆角、无 emoji 标题） */
.page { color: var(--text); padding: 16px 24px 40px; max-width: 900px; margin: 0 auto; flex: 1; min-height: 0; overflow-y: auto; }
.head { display: flex; align-items: center; gap: 12px; }
/* 返回工作台链接：对齐 .btn 规格，弱化为普通跳转（不做强调色） */
a.btn { text-decoration: none; }
h2 { margin: 0; font-size: 13px; font-weight: 600; }
.sub { color: var(--text-faint); font-size: 12px; margin: 4px 0 12px; }
.sub code { font-family: var(--mono); font-size: 11px; background: var(--bg-elevated); padding: 1px 5px; border-radius: 4px; }
.error { color: var(--red); font-size: 13px; }
.toast { color: var(--orange); font-size: 12.5px; }
.warn { color: var(--orange); font-size: 12px; }
.warn code { font-family: var(--mono); font-size: 11px; background: var(--bg-elevated); padding: 1px 5px; border-radius: 4px; }
.tabs { display: flex; gap: 6px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
/* 分段筛选：bg-elevated 药丸，激活提为 bg-active（不填充强调色底） */
.tab {
  border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elevated);
  color: var(--text-dim); font-size: 12px; padding: 4px 12px; cursor: pointer;
  transition: background 0.12s ease-out, color 0.12s ease-out;
}
.tab:hover { color: var(--text); }
.tab.active { color: var(--text); border-color: var(--border-strong); background: var(--bg-active); }
/* 作用域开关：关闭态弱化为纯筛选 chip（与级别 tab 同款），激活态不变 */
.tab.scope { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.grow { flex: 1; }
.meta { color: var(--text-faint); font-size: 11.5px; }
.meta.running { color: var(--orange); }
/* 批量删除两步确认态：红底实心（主题 .btn.danger 之上加强） */
.btn.danger.armed { background: var(--red); border-color: var(--red); color: #fff; }
.empty { color: var(--text-faint); text-align: center; padding: 16px; font-size: 13px; }
.batch-bar {
  position: sticky; bottom: 12px; display: flex; align-items: center; gap: 8px;
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: 8px 12px; margin-top: 8px; box-shadow: var(--shadow-pop);
}
</style>
