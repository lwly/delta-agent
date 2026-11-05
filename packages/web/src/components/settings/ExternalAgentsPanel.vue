<script setup lang="ts">
// 设置页·外部 Agent 面板（F-55，设计稿 §10/§5.2）：探测到的外部 CLI Agent 只读展示——
// 版本/来源/登录态 + plan/yolo 档支持度。不提供安装/卸载（delta 只探测不安装，§10/§16）。
// AC-55-7：拉取失败静默显示空态文案，不弹错误。
import { onMounted, ref } from 'vue';
import { api, type ExternalAgentInfo } from '../../api/client';

const loading = ref(false);
const agents = ref<ExternalAgentInfo[]>([]);
/** 探测时间为挂载时刻的快照（本面板只读，无刷新编辑态，重新进入 tab 即重挂载） */
const probedAt = ref('');

/** 环境变量提示（空态用）：id `cli:claude-code` → DELTA_EXTERNAL_CLAUDE_CODE_PATH */
function envPathName(id: string): string {
  const bare = id.replace(/^[a-z]+:/i, '');
  return `DELTA_EXTERNAL_${bare.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PATH`;
}

async function load() {
  loading.value = true;
  try {
    const res = await api.externalAgents();
    agents.value = res.agents;
    probedAt.value = new Date().toLocaleTimeString();
  } catch {
    // 拉取失败静默空态（AC-55-7：降级是显式提示不是报错）
    agents.value = [];
    probedAt.value = '';
  } finally {
    loading.value = false;
  }
}
onMounted(load);

function sourceLabel(s: ExternalAgentInfo['source']): string {
  return s === 'env' ? '环境变量' : s === 'cache' ? '缓存' : 'PATH';
}
</script>

<template>
  <section class="panel">
    <header class="panel-head">
      <div>
        <h2 class="panel-title">外部 Agent</h2>
        <p class="panel-sub">
          探测本机已安装的外部 CLI Agent（<code>claude</code> / <code>codex</code>）。delta 只探测不安装，
          新建会话时可在模型选择器中以 <code>cli:</code> 前缀选用。
        </p>
      </div>
      <div class="head-ops">
        <button class="btn" :disabled="loading" @click="load">↻ 重新探测</button>
      </div>
    </header>

    <!-- agent 卡片列表 -->
    <div class="rows">
      <div v-for="a in agents" :key="a.id" class="row">
        <div class="row-main">
          <code class="agent-id mono">{{ a.id }}</code>
          <span class="agent-cmd mono" :title="a.command">{{ a.command }}</span>
          <span class="agent-ver">{{ a.version }}</span>
          <span class="tag tier" :title="a.tier === 'B' ? 'Tier B：stream-json 协议' : 'Tier C：app-server 协议'">Tier {{ a.tier }}</span>
          <span class="tag src" :title="`来源：${a.command}`">{{ sourceLabel(a.source) }}</span>
        </div>
        <div class="row-caps">
          <span class="cap" :class="{ ok: a.loginState, miss: !a.loginState }">
            登录态 {{ a.loginState ? '✓' : '✗' }}
          </span>
          <span class="cap" :class="{ ok: a.planSupported, miss: !a.planSupported }" title="plan 只读档：上游 CLI 是否有只读计划模式">
            plan 档 {{ a.planSupported ? '✓' : '✗' }}
          </span>
          <span class="cap" :class="{ ok: a.yoloSupported, miss: !a.yoloSupported }" title="yolo 档：上游 CLI 是否有跳过全部确认的执行档">
            yolo 档 {{ a.yoloSupported ? '✓' : '✗' }}
          </span>
        </div>
        <p v-if="!a.loginState" class="login-hint">未检测到登录态：请运行对应 CLI 完成登录（delta 只探测不代登录）</p>
      </div>
      <div v-if="agents.length === 0 && !loading" class="empty-wrap">
        <p class="empty">未探测到外部 Agent——delta 只探测不安装。</p>
        <p class="empty-sub">
          如已安装但未探测到，可设置显式路径环境变量：
          <code class="mono">{{ envPathName('cli:claude-code') }}</code> /
          <code class="mono">{{ envPathName('cli:codex') }}</code>
        </p>
      </div>
    </div>

    <!-- 能力降级固定说明（设计稿 §5.2/§10）：显式声明，不弹错误 -->
    <p class="foot-note">
      ⚠ 外部会话不使用 delta 沙箱；内置 Function 不可注入；无上下文压缩与记忆蒸馏；订阅内调用不计费（<code>usage.billing=subscription</code>）。
    </p>
    <p v-if="agents.length > 0" class="probe-meta">探测时间：{{ probedAt }}</p>
  </section>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; gap: 12px; }
.panel-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.panel-title { font-size: 15px; font-weight: 600; }
.panel-sub { font-size: 12px; color: var(--text-dim); margin-top: 4px; line-height: 1.6; }
.panel-sub code { font-family: var(--mono); color: var(--accent); }
.head-ops { display: flex; gap: 8px; flex-shrink: 0; }

.rows { display: flex; flex-direction: column; gap: 10px; }
.row {
  border: 1px solid var(--border); border-radius: 10px;
  background: var(--bg-elevated); padding: 12px 14px;
  display: flex; flex-direction: column; gap: 8px;
}
.row:hover { border-color: var(--border-strong); }
.row-main { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.agent-id { font-size: 12.5px; color: var(--accent); }
.agent-cmd { font-size: 11.5px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 320px; }
.agent-ver { font-size: 12px; color: var(--text); }
.tag { font-size: 9.5px; font-family: var(--mono); padding: 1px 6px; border-radius: 4px; }
.tag.tier { background: var(--accent-soft); color: var(--accent); }
.tag.src { background: var(--bg-hover); color: var(--text-dim); }

.row-caps { display: flex; gap: 14px; flex-wrap: wrap; }
.cap { font-size: 12px; color: var(--text-dim); }
.cap.ok { color: var(--green); }
.cap.miss { color: var(--orange); }

.login-hint { font-size: 11.5px; color: var(--orange); line-height: 1.6; }

.empty-wrap { text-align: center; padding: 24px 0; }
.empty { color: var(--text-faint); font-size: 12.5px; }
.empty-sub { color: var(--text-faint); font-size: 11.5px; margin-top: 6px; line-height: 1.7; }
.empty-sub code { font-family: var(--mono); color: var(--text-dim); }

.foot-note { font-size: 11.5px; color: var(--text-dim); line-height: 1.7; border-top: 1px dashed var(--border); padding-top: 10px; }
.foot-note code { font-family: var(--mono); color: var(--text-dim); }
.probe-meta { font-size: 10.5px; color: var(--text-faint); }
.mono { font-family: var(--mono); }
</style>
