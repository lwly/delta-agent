<script setup lang="ts">
// F-18 会话回放：任务（run）列表 + 单次任务时间线（含工具调用与结果配对）
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { api, type RunStep, type RunSummary, type RunTimeline } from '../api/client';

const route = useRoute();
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

function stepIcon(s: RunStep): string {
  if (s.type === 'user') return '👤';
  if (s.type === 'assistant') return '🤖';
  return s.result ? (s.result.ok ? '🔧✔' : '🔧✘') : '🔧…';
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
                  <span v-if="s.result" :class="s.result.ok ? 'ok' : 'fail'">
                    {{ s.result.ok ? '成功' : '失败' }} · {{ fmt(s.result.at) }}
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
/* 深色主题：与工作台（prototype/index.html 设计系统）一致 */
.page { color: var(--text); padding: 20px 28px; max-width: 1100px; margin: 0 auto; height: 100vh; display: flex; flex-direction: column; overflow-y: auto; }
.head { display: flex; align-items: baseline; gap: 12px; }
h2 { margin: 0; font-size: 18px; }
.muted { color: var(--text-faint); font-size: 13px; }
.back { margin-left: auto; font-size: 13px; color: var(--accent); text-decoration: none; }
.back:hover { text-decoration: underline; }
.error { color: var(--red); }
.layout { display: grid; grid-template-columns: 300px 1fr; gap: 16px; margin-top: 14px; flex: 1; min-height: 0; }
.runs { border: 1px solid var(--border); border-radius: 10px; padding: 10px; overflow-y: auto; background: var(--bg-panel); }
.runs h3 { margin: 0 0 8px; font-size: 14px; }
.run { padding: 8px; border-radius: 7px; cursor: pointer; border: 1px solid transparent; }
.run:hover { background: var(--bg-hover); }
.run.active { background: var(--accent-soft); border-color: rgba(88, 166, 255, 0.4); }
.run .preview { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run .meta { color: var(--text-faint); font-size: 12px; margin-top: 2px; }
.timeline { border: 1px solid var(--border); border-radius: 10px; padding: 12px 16px; overflow-y: auto; background: var(--bg-panel); }
.tl-head { color: var(--text-dim); font-size: 13px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
.step { display: flex; gap: 10px; margin: 12px 0; }
.icon { width: 28px; text-align: center; }
.body { flex: 1; min-width: 0; }
.when { color: var(--text-faint); font-size: 11px; display: flex; align-items: center; gap: 8px; }
/* 快捷复制：默认隐藏，悬停步骤时浮现（与工作台消息操作一致） */
.copy-row { margin-left: auto; display: flex; gap: 6px; }
.mini-copy {
  border: 1px solid var(--border); background: var(--bg-elevated); color: var(--text-faint);
  border-radius: 5px; font-size: 10.5px; padding: 0 6px; cursor: pointer; opacity: 0; transition: all 0.12s;
}
.step:hover .mini-copy { opacity: 1; }
.mini-copy:hover { color: var(--accent); border-color: rgba(88, 166, 255, 0.4); background: var(--accent-soft); }
.text { border-radius: 10px; padding: 8px 12px; margin-top: 2px; white-space: pre-wrap; font-size: 13px; }
.text.user { background: var(--accent-soft); border: 1px solid rgba(88, 166, 255, 0.25); display: inline-block; }
.text.assistant { background: var(--bg-elevated); border: 1px solid var(--border); }
.toolcall { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 13px; background: var(--bg-elevated); }
.call-head { display: flex; gap: 10px; align-items: center; }
.call-head code { font-family: var(--mono); color: var(--accent); }
.call-head .ok { color: var(--green); font-size: 12px; }
.call-head .fail { color: var(--red); font-size: 12px; }
.args, .result { background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 12px; font-family: var(--mono); overflow-x: auto; max-height: 200px; overflow-y: auto; margin: 6px 0 0; white-space: pre-wrap; word-break: break-word; color: var(--text-dim); }
.result { max-height: 300px; }
.empty { color: var(--text-faint); text-align: center; padding: 30px; }
</style>
