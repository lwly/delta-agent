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
              <div class="when">{{ fmt(s.at) }}</div>
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
.page { color: #1f2328; padding: 20px 28px; max-width: 1100px; margin: 0 auto; }
.head { display: flex; align-items: baseline; gap: 12px; }
h2 { margin: 0; font-size: 18px; }
.muted { color: #8b949e; font-size: 13px; }
.back { margin-left: auto; font-size: 13px; color: #0969da; text-decoration: none; }
.error { color: #cf222e; }
.layout { display: grid; grid-template-columns: 300px 1fr; gap: 16px; margin-top: 14px; }
.runs { border: 1px solid #d0d7de; border-radius: 8px; padding: 10px; max-height: 75vh; overflow-y: auto; }
.runs h3 { margin: 0 0 8px; font-size: 14px; }
.run { padding: 8px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
.run:hover { background: #f6f8fa; }
.run.active { background: #ddf4ff; border-color: #0969da; }
.run .preview { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.run .meta { color: #8b949e; font-size: 12px; margin-top: 2px; }
.timeline { border: 1px solid #d0d7de; border-radius: 8px; padding: 12px 16px; max-height: 75vh; overflow-y: auto; }
.tl-head { color: #57606a; font-size: 13px; border-bottom: 1px solid #d0d7de; padding-bottom: 8px; }
.step { display: flex; gap: 10px; margin: 12px 0; }
.icon { width: 28px; text-align: center; }
.body { flex: 1; min-width: 0; }
.when { color: #8b949e; font-size: 11px; }
.text { border-radius: 8px; padding: 8px 12px; margin-top: 2px; white-space: pre-wrap; font-size: 13px; }
.text.user { background: #1f883d; color: #fff; display: inline-block; }
.text.assistant { background: #f6f8fa; border: 1px solid #d0d7de; }
.toolcall { border: 1px solid #d0d7de; border-radius: 6px; padding: 8px 10px; font-size: 13px; background: #fff; }
.call-head { display: flex; gap: 10px; align-items: center; }
.call-head .ok { color: #1a7f37; font-size: 12px; }
.call-head .fail { color: #cf222e; font-size: 12px; }
.args, .result { background: #f6f8fa; border-radius: 4px; padding: 6px 8px; font-size: 12px; overflow-x: auto; max-height: 200px; overflow-y: auto; margin: 6px 0 0; }
.result { max-height: 300px; }
.empty { color: #8b949e; text-align: center; padding: 30px; }
</style>
