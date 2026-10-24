<script setup lang="ts">
// F-22b 定时任务卡片：名称 + toggle 开关 / prompt 两行截断 / 人话化调度描述 + 倒计时 /
// ▶ 立即运行 / ✎ 编辑 / … 更多（删除二次确认 · 历史展开）/ 批量模式多选框。
// 纯展示组件：启停/删除/运行等动作全部 emit 给容器（CronView）执行。
import { computed, ref } from 'vue';
import type { CronJobView, CronRunRecordView } from '../api/client';
import { countdownText, describeCron } from '../utils/cronHuman';

const props = defineProps<{
  job: CronJobView;
  batchMode: boolean;
  selected: boolean;
  running: boolean;
  expanded: boolean;
  /** 容器注入的当前时间（30s 刷新），倒计时/过期徽标的判定基准 */
  now: Date;
}>();

const emit = defineEmits<{
  toggle: [];
  edit: [];
  run: [];
  remove: [];
  expand: [];
  select: [checked: boolean];
}>();

const confirmingRemove = ref(false);
const menuOpen = ref(false);

const desc = computed(() => describeCron(props.job.cron));
const countdown = computed(() => countdownText(props.job.next_run_at, props.now));
const expired = computed(
  () => props.job.valid_until !== undefined && Date.parse(props.job.valid_until) < props.now.getTime(),
);
const permLabel = computed(() => {
  if (props.job.permission === 'yolo') return '完全访问';
  if (props.job.permission === 'plan') return '只读';
  return '';
});

/** 更多菜单动作后收起 */
function onMenuAction(fn: () => void): void {
  menuOpen.value = false;
  fn();
}

function onRemoveClick(): void {
  if (!confirmingRemove.value) {
    confirmingRemove.value = true; // 第一次点击进入确认态
    return;
  }
  confirmingRemove.value = false;
  emit('remove');
}

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
</script>

