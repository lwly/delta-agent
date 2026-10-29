<script setup lang="ts">
// F-47 Web 内置终端：xterm.js 前端 + /ws/terminal WebSocket。
// 职责：连接管理（创建 pty → WS 接入 → 断线重连回放）、输入输出转发、尺寸自适应；
// 警示条常驻：终端是用户本人操作，直接执行命令，不经 Agent 确认流/沙箱。
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api, terminalWsUrl } from '../api/client';
import '@xterm/xterm/css/xterm.css';

const props = defineProps<{ sessionId: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const state = ref<'connecting' | 'ready' | 'unavailable' | 'exited'>('connecting');
const reason = ref('');
const workRoot = ref('');
const shellLabel = ref('');

const hostEl = ref<HTMLDivElement | null>(null);
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let ws: WebSocket | null = null;
let terminalId = '';
let resizeObserver: ResizeObserver | null = null;
let disposed = false;

function fitAndReport() {
  if (!term || !fit) return;
  try {
    fit.fit();
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  } catch {
    // 容器不可见时 fit 可能抛错：忽略，下次布局再试
  }
}

function wireSocket(id: string) {
  ws = new WebSocket(terminalWsUrl(id));
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as { type: string; data?: string; work_root?: string; shell?: string; message?: string; exitCode?: number };
      if (msg.type === 'ready') {
        state.value = 'ready';
        workRoot.value = msg.work_root ?? '';
        shellLabel.value = msg.shell ?? '';
        fitAndReport();
      } else if (msg.type === 'output') {
        term?.write(msg.data ?? '');
      } else if (msg.type === 'exit') {
        state.value = 'exited';
        term?.write(`\r\n\x1b[2m[终端已退出，exitCode=${msg.exitCode ?? 0}]\x1b[0m\r\n`);
      } else if (msg.type === 'error') {
        reason.value = msg.message ?? '';
      }
    } catch {
      // 非 JSON 帧：忽略
    }
  };
  ws.onclose = () => {
    if (disposed || state.value === 'exited') return;
    // 断线重连：pty 仍在服务端（环形缓冲回放），短暂退避后重接
    setTimeout(() => {
      if (!disposed && terminalId && state.value !== 'exited') wireSocket(terminalId);
    }, 1_000);
  };
}

async function boot() {
  // 能力探测：未装配 / node-pty 缺失 → 明确降级提示（替代方案：系统文件管理器）
  try {
    const st = await api.terminalStatus();
    if (!st.available) {
      state.value = 'unavailable';
      reason.value = st.reason ?? '终端能力不可用';
      return;
    }
  } catch (e) {
    state.value = 'unavailable';
    reason.value = (e as Error).message;
    return;
  }
  try {
    const created = await api.createTerminal(props.sessionId);
    if (!created.ok || !created.terminal_id) {
      state.value = 'unavailable';
      reason.value = created.error ?? '终端创建失败';
      return;
    }
    terminalId = created.terminal_id;
  } catch (e) {
    state.value = 'unavailable';
    reason.value = (e as Error).message;
    return;
  }
  term = new Terminal({
    fontSize: 12,
    cursorBlink: true,
    convertEol: false,
    theme: { background: '#11151c' },
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.onData((d) => {
    ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'input', data: d }));
  });
  if (hostEl.value) term.open(hostEl.value);
  resizeObserver = new ResizeObserver(() => fitAndReport());
  if (hostEl.value) resizeObserver.observe(hostEl.value);
  wireSocket(terminalId);
  fitAndReport();
}

async function closePane() {
  disposed = true;
  if (terminalId) {
    ws?.close();
    try {
      await api.closeTerminal(terminalId);
    } catch {
      // 已被服务端回收：忽略
    }
  }
  emit('close');
}

onMounted(boot);
onBeforeUnmount(() => {
  disposed = true;
  ws?.close();
  resizeObserver?.disconnect();
  term?.dispose();
});
</script>

<template>
  <section class="term-pane">
    <div class="term-head">
      <span class="term-title">🖥 终端</span>
      <span v-if="workRoot" class="term-root" :title="workRoot">{{ workRoot }}</span>
      <span v-if="shellLabel" class="term-shell">{{ shellLabel }}</span>
      <span class="term-warn">⚠ 直接执行，不经 Agent 确认/沙箱</span>
      <span class="spacer" />
      <button v-if="state === 'exited'" class="term-btn" @click="boot">重开</button>
      <button class="term-btn" title="关闭终端" @click="closePane">✕</button>
    </div>
    <div v-if="state === 'unavailable'" class="term-fallback">
      <p>✘ 内嵌终端不可用：{{ reason }}</p>
      <p class="dim">替代方案：文件面板「📂 打开浏览器」在系统文件管理器中打开工作根。</p>
    </div>
    <div v-else ref="hostEl" class="term-host" />
  </section>
</template>

<style scoped>
.term-pane {
  display: flex; flex-direction: column; min-height: 0;
  height: 300px; flex: none;
  /* xterm canvas 有固定像素内在宽度，会反向撑宽内容自适应的 .right-col（右侧空白条）：
     inline-size 封隔使其不参与列宽计算，宽度跟随文件面板列 */
  min-width: 0; contain: inline-size;
  border-top: 1px solid var(--border); background: #11151c;
}
.term-head {
  display: flex; align-items: center; gap: 10px;
  padding: 5px 12px; font-size: 11.5px; color: var(--text-dim);
  background: var(--bg-panel); border-bottom: 1px solid var(--border);
}
.term-title { font-weight: 600; color: var(--text); }
.term-root { font-family: var(--mono); font-size: 11px; max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.term-shell { color: var(--text-faint); }
.term-warn { color: var(--orange); font-size: 10.5px; }
.spacer { flex: 1; }
.term-btn {
  padding: 2px 9px; border-radius: 6px; border: 1px solid var(--border);
  background: transparent; color: var(--text-dim); font-size: 11.5px; cursor: pointer;
}
.term-btn:hover { background: var(--bg-hover); color: var(--text); }
.term-fallback { padding: 18px; font-size: 12.5px; color: var(--text-dim); }
.term-fallback .dim { color: var(--text-faint); margin-top: 6px; }
.term-host { flex: 1; min-height: 0; min-width: 0; padding: 4px 8px; overflow: hidden; }
</style>
