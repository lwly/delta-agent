<script setup lang="ts">
// F-18 会话回放：任务（run）列表 + 单次任务时间线（含工具调用与结果配对）
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, type RunStep, type RunSummary, type RunTimeline } from '../api/client';
// 架构收口 T9（判据 1）：工具步骤状态推导收敛到共享配对模块（与主对话流、任务详情同一实现）
import { cardsFromTimelineSteps } from '../composables/useSessionTranscript';

const route = useRoute();
const router = useRouter();
const sessionId = computed(() => String(route.params.sessionId ?? ''));

const runs = ref<RunSummary[]>([]);
const timeline = ref<RunTimeline | null>(null);
const selected = ref(-1);
const loading = ref(false);
const error = ref('');

const sessionTitle = ref('');

async function loadRuns() {
  loading.value = true;
  error.value = '';
  try {
    runs.value = await api.listRuns(sessionId.value);
    const detail = await api.getSession(sessionId.value);
    sessionTitle.value = detail.session.title;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function openRun(index: number) {
  selected.value = index;
  error.value = '';
  try {
    timeline.value = await api.getRunTimeline(sessionId.value, index);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function fmt(at: string): string {
  const d = new Date(at);
  return isNaN(d.getTime()) ? at : d.toLocaleTimeString('zh-CN');
}

function argsPretty(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2);
  } catch {
    return json;
  }
}

/** F-46 回放页分叉入口：从该任务的 user 消息分叉新会话并自动重跑，完成后跳入新会话 */
async function forkFrom(r: RunSummary) {
  error.value = '';
  try {
    const res = await api.forkSession(sessionId.value, r.afterIndex, { run: true });
    await router.push(`/chat/${res.session_id}`);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

/** F-49 会话导出：下载自包含 HTML/Markdown 只读快照（纯本地生成，默认脱敏） */
const exporting = ref<'html' | 'md' | ''>('');
async function exportSession(format: 'html' | 'md') {
  error.value = '';
  exporting.value = format;
  try {
    await api.exportSession(sessionId.value, format);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    exporting.value = '';
  }
}

function stepIcon(s: RunStep): string {
  if (s.type === 'user') return '👤';
  if (s.type === 'assistant') return '🤖';
  // T9：状态推导走共享卡片口径（cardsFromTimelineSteps，与主对话流/任务详情同源）
  const st = stepCards.value[timelineStepIndex(s)]?.status;
  return s.result ? (st === 'ok' ? '🔧✔' : '🔧✘') : '🔧…';
}

/** 当前时间线的工具卡视图（共享 cardsFromTimelineSteps 派生；与步骤按序对齐） */
const stepCards = computed(() => (timeline.value ? cardsFromTimelineSteps(timeline.value.steps) : []));
/** 步骤 → 工具卡序号映射（cardsFromTimelineSteps 只含工具步骤，按出现顺序编号） */
function timelineStepIndex(s: RunStep): number {
  if (!timeline.value) return -1;
  let n = -1;
  for (let i = 0; i <= timeline.value.steps.indexOf(s); i++) {
    if (timeline.value.steps[i]!.name !== undefined) n += 1;
  }
  return n;
}

/** 复制任意文本到剪贴板；按钮短暂显示「已复制」作为反馈 */
const copiedKey = ref('');
function copyText(text: string, key: string) {
  navigator.clipboard.writeText(text).then(() => {
    copiedKey.value = key;
    setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = '';
    }, 1500);
  });
}

onMounted(loadRuns);
</script>

<template>
  <div class="page">
    <div class="head">
      <h2>会话回放</h2>
      <span class="muted">{{ sessionTitle }}</span>
      <router-link class="back" :to="`/chat/${sessionId}`">← 返回对话</router-link>
      <!-- F-49 会话导出 -->
      <span class="export-row">
        <button class="export-btn" :disabled="exporting !== ''" title="下载自包含只读 HTML（纯本地生成，默认脱敏）" @click="exportSession('html')">
          {{ exporting === 'html' ? '导出中…' : '⬇ 导出 HTML' }}
        </button>
        <button class="export-btn" :disabled="exporting !== ''" title="下载 Markdown（纯本地生成，默认脱敏）" @click="exportSession('md')">
          {{ exporting === 'md' ? '导出中…' : '⬇ 导出 MD' }}
        </button>
      </span>
    </div>
    <p v-if="error" class="error">✘ {{ error }}</p>

    <div class="layout">
      <!-- 任务列表 -->
      <aside class="runs">
        <h3>任务（{{ runs.length }}）</h3>
        <div
          v-for="r in runs"
          :key="r.index"
          class="run"
          :class="{ active: selected === r.index }"
          @click="openRun(r.index)"
        >
          <div class="preview">{{ r.userPreview }}</div>
          <div class="meta">
            #{{ r.index + 1 }} · {{ fmt(r.startedAt) }} · {{ r.toolCalls }} 次工具调用
            <button class="run-fork" title="从此重跑（分叉新会话，原会话不动）" @click.stop="forkFrom(r)">🔀 从此重跑</button>
          </div>
        </div>
        <p v-if="runs.length === 0 && !loading" class="empty">（暂无任务记录）</p>
      </aside>

      <!-- 时间线 -->
      <section class="timeline">
        <template v-if="timeline">
          <div class="tl-head">
            任务 #{{ timeline.index + 1 }} · {{ fmt(timeline.startedAt) }} → {{ fmt(timeline.endedAt) }}
          </div>
          <div v-for="(s, i) in timeline.steps" :key="i" class="step" :class="s.type">
            <span class="icon">{{ stepIcon(s) }}</span>
            <div class="body">
              <div class="when">
              {{ fmt(s.at) }}
              <!-- 快捷复制：文本步骤复制原文，工具步骤复制参数/结果 -->
              <span class="copy-row">
                <template v-if="s.type === 'tool_call'">
                  <button class="mini-copy" @click="copyText(argsPretty(s.argsJson ?? ''), `a${i}`)">
                    {{ copiedKey === `a${i}` ? '已复制' : '复制参数' }}
                  </button>
                  <button v-if="s.result" class="mini-copy" @click="copyText(s.result.content, `r${i}`)">
                    {{ copiedKey === `r${i}` ? '已复制' : '复制结果' }}
                  </button>
                </template>
                <button v-else class="mini-copy" @click="copyText(s.text ?? '', `t${i}`)">
                  {{ copiedKey === `t${i}` ? '已复制' : '复制' }}
                </button>
              </span>
            </div>
              <div v-if="s.type === 'user'" class="text user">{{ s.text }}</div>
              <div v-else-if="s.type === 'assistant'" class="text assistant">{{ s.text }}</div>
              <div v-else class="toolcall">
                <div class="call-head">
                  <code>{{ s.name }}</code>
                  <span v-if="s.result" :class="stepCards[timelineStepIndex(s)]?.status === 'ok' ? 'ok' : 'fail'">
                    {{ stepCards[timelineStepIndex(s)]?.status === 'ok' ? '成功' : '失败' }} · {{ fmt(s.result.at) }}
                  </span>
                </div>
                <pre class="args">{{ argsPretty(s.argsJson ?? '') }}</pre>
                <pre v-if="s.result" class="result">{{ s.result.content.slice(0, 2000) }}</pre>
              </div>
            </div>
          </div>
        </template>
        <p v-else class="empty">← 选择左侧任务查看执行时间线</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* 深色极简主题：与工作台一致（13px/600 标题、elevated 卡片、6px 控件圆角） */
.page { color: var(--text); padding: 16px 24px 24px; max-width: 1100px; margin: 0 auto; height: 100%; flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; }
.head { display: flex; align-items: baseline; gap: 12px; }
h2 { margin: 0; font-size: 13px; font-weight: 600; }
.muted { color: var(--text-faint); font-size: 12px; }
.back { margin-left: auto; font-size: 12px; color: var(--text-dim); text-decoration: none; }
.back:hover { color: var(--text); text-decoration: underline; text-underline-offset: 3px; }
.export-row { display: inline-flex; gap: 6px; }
.export-btn { font-size: 12px; padding: 3px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-elevated); color: var(--text-dim); cursor: pointer; transition: background 0.12s ease-out, color 0.12s ease-out; }
.export-btn:disabled { opacity: .5; cursor: default; }
.export-btn:hover:not(:disabled) { background: var(--bg-elevated-2); color: var(--text); }
.error { color: var(--red); }
.layout { display: grid; grid-template-columns: 300px 1fr; gap: 16px; margin-top: 14px; flex: 1; min-height: 0; }
.runs { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 10px; overflow-y: auto; background: var(--bg-elevated); }
.runs h3 { margin: 0 0 8px; font-size: 12px; font-weight: 600; color: var(--text-dim); }
.run { position: relative; padding: 8px 10px; border-radius: var(--radius-sm); cursor: pointer; border: none; }
.run:hover { background: var(--bg-hover); }
.run.active { background: var(--bg-active); box-shadow: inset 2px 0 0 var(--accent); }
.run .preview { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run .meta { color: var(--text-faint); font-size: 12px; margin-top: 2px; }
/* F-46 分叉入口：默认隐藏，悬停任务条目时浮现（与工作台消息操作一致） */
.run-fork {
  margin-left: 6px; border: 1px solid var(--border); background: var(--bg-elevated-2); color: var(--text-faint);
  border-radius: 5px; font-size: 10.5px; padding: 0 6px; cursor: pointer; opacity: 0; transition: all 0.12s ease-out;
}
.run:hover .run-fork { opacity: 1; }
.run-fork:hover { color: var(--accent); border-color: var(--accent-border); background: var(--accent-soft); }
.timeline { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 12px 16px; overflow-y: auto; background: var(--bg-elevated); }
.tl-head { color: var(--text-dim); font-size: 13px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
.step { display: flex; gap: 10px; margin: 12px 0; }
.icon { width: 28px; text-align: center; }
.body { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; }
.when { width: 100%; color: var(--text-faint); font-size: 11px; display: flex; align-items: center; gap: 8px; }
/* 快捷复制：默认隐藏，悬停步骤时浮现（与工作台消息操作一致） */
.copy-row { margin-left: auto; display: flex; gap: 6px; }
.mini-copy {
  border: 1px solid var(--border); background: var(--bg-elevated-2); color: var(--text-faint);
  border-radius: 5px; font-size: 10.5px; padding: 0 6px; cursor: pointer; opacity: 0; transition: all 0.12s ease-out;
}
.step:hover .mini-copy { opacity: 1; }
.mini-copy:hover { color: var(--accent); border-color: var(--accent-border); background: var(--accent-soft); }
/* 用户消息右对齐气泡（与工作台消息区同语言），助手纯文本弱底 */
.text { border-radius: var(--radius-lg); padding: 8px 12px; margin-top: 2px; white-space: pre-wrap; font-size: 13px; max-width: 85%; }
.text.user { background: var(--bg-elevated-2); border: none; align-self: flex-end; }
.text.assistant { background: transparent; border: none; padding-left: 0; }
.toolcall { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 8px 10px; font-size: 13px; background: var(--bg); }
.call-head { display: flex; gap: 10px; align-items: center; }
.call-head code { font-family: var(--mono); color: var(--accent); }
.call-head .ok { color: var(--green); font-size: 12px; }
.call-head .fail { color: var(--red); font-size: 12px; }
.args, .result { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 8px; font-size: 12px; font-family: var(--mono); overflow-x: auto; max-height: 200px; overflow-y: auto; margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; color: var(--text-dim); }
.result { max-height: 300px; }
.empty { color: var(--text-faint); text-align: center; padding: 30px; font-size: 13px; }
</style>