<template>
  <div class="job" :class="{ disabled: !job.enabled, picked: batchMode && selected }">
    <div class="head">
      <input
        v-if="batchMode"
        type="checkbox"
        class="pick"
        :checked="selected"
        @change="emit('select', ($event.target as HTMLInputElement).checked)"
      />
      <span class="name" :title="job.name">{{ job.name }}</span>
      <span v-if="permLabel" class="perm" :class="job.permission">{{ permLabel }}</span>
      <span class="grow" />
      <span v-if="running" class="running-mark">● 运行中…</span>
      <button
        class="switch"
        :class="{ on: job.enabled }"
        role="switch"
        :aria-checked="job.enabled"
        :title="job.enabled ? '已启用（点击暂停）' : '已暂停（点击启用）'"
        @click="emit('toggle')"
      >
        <span class="knob" />
      </button>
    </div>

    <div class="prompt" :title="job.prompt">{{ job.prompt }}</div>
    <div class="cwd" :title="job.cwd">{{ job.cwd }}</div>

    <div class="bottom">
      <span class="desc" title="调度规则">
        🔁 <code v-if="!desc.standard" class="cron-raw">{{ job.cron }}</code><template v-else>{{ desc.text }}</template>
      </span>
      <span v-if="expired" class="badge">已过期</span>
      <span class="grow" />
      <span class="countdown" :title="job.next_run_at ? `下次运行：${fmtTime(job.next_run_at)}` : ''">{{ countdown }}</span>
    </div>

    <div class="ops">
      <button class="op" :disabled="running" @click="onMenuAction(() => emit('run'))">
        {{ running ? '运行中…' : '▶ 立即运行' }}
      </button>
      <button class="op" @click="emit('edit')">✎ 编辑</button>
      <span class="menu-wrap">
        <button class="op" @click="menuOpen = !menuOpen">… 更多</button>
        <span v-if="menuOpen" class="menu">
          <button class="menu-item danger" @click="onMenuAction(onRemoveClick)">
            {{ confirmingRemove ? '确认删除？' : '删除' }}
          </button>
          <button class="menu-item" @click="onMenuAction(() => emit('expand'))">历史({{ job.runs.length }})</button>
        </span>
      </span>
    </div>

    <div v-if="expanded" class="history">
      <div v-if="job.runs.length === 0" class="empty">（还没有运行记录）</div>
      <div v-for="(r, i) in [...job.runs].reverse()" :key="i" class="run" :class="statusClass(r.status)">
        <span class="st">{{ r.status }}</span>
        <span class="meta">{{ describeRun(r) }}</span>
        <span v-if="r.error" class="err" :title="r.error">✘ {{ r.error.slice(0, 120) }}</span>
        <div v-else-if="r.result_preview" class="preview">{{ r.result_preview.slice(0, 200) }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.job { background: var(--bg-panel); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin-bottom: 10px; }
.job.disabled { opacity: 0.6; }
.job.picked { border-color: #58a6ff; }
.head { display: flex; align-items: center; gap: 8px; }
.pick { accent-color: #58a6ff; }
.name { font-size: 13px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.perm { font-size: 10.5px; border-radius: 4px; padding: 1px 6px; flex: none; }
.perm.yolo { color: #d29922; border: 1px solid #d29922; }
.perm.plan { color: var(--text-dim); border: 1px solid var(--border); }
.grow { flex: 1; }
.running-mark { color: #d29922; font-size: 11.5px; flex: none; }
/* toggle 开关 */
.switch { width: 34px; height: 19px; border-radius: 10px; border: none; background: var(--border); position: relative; cursor: pointer; flex: none; transition: background 0.15s; }
.switch .knob { position: absolute; top: 2px; left: 2px; width: 15px; height: 15px; border-radius: 50%; background: var(--text-faint); transition: transform 0.15s, background 0.15s; }
.switch.on { background: var(--green); }
.switch.on .knob { transform: translateX(15px); background: #fff; }
.prompt { color: var(--text); font-size: 12.5px; margin-top: 6px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.cwd { color: var(--text-faint); font-size: 11px; font-family: var(--mono); margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bottom { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.desc { color: var(--text-dim); font-size: 11.5px; }
.cron-raw { font-family: var(--mono); font-size: 11px; color: #58a6ff; background: var(--bg); padding: 1px 6px; border-radius: 4px; }
.badge { color: var(--text-faint); border: 1px solid var(--border); border-radius: 4px; padding: 0 5px; font-size: 10.5px; flex: none; }
.countdown { color: var(--text-faint); font-size: 11.5px; flex: none; }
.ops { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
.op { border: 1px solid var(--border); border-radius: 6px; background: transparent; color: var(--text-dim); font-size: 11.5px; padding: 3px 9px; cursor: pointer; }
.op:hover:not(:disabled) { color: var(--text); border-color: var(--text-faint); }
.op:disabled { opacity: 0.5; cursor: default; }
.menu-wrap { position: relative; }
.menu { position: absolute; right: 0; top: 26px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px; padding: 4px; display: flex; flex-direction: column; min-width: 96px; z-index: 5; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5); }
.menu-item { border: none; background: transparent; color: var(--text-dim); font-size: 12px; text-align: left; padding: 5px 8px; border-radius: 5px; cursor: pointer; }
.menu-item:hover { background: var(--bg-hover); color: var(--text); }
.menu-item.danger { color: var(--red); }
.history { border-top: 1px dashed var(--border); margin-top: 8px; padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.run { font-size: 11.5px; display: flex; flex-direction: column; gap: 2px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
.run:last-child { border-bottom: none; padding-bottom: 0; }
.run .st { font-weight: 600; }
.run .st.ok { color: var(--green); }
.run .st.warn { color: #d29922; }
.run .st.bad { color: var(--red); }
.run .meta { color: var(--text-faint); }
.run .err { color: var(--red); }
.run .preview { color: var(--text-dim); font-family: var(--mono); font-size: 10.5px; white-space: pre-wrap; word-break: break-all; }
.empty { color: var(--text-faint); text-align: center; font-size: 12px; padding: 4px; }
</style>
